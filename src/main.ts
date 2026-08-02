import './style.css'
import { Input, BlobSource, ALL_FORMATS, VideoSampleSink } from 'mediabunny'
import type { InputVideoTrack, VideoSample } from 'mediabunny'

// ──────────────────────────────────────────────
// DOM scaffold
// ──────────────────────────────────────────────

document.querySelector('#app')!.innerHTML = `
  <main class="layout">
    <h1>Seamless Loop Video Player</h1>
    <p class="hint">Choose a local MP4 to loop seamlessly via WebCodecs and Mediabunny.</p>

    <section class="controls">
      <label class="file-input">
        <span>Select video file</span>
        <input id="fileInput" type="file" accept="video/*" />
      </label>
      <button id="pickerButton" type="button">Pick &amp; remember (where supported)</button>
      <button id="fullscreenButton" type="button">Fullscreen</button>
    </section>

    <div id="playerContainer">
      <canvas id="player"></canvas>
    </div>

    <section class="status" aria-live="polite">
      <p><strong>Loaded:</strong> <span id="fileName">None</span></p>
      <p><strong>Loop boundary gap:</strong> <span id="loopGap">Waiting…</span></p>
      <p><strong>Status:</strong> <span id="statusText">Idle</span></p>
    </section>

    <section class="diagnostics" aria-label="Playback diagnostics">
      <div class="diagnostics-heading">
        <h2>Frame-rate monitor</h2>
        <span>updates every 500 ms</span>
      </div>
      <div class="metric-grid">
        <div class="metric"><span>Render FPS</span><strong id="renderFps">—</strong><small>requestAnimationFrame</small></div>
        <div class="metric"><span>Displayed FPS</span><strong id="displayedFps">—</strong><small>new video samples</small></div>
        <div class="metric"><span>Frame time</span><strong id="frameTime">—</strong><small>median render interval</small></div>
        <div class="metric"><span>Long frames</span><strong id="longFrames">—</strong><small>rAF gap &gt; 1.5× median</small></div>
        <div class="metric"><span>Decode-ahead</span><strong id="bufferAhead">—</strong><small>seconds queued</small></div>
      </div>
    </section>
  </main>
`

const fileInput = document.querySelector<HTMLInputElement>('#fileInput')!
const pickerButton = document.querySelector<HTMLButtonElement>('#pickerButton')!
const fullscreenButton = document.querySelector<HTMLButtonElement>('#fullscreenButton')!
const playerContainer = document.querySelector<HTMLDivElement>('#playerContainer')!
const canvas = document.querySelector<HTMLCanvasElement>('#player')!
const fileNameEl = document.querySelector<HTMLElement>('#fileName')!
const loopGapEl = document.querySelector<HTMLElement>('#loopGap')!
const statusEl = document.querySelector<HTMLElement>('#statusText')!
const renderFpsEl = document.querySelector<HTMLElement>('#renderFps')!
const displayedFpsEl = document.querySelector<HTMLElement>('#displayedFps')!
const frameTimeEl = document.querySelector<HTMLElement>('#frameTime')!
const longFramesEl = document.querySelector<HTMLElement>('#longFrames')!
const bufferAheadEl = document.querySelector<HTMLElement>('#bufferAhead')!

// ──────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────

function setStatus(msg: string) {
  statusEl.textContent = msg
}

function setFileName(file: File | null) {
  fileNameEl.textContent = file
    ? `${file.name} (${Math.round(file.size / 1024)} KB)`
    : 'None'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

type FrameRateSnapshot = {
  renderFps: number | null
  displayedFps: number | null
  medianFrameTimeMs: number | null
  longFrames: number | null
  bufferAheadSec: number | null
}

/** Low-overhead rolling diagnostics for the canvas render loop. */
class FrameRateMonitor {
  private readonly windowMs = 2000
  private renderTimestamps: number[] = []
  private displayedTimestamps: number[] = []
  private frameIntervals: Array<{ timestamp: number; interval: number }> = []
  private lastRenderTimestamp: number | null = null
  private bufferAheadSec: number | null = null

  reset(): void {
    this.renderTimestamps = []
    this.displayedTimestamps = []
    this.frameIntervals = []
    this.lastRenderTimestamp = null
    this.bufferAheadSec = null
  }

  record(timestamp: number, displayedNewFrame: boolean, bufferAheadSec: number): void {
    this.renderTimestamps.push(timestamp)
    if (displayedNewFrame) this.displayedTimestamps.push(timestamp)

    if (this.lastRenderTimestamp !== null) {
      this.frameIntervals.push({
        timestamp,
        interval: timestamp - this.lastRenderTimestamp,
      })
    }
    this.lastRenderTimestamp = timestamp
    this.bufferAheadSec = bufferAheadSec

    const cutoff = timestamp - this.windowMs
    while (this.renderTimestamps[0] < cutoff) this.renderTimestamps.shift()
    while (this.displayedTimestamps[0] < cutoff) this.displayedTimestamps.shift()
    while (this.frameIntervals.length > 0 && this.frameIntervals[0].timestamp < cutoff) {
      this.frameIntervals.shift()
    }
  }

  snapshot(): FrameRateSnapshot {
    const renderFps = this.rate(this.renderTimestamps)
    const displayedFps = this.rate(this.displayedTimestamps)
    const intervals = this.frameIntervals.map(entry => entry.interval)
    const medianFrameTimeMs = this.median(intervals)
    const longFrames = medianFrameTimeMs === null
      ? null
      : intervals.filter(interval => interval > medianFrameTimeMs * 1.5).length

    return {
      renderFps,
      displayedFps,
      medianFrameTimeMs,
      longFrames,
      bufferAheadSec: this.bufferAheadSec,
    }
  }

  private rate(timestamps: number[]): number | null {
    if (timestamps.length < 2) return null
    const elapsedMs = timestamps[timestamps.length - 1] - timestamps[0]
    return elapsedMs > 0 ? ((timestamps.length - 1) * 1000) / elapsedMs : null
  }

  private median(values: number[]): number | null {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle]
  }
}

// ──────────────────────────────────────────────
// IndexedDB helpers (persist file handle)
// ──────────────────────────────────────────────

const DB_NAME = 'loop-player-db'
const STORE_NAME = 'settings'
const HANDLE_KEY = 'last-file-handle'

function openDb(): Promise<IDBDatabase | null> {
  if (!('indexedDB' in window)) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function dbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function dbGet(key: string): Promise<unknown> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

// ──────────────────────────────────────────────
// Wake Lock
// ──────────────────────────────────────────────

let wakeLock: WakeLockSentinel | null = null

async function requestWakeLock(): Promise<void> {
  if (!('wakeLock' in navigator) || wakeLock) return
  try {
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', () => {
      wakeLock = null
    })
  } catch {
    // Wake lock unavailable on this device – silently skip
  }
}

async function releaseWakeLock(): Promise<void> {
  if (!wakeLock) return
  await wakeLock.release()
  wakeLock = null
}

// ──────────────────────────────────────────────
// WebGL renderer
// ──────────────────────────────────────────────

class WebGLRenderer {
  private readonly gl: WebGLRenderingContext
  private readonly program: WebGLProgram
  private readonly buffer: WebGLBuffer
  private readonly texture: WebGLTexture
  private readonly positionLocation: number
  private readonly texCoordLocation: number

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly videoWidth: number,
    private readonly videoHeight: number,
  ) {
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('WebGL is not available in this browser.')
    this.gl = gl

    const vertexShader = this.createShader(gl.VERTEX_SHADER, `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;

      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `)
    const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform sampler2D u_texture;
      varying vec2 v_texCoord;

      void main() {
        gl_FragColor = texture2D(u_texture, v_texCoord);
      }
    `)

    const program = gl.createProgram()
    if (!program) throw new Error('Could not create the WebGL program.')
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Could not link the WebGL program: ${gl.getProgramInfoLog(program) ?? 'unknown error'}`)
    }
    gl.deleteShader(vertexShader)
    gl.deleteShader(fragmentShader)
    this.program = program

    const buffer = gl.createBuffer()
    const texture = gl.createTexture()
    if (!buffer || !texture) throw new Error('Could not create WebGL rendering resources.')
    this.buffer = buffer
    this.texture = texture

    this.positionLocation = gl.getAttribLocation(program, 'a_position')
    this.texCoordLocation = gl.getAttribLocation(program, 'a_texCoord')
    if (this.positionLocation < 0 || this.texCoordLocation < 0) {
      throw new Error('Could not find WebGL shader attributes.')
    }

    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.enableVertexAttribArray(this.positionLocation)
    gl.enableVertexAttribArray(this.texCoordLocation)
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(this.texCoordLocation, 2, gl.FLOAT, false, 16, 8)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 1)
  }

  render(sample: VideoSample, uploadSample: boolean): void {
    const gl = this.gl
    gl.useProgram(this.program)

    if (uploadSample) {
      const frame = sample.toVideoFrame()
      try {
        gl.bindTexture(gl.TEXTURE_2D, this.texture)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          frame as unknown as TexImageSource,
        )
      } finally {
        frame.close()
      }
    }

    const vAspect = this.videoWidth / this.videoHeight
    const cAspect = this.canvas.width / this.canvas.height
    let dx = 0, dy = 0, dw = this.canvas.width, dh = this.canvas.height
    if (cAspect > vAspect) {
      dw = this.canvas.height * vAspect
      dx = (this.canvas.width - dw) / 2
    } else {
      dh = this.canvas.width / vAspect
      dy = (this.canvas.height - dh) / 2
    }

    const left = (dx / this.canvas.width) * 2 - 1
    const right = ((dx + dw) / this.canvas.width) * 2 - 1
    const top = 1 - (dy / this.canvas.height) * 2
    const bottom = 1 - ((dy + dh) / this.canvas.height) * 2
    const textureCoordinates = this.textureCoordinates(sample.rotation)
    const vertices = new Float32Array([
      left, bottom, textureCoordinates[0], textureCoordinates[1],
      right, bottom, textureCoordinates[2], textureCoordinates[3],
      left, top, textureCoordinates[4], textureCoordinates[5],
      right, top, textureCoordinates[6], textureCoordinates[7],
    ])

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture)
    this.gl.deleteBuffer(this.buffer)
    this.gl.deleteProgram(this.program)
  }

  private textureCoordinates(rotation: VideoSample['rotation']): number[] {
    switch (rotation) {
      case 90:
        return [1, 0, 1, 1, 0, 0, 0, 1]
      case 180:
        return [1, 1, 0, 1, 1, 0, 0, 0]
      case 270:
        return [0, 1, 0, 0, 1, 1, 1, 0]
      default:
        return [0, 0, 1, 0, 0, 1, 1, 1]
    }
  }

  private createShader(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type)
    if (!shader) throw new Error('Could not create a WebGL shader.')
    this.gl.shaderSource(shader, source)
    this.gl.compileShader(shader)
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const log = this.gl.getShaderInfoLog(shader) ?? 'unknown error'
      this.gl.deleteShader(shader)
      throw new Error(`Could not compile the WebGL shader: ${log}`)
    }
    return shader
  }
}

// SeamlessLoopPlayer
// ──────────────────────────────────────────────
//
// Architecture – dual VideoSampleSink producer pipeline:
//
//   File → BlobSource → Input → InputVideoTrack
//                                    │
//                           ┌────────┴────────┐
//                   VideoSampleSink A    VideoSampleSink B
//                   (current loop)       (next loop, pre-warm)
//                           │                  │
//                           └────────┬─────────┘
//                               sorted queue
//                             (monotonic time)
//                                    │
//                                 Canvas
//
// Producer A iterates frames with playbackTime = loopOffset + sample.timestamp.
// When A is PREFETCH_SEC from the end it spawns Producer B at
// loopOffset + duration.  B pre-decodes the start of the next loop so the
// first frame is ready the moment the renderer crosses the loop boundary.
// Back-pressure keeps memory usage bounded to at most MAX_AHEAD_SEC of frames.
// ──────────────────────────────────────────────

const PREFETCH_SEC = 3.0   // start next-loop decode this many seconds before end
const MAX_AHEAD_SEC = 6.0  // max seconds of decoded frames to keep in memory
const FULL_LOOP_MAX_DURATION_SEC = 12
const FULL_LOOP_MEMORY_BUDGET_BYTES = 256 * 1024 * 1024

class SeamlessLoopPlayer {
  private readonly videoTrack: InputVideoTrack
  private readonly duration: number
  private readonly videoWidth: number
  private readonly videoHeight: number
  private readonly canvas: HTMLCanvasElement
  private readonly renderer: WebGLRenderer

  /** Shared, time-ordered queue of decoded frames. */
  private queue: Array<{ sample: VideoSample; playbackTime: number }> = []
  /** Reused decoded frames for short loops that fit the memory budget. */
  private fullLoopSamples: VideoSample[] | null = null

  private playing = false
  private visibilityPaused = false
  private producerGeneration = 0
  /** performance.now() timestamp when playback started. */
  private startTime = 0
  private rafId = 0
  private readonly frameRateMonitor = new FrameRateMonitor()
  private lastDrawnSample: VideoSample | null = null

  /** Loop-boundary gap measurement (ms). Negative = early, positive = late. */
  loopGapMs: number | null = null
  private lastRenderedLoopIndex = -1

  constructor(
    videoTrack: InputVideoTrack,
    duration: number,
    videoWidth: number,
    videoHeight: number,
    canvas: HTMLCanvasElement,
  ) {
    this.videoTrack = videoTrack
    this.duration = duration
    this.videoWidth = videoWidth
    this.videoHeight = videoHeight
    this.canvas = canvas
    this.renderer = new WebGLRenderer(canvas, videoWidth, videoHeight)
  }

  async start(): Promise<void> {
    this.playing = true
    this.visibilityPaused = false
    const generation = ++this.producerGeneration
    this.startTime = performance.now()
    this.lastRenderedLoopIndex = -1
    this.loopGapMs = null
    this.lastDrawnSample = null
    this.frameRateMonitor.reset()

    // Short loops are decoded once and reused, avoiding decoder churn at every
    // boundary. Larger loops use the streaming producer pipeline.
    const buffered = await this.tryPredecodeLoop()
    if (!this.playing) return
    if (!buffered) void this.startProducer(0, 0, generation)

    this.rafId = requestAnimationFrame(this.render)
  }

  stop(): void {
    this.playing = false
    this.visibilityPaused = false
    this.producerGeneration += 1
    cancelAnimationFrame(this.rafId)

    this.clearStreamingQueue()
    for (const sample of this.fullLoopSamples ?? []) sample.close()
    this.fullLoopSamples = null
    this.lastDrawnSample = null
    this.renderer.dispose()
    this.frameRateMonitor.reset()
  }

  pauseForVisibility(): void {
    if (!this.playing || this.visibilityPaused) return
    this.visibilityPaused = true
    cancelAnimationFrame(this.rafId)
  }

  resumeFromVisibility(): void {
    if (!this.playing || !this.visibilityPaused) return

    this.visibilityPaused = false
    const generation = ++this.producerGeneration
    this.clearStreamingQueue()
    this.lastDrawnSample = null
    this.lastRenderedLoopIndex = Math.floor(this.now / this.duration)
    this.frameRateMonitor.reset()

    if (!this.fullLoopSamples) {
      const currentTime = this.now
      const loopIndex = Math.floor(currentTime / this.duration)
      const loopOffset = loopIndex * this.duration
      void this.startProducer(
        loopOffset,
        currentTime - loopOffset,
        generation,
      )
    }

    this.rafId = requestAnimationFrame(this.render)
  }

  get isFullyBuffered(): boolean {
    return this.fullLoopSamples !== null
  }

  getFrameRateSnapshot(): FrameRateSnapshot {
    return this.frameRateMonitor.snapshot()
  }

  // ── Private helpers ──────────────────────────

  /** Monotonic playback clock in seconds. */
  private get now(): number {
    return (performance.now() - this.startTime) / 1000
  }

  /**
   * Async producer: decodes every frame in the video and appends it to the
   * shared queue with `playbackTime = loopOffset + frame.timestamp`.
   *
   * PREFETCH_SEC before reaching the end of the video it spawns a new producer
   * for `loopOffset + duration`, pre-warming the next loop's decoder so its
   * first frame is ready exactly when the loop boundary is crossed.
   */
  private async startProducer(
    loopOffset: number,
    startTimestamp: number,
    generation: number,
  ): Promise<void> {
    const sink = new VideoSampleSink(this.videoTrack)
    let prefetchStarted = false

    try {
      for await (const sample of sink.samples(startTimestamp)) {
        if (!this.isProducerActive(generation)) {
          sample.close()
          return
        }

        const pt = loopOffset + sample.timestamp
        this.insertIntoQueue({ sample, playbackTime: pt })

        // Pre-warm the next loop's decoder pipeline
        if (!prefetchStarted && sample.timestamp >= this.duration - PREFETCH_SEC) {
          prefetchStarted = true
          void this.startProducer(loopOffset + this.duration, 0, generation)
        }

        // Back-pressure: don't decode further than MAX_AHEAD_SEC ahead
        while (this.isProducerActive(generation) && pt > this.now + MAX_AHEAD_SEC) {
          await sleep(10)
        }
        if (!this.isProducerActive(generation)) return
      }
    } catch {
      // Input disposed or video ended unexpectedly – exit cleanly
    }
  }

  /** rAF callback: displays the frame whose playbackTime is closest to now. */
  private render = (timestamp: number): void => {
    if (!this.playing) return

    const t = this.now

    // Find the latest frame with playbackTime ≤ t.
    // The queue is explicitly timestamp ordered because the producers overlap.
    let bestIdx = -1
    let sampleToRender: VideoSample | null = null
    let playbackTime = 0

    if (this.fullLoopSamples) {
      const fullLoopFrame = this.frameFromFullLoop(t)
      if (fullLoopFrame) {
        sampleToRender = fullLoopFrame.sample
        playbackTime = fullLoopFrame.playbackTime
      }
    } else {
      // The queue is timestamp ordered even while the two producers overlap.
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].playbackTime <= t) bestIdx = i
        else break
      }
      if (bestIdx >= 0) {
        sampleToRender = this.queue[bestIdx].sample
        playbackTime = this.queue[bestIdx].playbackTime
      }
    }

    let displayedNewFrame = false
    if (sampleToRender) {
      displayedNewFrame = sampleToRender !== this.lastDrawnSample
      this.lastDrawnSample = sampleToRender

      // Detect and measure loop-boundary crossings
      const loopIdx = Math.floor(playbackTime / this.duration)
      if (loopIdx > this.lastRenderedLoopIndex && this.lastRenderedLoopIndex >= 0) {
        const expectedMs = this.startTime + loopIdx * this.duration * 1000
        this.loopGapMs = performance.now() - expectedMs
      }
      this.lastRenderedLoopIndex = Math.max(this.lastRenderedLoopIndex, loopIdx)

      this.renderer.render(sampleToRender, displayedNewFrame)

      // Release frames we've advanced past to free GPU memory
      if (bestIdx > 0) {
        for (let i = 0; i < bestIdx; i++) {
          this.queue[i].sample.close()
        }
        this.queue.splice(0, bestIdx)
      }
    }

    const lastQueuedFrame = this.queue[this.queue.length - 1]
    const bufferAheadSec = this.fullLoopSamples
      ? this.duration
      : lastQueuedFrame
      ? Math.max(0, lastQueuedFrame.playbackTime - t)
      : 0
    this.frameRateMonitor.record(timestamp, displayedNewFrame, bufferAheadSec)

    this.rafId = requestAnimationFrame(this.render)
  }

  private frameFromFullLoop(t: number): { sample: VideoSample; playbackTime: number } | null {
    const samples = this.fullLoopSamples
    if (!samples || samples.length === 0) return null

    let loopIndex = Math.floor(t / this.duration)
    const localTime = t - loopIndex * this.duration
    let low = 0
    let high = samples.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (samples[middle].timestamp <= localTime) low = middle + 1
      else high = middle
    }

    let sampleIndex = low - 1
    if (sampleIndex < 0) {
      sampleIndex = samples.length - 1
      loopIndex -= 1
    }

    const sample = samples[sampleIndex]
    return {
      sample,
      playbackTime: loopIndex * this.duration + sample.timestamp,
    }
  }

  private isProducerActive(generation: number): boolean {
    return this.playing
      && !this.visibilityPaused
      && generation === this.producerGeneration
  }

  private clearStreamingQueue(): void {
    for (const { sample } of this.queue) sample.close()
    this.queue = []
  }

  /**
   * Decode a short loop once when its actual decoded samples fit the memory
   * budget. If it does not fit, release the temporary samples and stream it.
   */
  private async tryPredecodeLoop(): Promise<boolean> {
    if (this.duration > FULL_LOOP_MAX_DURATION_SEC) return false

    const sink = new VideoSampleSink(this.videoTrack)
    const samples: VideoSample[] = []
    let bytes = 0

    try {
      for await (const sample of sink.samples()) {
        if (!this.playing) {
          sample.close()
          for (const queuedSample of samples) queuedSample.close()
          return false
        }

        const sampleBytes = this.sampleAllocationSize(sample)
        bytes += sampleBytes
        if (bytes > FULL_LOOP_MEMORY_BUDGET_BYTES) {
          sample.close()
          for (const queuedSample of samples) queuedSample.close()
          return false
        }

        if (sample.timestamp >= 0 && sample.timestamp < this.duration) {
          samples.push(sample)
        } else {
          sample.close()
        }
      }

      if (samples.length === 0) return false
      this.fullLoopSamples = samples
      return true
    } catch {
      for (const sample of samples) sample.close()
      return false
    }
  }

  private sampleAllocationSize(sample: VideoSample): number {
    try {
      return sample.allocationSize()
    } catch {
      return this.videoWidth * this.videoHeight * 4
    }
  }

  /** Insert by timestamp because the two asynchronous producers can finish out of order. */
  private insertIntoQueue(entry: { sample: VideoSample; playbackTime: number }): void {
    let low = 0
    let high = this.queue.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.queue[middle].playbackTime <= entry.playbackTime) low = middle + 1
      else high = middle
    }
    this.queue.splice(low, 0, entry)
  }

}

// ──────────────────────────────────────────────
// Application state
// ──────────────────────────────────────────────

let currentPlayer: SeamlessLoopPlayer | null = null
let currentInput: Input | null = null
let loopGapIntervalId = 0
let frameRateIntervalId = 0

function updateFrameRateMonitor(player: SeamlessLoopPlayer): void {
  const snapshot = player.getFrameRateSnapshot()
  renderFpsEl.textContent = snapshot.renderFps === null
    ? '—'
    : `${snapshot.renderFps.toFixed(1)} fps`
  displayedFpsEl.textContent = snapshot.displayedFps === null
    ? '—'
    : `${snapshot.displayedFps.toFixed(1)} fps`
  frameTimeEl.textContent = snapshot.medianFrameTimeMs === null
    ? '—'
    : `${snapshot.medianFrameTimeMs.toFixed(1)} ms`
  longFramesEl.textContent = snapshot.longFrames === null
    ? '—'
    : String(snapshot.longFrames)
  bufferAheadEl.textContent = snapshot.bufferAheadSec === null
    ? '—'
    : `${snapshot.bufferAheadSec.toFixed(2)} s`
}

function resetFrameRateMonitor(): void {
  renderFpsEl.textContent = '—'
  displayedFpsEl.textContent = '—'
  frameTimeEl.textContent = '—'
  longFramesEl.textContent = '—'
  bufferAheadEl.textContent = '—'
}

function teardown(): void {
  currentPlayer?.stop()
  currentPlayer = null

  clearInterval(loopGapIntervalId)
  clearInterval(frameRateIntervalId)
  resetFrameRateMonitor()

  currentInput?.dispose()
  currentInput = null
}

async function loadFile(file: File): Promise<void> {
  teardown()
  setStatus('Parsing video…')

  try {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
    currentInput = input

    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack) {
      setStatus('No video track found in this file.')
      return
    }

    const [duration, videoWidth, videoHeight] = await Promise.all([
      videoTrack.computeDuration(),
      videoTrack.getDisplayWidth(),
      videoTrack.getDisplayHeight(),
    ])

    if (duration <= 0) {
      setStatus('Could not determine video duration.')
      return
    }

    setStatus(`Ready – ${videoWidth}×${videoHeight}, ${duration.toFixed(2)} s`)

    // Set canvas pixel dimensions to match the video
    canvas.width = videoWidth
    canvas.height = videoHeight

    const player = new SeamlessLoopPlayer(
      videoTrack, duration, videoWidth, videoHeight, canvas,
    )
    currentPlayer = player
    setStatus('Preparing playback...')
    await player.start()
    if (currentPlayer !== player) return

    const playbackMode = player.isFullyBuffered
      ? 'full loop buffered'
      : 'streaming decode'
    setStatus(`Ready (${playbackMode})`)

    void requestWakeLock()

    // Periodically surface the loop gap measurement
    loopGapIntervalId = window.setInterval(() => {
      if (player.loopGapMs !== null) {
        loopGapEl.textContent = `${player.loopGapMs.toFixed(2)} ms`
      }
    }, 500)

    frameRateIntervalId = window.setInterval(() => {
      updateFrameRateMonitor(player)
    }, 500)
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`)
    teardown()
  }
}

async function setSelectedFile(
  file: File,
  handle?: FileSystemFileHandle,
): Promise<void> {
  setFileName(file)

  if (handle && 'indexedDB' in window) {
    try {
      await dbPut(HANDLE_KEY, handle)
    } catch {
      // Storage failure is non-fatal
    }
  }

  await loadFile(file)
}

async function restoreFileFromDb(): Promise<void> {
  if (!('showOpenFilePicker' in window) || !('indexedDB' in window)) return

  try {
    const handle = (await dbGet(HANDLE_KEY)) as FileSystemFileHandle | null
    if (!handle) return

    const permission = await handle.queryPermission({ mode: 'read' })
    if (permission !== 'granted') return

    const file = await handle.getFile()
    await setSelectedFile(file, handle)
    setStatus('Restored file handle from IndexedDB.')
  } catch {
    // No usable stored handle
  }
}

// ──────────────────────────────────────────────
// Event wiring
// ──────────────────────────────────────────────

fileInput.addEventListener('change', async (e) => {
  const [file] = (e.target as HTMLInputElement).files ?? []
  if (file) await setSelectedFile(file)
})

pickerButton.addEventListener('click', async () => {
  if (!('showOpenFilePicker' in window)) {
    setStatus('File System Access API is not available in this browser.')
    return
  }

  try {
    // showOpenFilePicker is not yet in the standard TS lib
    const [handle] = await (
      window as Window & {
        showOpenFilePicker(opts?: object): Promise<FileSystemFileHandle[]>
      }
    ).showOpenFilePicker({
      types: [
        {
          description: 'Video files',
          accept: { 'video/*': ['.mp4', '.m4v', '.webm', '.mov'] },
        },
      ],
      excludeAcceptAllOption: false,
      multiple: false,
    })

    const file = await handle.getFile()
    await setSelectedFile(file, handle)
    setStatus('Loaded and saved handle in IndexedDB.')
  } catch {
    setStatus('Picker cancelled.')
  }
})

fullscreenButton.addEventListener('click', async () => {
  if (!document.fullscreenElement) {
    await playerContainer.requestFullscreen()
  } else {
    await document.exitFullscreen()
  }
})

document.addEventListener('visibilitychange', () => {
  if (!currentPlayer) return

  if (document.visibilityState === 'visible') {
    currentPlayer.resumeFromVisibility()
    void requestWakeLock()
  } else {
    currentPlayer.pauseForVisibility()
  }
})

window.addEventListener('beforeunload', () => {
  void releaseWakeLock()
})

// ── Boot ──────────────────────────────────────

void restoreFileFromDb()
