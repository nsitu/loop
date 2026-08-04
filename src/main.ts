import './style.css'
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CmafOutputFormat,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Output,
  VideoSampleSink,
} from 'mediabunny'
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
      <video id="playerVideo" muted playsinline disablepictureinpicture></video>
    </div>

    <section class="status" aria-live="polite">
      <p><strong>Loaded:</strong> <span id="fileName">None</span></p>
      <p><strong>Loop boundary gap:</strong> <span id="loopGap">Waiting…</span></p>
      <p><strong>Status:</strong> <span id="statusText">Idle</span></p>
      <div id="preloadStatus" hidden>
        <progress id="preloadProgress" max="1" value="0"></progress>
        <span id="preloadProgressLabel">0%</span>
      </div>
    </section>

    <section class="diagnostics" aria-label="Playback diagnostics">
      <div class="diagnostics-heading">
        <h2>Frame-rate monitor</h2>
        <span>updates every 500 ms</span>
      </div>
      <div class="metric-grid">
        <div class="metric"><span>Frame FPS</span><strong id="renderFps">—</strong><small>video callback / rAF</small></div>
        <div class="metric"><span>Displayed FPS</span><strong id="displayedFps">—</strong><small>new video samples</small></div>
        <div class="metric"><span>Frame time</span><strong id="frameTime">—</strong><small>median render interval</small></div>
        <div class="metric"><span>Long frames</span><strong id="longFrames">—</strong><small>rAF gap &gt; 1.5× median</small></div>
        <div class="metric"><span>Decode-ahead</span><strong id="bufferAhead">—</strong><small>seconds queued</small></div>
        <div class="metric"><span>Full-loop memory</span><strong id="fullLoopMemory">—</strong><small>decoded sample allocation</small></div>
      </div>
    </section>
  </main>
`

const fileInput = document.querySelector<HTMLInputElement>('#fileInput')!
const pickerButton = document.querySelector<HTMLButtonElement>('#pickerButton')!
const fullscreenButton = document.querySelector<HTMLButtonElement>('#fullscreenButton')!
const playerContainer = document.querySelector<HTMLDivElement>('#playerContainer')!
const canvas = document.querySelector<HTMLCanvasElement>('#player')!
const playerVideo = document.querySelector<HTMLVideoElement>('#playerVideo')!
const fileNameEl = document.querySelector<HTMLElement>('#fileName')!
const loopGapEl = document.querySelector<HTMLElement>('#loopGap')!
const statusEl = document.querySelector<HTMLElement>('#statusText')!
const preloadStatusEl = document.querySelector<HTMLDivElement>('#preloadStatus')!
const preloadProgressEl = document.querySelector<HTMLProgressElement>('#preloadProgress')!
const preloadProgressLabelEl = document.querySelector<HTMLElement>('#preloadProgressLabel')!
const renderFpsEl = document.querySelector<HTMLElement>('#renderFps')!
const displayedFpsEl = document.querySelector<HTMLElement>('#displayedFps')!
const frameTimeEl = document.querySelector<HTMLElement>('#frameTime')!
const longFramesEl = document.querySelector<HTMLElement>('#longFrames')!
const bufferAheadEl = document.querySelector<HTMLElement>('#bufferAhead')!
const fullLoopMemoryEl = document.querySelector<HTMLElement>('#fullLoopMemory')!

// ──────────────────────────────────────────────
// Utilities
// ──────────────────────────────────────────────

function setStatus(msg: string) {
  statusEl.textContent = msg
}

function playbackStatus(player: LoopPlayer): string {
  switch (player.playbackState) {
    case 'preparing':
      return `Preparing playback (${player.rendererBackend})`
    case 'streaming':
      return `Playing (streaming decode, ${player.rendererBackend})`
    case 'full-loop':
      return `Playing (full loop buffered, ${(player.fullLoopMemory.usedBytes / MIB).toFixed(0)} MiB, ${player.rendererBackend})`
    case 'native-mse':
      return player.playbackError
        ? `Playing (native MSE, retrying buffer append, ${player.rendererBackend})`
        : `Playing (native MSE, ${player.rendererBackend})`
  }
}

function resetPreloadProgress(): void {
  preloadStatusEl.hidden = true
  preloadProgressEl.value = 0
  preloadProgressLabelEl.textContent = '0%'
}

function updatePreloadProgress(
  player: LoopPlayer,
  progress: PreparationProgress,
): void {
  preloadStatusEl.hidden = false
  preloadProgressEl.value = progress.fraction
  preloadProgressLabelEl.textContent = `${(progress.fraction * 100).toFixed(0)}% · ${progress.detail}`
  setStatus(playbackStatus(player))
}

function setFileName(file: File | null) {
  fileNameEl.textContent = file
    ? `${file.name} (${Math.round(file.size / 1024)} KB)`
    : 'None'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForPromiseOrTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      value => {
        window.clearTimeout(timeoutId)
        resolve(value)
      },
      error => {
        window.clearTimeout(timeoutId)
        reject(error)
      },
    )
  })
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

type RendererBackend = 'MSE' | 'WebGL2' | 'WebGL1' | 'WebGPU'
type PlaybackState = 'preparing' | 'streaming' | 'full-loop' | 'native-mse'

type PreparationProgress = {
  fraction: number
  detail: string
}

interface LoopPlayer {
  readonly loopGapMs: number | null
  readonly playbackState: PlaybackState
  readonly rendererBackend: RendererBackend
  readonly fullLoopMemory: { usedBytes: number; budgetBytes: number }
  readonly playbackError?: string | null
  start(onPreparationProgress?: (progress: PreparationProgress) => void): Promise<void>
  stop(): void
  pauseForVisibility(): void
  resumeFromVisibility(): void
  getFrameRateSnapshot(): FrameRateSnapshot
}

interface FrameRenderer {
  readonly backend: RendererBackend
  render(sample: VideoSample, uploadSample: boolean): void
  dispose(): void
}

// Keep WebGPU optional at compile time. The app still builds with the standard
// DOM library when WebGPU typings are not installed, while supported browsers
// provide the runtime objects used below.
type WebGPUFormat = string
type WebGPUObject = object

interface WebGPUTextureView extends WebGPUObject {}
interface WebGPUBuffer extends WebGPUObject { destroy(): void }
interface WebGPUSampler extends WebGPUObject {}
interface WebGPUBindGroupLayout extends WebGPUObject {}
interface WebGPUPipeline extends WebGPUObject {}
interface WebGPUBindGroup extends WebGPUObject {}
interface WebGPUCommandBuffer extends WebGPUObject {}
interface WebGPUExternalTexture extends WebGPUObject {}

interface WebGPURenderPassEncoder {
  setPipeline(pipeline: WebGPUPipeline): void
  setVertexBuffer(slot: number, buffer: WebGPUBuffer): void
  setBindGroup(index: number, bindGroup: WebGPUBindGroup): void
  draw(vertexCount: number): void
  end(): void
}

interface WebGPUCommandEncoder {
  beginRenderPass(descriptor: object): WebGPURenderPassEncoder
  finish(): WebGPUCommandBuffer
}

interface WebGPUQueue {
  writeBuffer(buffer: WebGPUBuffer, bufferOffset: number, data: BufferSource): void
  submit(commandBuffers: WebGPUCommandBuffer[]): void
  onSubmittedWorkDone(): Promise<void>
}

interface WebGPUDevice {
  readonly queue: WebGPUQueue
  createShaderModule(descriptor: object): WebGPUObject
  createBindGroupLayout(descriptor: object): WebGPUBindGroupLayout
  createPipelineLayout(descriptor: object): WebGPUObject
  createRenderPipeline(descriptor: object): WebGPUPipeline
  createBuffer(descriptor: object): WebGPUBuffer
  createSampler(descriptor: object): WebGPUSampler
  importExternalTexture(descriptor: { source: VideoFrame }): WebGPUExternalTexture
  createBindGroup(descriptor: object): WebGPUBindGroup
  createCommandEncoder(): WebGPUCommandEncoder
  destroy(): void
}

interface WebGPUAdapter {
  requestDevice(): Promise<WebGPUDevice>
}

interface WebGPUCanvasContext {
  configure(descriptor: object): void
  getCurrentTexture(): { createView(): WebGPUTextureView }
}

interface WebGPUApi {
  requestAdapter(options?: object): Promise<WebGPUAdapter | null>
  getPreferredCanvasFormat(): WebGPUFormat
}

const WEBGPU_FRAGMENT_STAGE = 0x2
const WEBGPU_VERTEX_BUFFER_USAGE = 0x20
const WEBGPU_COPY_DST_USAGE = 0x8

class WebGLRenderer {
  private readonly gl: WebGLRenderingContext | WebGL2RenderingContext
  private readonly webgl2: boolean
  private readonly program: WebGLProgram
  private readonly buffer: WebGLBuffer
  private readonly texture: WebGLTexture
  private readonly positionLocation: number
  private readonly texCoordLocation: number
  private uploadedRotation: VideoSample['rotation'] | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly videoWidth: number,
    private readonly videoHeight: number,
  ) {
    const contextAttributes: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    }
    const webgl2 = canvas.getContext('webgl2', contextAttributes)
    const gl = webgl2 ?? canvas.getContext('webgl', contextAttributes)
    if (!gl) throw new Error('WebGL is not available in this browser.')
    this.gl = gl
    this.webgl2 = webgl2 !== null

    const vertexShader = this.createShader(gl.VERTEX_SHADER, this.webgl2 ? `#version 300 es
      in vec2 a_position;
      in vec2 a_texCoord;
      out vec2 v_texCoord;

      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    ` : `
      attribute vec2 a_position;
      attribute vec2 a_texCoord;
      varying vec2 v_texCoord;

      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }
    `)
    const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, this.webgl2 ? `#version 300 es
      precision mediump float;
      uniform sampler2D u_texture;
      in vec2 v_texCoord;
      out vec4 outColor;

      void main() {
        outColor = texture(u_texture, v_texCoord);
      }
    ` : `
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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    if (this.webgl2) {
      const gl2 = gl as WebGL2RenderingContext
      gl2.texStorage2D(
        gl2.TEXTURE_2D,
        1,
        gl2.RGBA8,
        videoWidth,
        videoHeight,
      )
    }
    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0)
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 1)
    this.updateGeometry(0)
  }

  get backend(): RendererBackend {
    return this.webgl2 ? 'WebGL2' : 'WebGL1'
  }

  render(sample: VideoSample, uploadSample: boolean): void {
    const gl = this.gl

    if (uploadSample) {
      const frame = sample.toVideoFrame()
      try {
        gl.bindTexture(gl.TEXTURE_2D, this.texture)
        if (this.webgl2) {
          const gl2 = gl as WebGL2RenderingContext
          gl2.texSubImage2D(
            gl2.TEXTURE_2D,
            0,
            0,
            0,
            gl2.RGBA,
            gl2.UNSIGNED_BYTE,
            frame,
          )
        } else {
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            frame as unknown as TexImageSource,
          )
        }
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
    if (this.uploadedRotation !== sample.rotation) {
      this.updateGeometry(sample.rotation, left, right, top, bottom)
    }
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

  private updateGeometry(
    rotation: VideoSample['rotation'],
    left = -1,
    right = 1,
    top = 1,
    bottom = -1,
  ): void {
    const textureCoordinates = this.textureCoordinates(rotation)
    const vertices = new Float32Array([
      left, bottom, textureCoordinates[0], textureCoordinates[1],
      right, bottom, textureCoordinates[2], textureCoordinates[3],
      left, top, textureCoordinates[4], textureCoordinates[5],
      right, top, textureCoordinates[6], textureCoordinates[7],
    ])

    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer)
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW)
    this.uploadedRotation = rotation
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

/**
 * Experimental WebGPU renderer. Enable with `?renderer=webgpu`.
 *
 * VideoFrames are imported as external textures so the browser can keep the
 * decoded representation in its native GPU-friendly form when supported.
 * The source frame is retained until previously submitted work has completed.
 */
class WebGPURenderer implements FrameRenderer {
  readonly backend: RendererBackend = 'WebGPU'

  private readonly device: WebGPUDevice
  private readonly context: WebGPUCanvasContext
  private readonly pipeline: WebGPUPipeline
  private readonly vertexBuffer: WebGPUBuffer
  private readonly sampler: WebGPUSampler
  private readonly bindGroupLayout: WebGPUBindGroupLayout
  private currentFrame: VideoFrame | null = null
  private currentBindGroup: WebGPUBindGroup | null = null
  private uploadedRotation: VideoSample['rotation'] | null = null

  private constructor(
    device: WebGPUDevice,
    context: WebGPUCanvasContext,
    format: WebGPUFormat,
  ) {
    this.device = device
    this.context = context

    const shaderModule = device.createShaderModule({
      code: `
        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f,
        };

        @vertex
        fn vertexMain(
          @location(0) position: vec2f,
          @location(1) uv: vec2f,
        ) -> VertexOutput {
          var output: VertexOutput;
          output.position = vec4f(position, 0.0, 1.0);
          output.uv = uv;
          return output;
        }

        @group(0) @binding(0) var videoTexture: texture_external;
        @group(0) @binding(1) var videoSampler: sampler;

        @fragment
        fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
          return textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv);
        }
      `,
    })

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: WEBGPU_FRAGMENT_STAGE, externalTexture: {} },
        { binding: 1, visibility: WEBGPU_FRAGMENT_STAGE, sampler: { type: 'filtering' } },
      ],
    })
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vertexMain',
        buffers: [{
          arrayStride: 16,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragmentMain',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-strip' },
    })
    this.vertexBuffer = device.createBuffer({
      size: 4 * 4 * Float32Array.BYTES_PER_ELEMENT,
      usage: WEBGPU_VERTEX_BUFFER_USAGE | WEBGPU_COPY_DST_USAGE,
    })
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    this.updateGeometry(0)
  }

  static async create(canvas: HTMLCanvasElement): Promise<WebGPURenderer | null> {
    const gpu = 'gpu' in navigator
      ? navigator.gpu as unknown as WebGPUApi
      : null
    if (!gpu) return null

    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) return null

    const device = await adapter.requestDevice()
    const context = canvas.getContext('webgpu') as unknown as WebGPUCanvasContext | null
    if (!context) {
      device.destroy()
      return null
    }

    const format = gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })
    return new WebGPURenderer(device, context, format)
  }

  render(sample: VideoSample, uploadSample: boolean): void {
    if (uploadSample) {
      const frame = sample.toVideoFrame()
      const externalTexture = this.device.importExternalTexture({ source: frame })
      const previousFrame = this.currentFrame
      this.currentFrame = frame
      this.currentBindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: externalTexture },
          { binding: 1, resource: this.sampler },
        ],
      })
      if (previousFrame) this.retireFrame(previousFrame)

      if (this.uploadedRotation !== sample.rotation) {
        this.updateGeometry(sample.rotation)
      }
    }

    if (!this.currentBindGroup) return

    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    })
    pass.setPipeline(this.pipeline)
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setBindGroup(0, this.currentBindGroup)
    pass.draw(4)
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  dispose(): void {
    if (this.currentFrame) this.retireFrame(this.currentFrame)
    this.currentFrame = null
    this.currentBindGroup = null
    this.vertexBuffer.destroy()
    this.device.destroy()
  }

  private retireFrame(frame: VideoFrame): void {
    void this.device.queue.onSubmittedWorkDone().then(
      () => frame.close(),
      () => frame.close(),
    )
  }

  private updateGeometry(rotation: VideoSample['rotation']): void {
    const textureCoordinates = this.textureCoordinates(rotation)
    const vertices = new Float32Array([
      -1, -1, textureCoordinates[0], textureCoordinates[1],
      1, -1, textureCoordinates[2], textureCoordinates[3],
      -1, 1, textureCoordinates[4], textureCoordinates[5],
      1, 1, textureCoordinates[6], textureCoordinates[7],
    ])
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices)
    this.uploadedRotation = rotation
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
}

/**
 * Native playback path. Mediabunny copies the encoded video packets into one
 * CMAF/fMP4 init segment and one media segment; MSE then appends repeated
 * timestamp-offset copies to a continuous native <video> timeline.
 */
class NativeMseLoopPlayer implements LoopPlayer {
  readonly rendererBackend: RendererBackend = 'MSE'
  loopGapMs: number | null = null

  private playbackMode: PlaybackState = 'preparing'
  private playing = false
  private visibilityPaused = false
  private sourceBuffer: SourceBuffer | null = null
  private objectUrl: string | null = null
  private mediaSegment: ArrayBuffer | null = null
  private loopDuration: number
  private nextLoopTimestamp = 0
  private appendInFlight = false
  private appendQueued = false
  private bufferMaintenanceTimerId = 0
  private appendError: string | null = null
  private frameCallbackId = 0
  private lastRenderedLoopIndex = -1
  private readonly frameRateMonitor = new FrameRateMonitor()

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly videoTrack: InputVideoTrack,
    private readonly duration: number,
  ) {
    this.loopDuration = duration
  }

  get playbackState(): PlaybackState {
    return this.playbackMode
  }

  get fullLoopMemory(): { usedBytes: number; budgetBytes: number } {
    return { usedBytes: 0, budgetBytes: 0 }
  }

  get playbackError(): string | null {
    return this.appendError
  }

  async start(onPreparationProgress?: (progress: PreparationProgress) => void): Promise<void> {
    this.playing = true
    this.visibilityPaused = false
    this.playbackMode = 'preparing'
    this.loopGapMs = null
    this.lastRenderedLoopIndex = -1
    this.frameRateMonitor.reset()
    this.appendError = null

    const prepared = await this.prepareCmafSegment(onPreparationProgress)
    if (!this.playing) return

    await this.attachMediaSource(prepared.initSegment, prepared.mediaSegment, prepared.mimeType)
    if (!this.playing) return

    await this.appendSegment(prepared.initSegment, 0)
    await this.appendSegment(prepared.mediaSegment, 0)
    this.loopDuration = prepared.segmentDuration
    await this.appendSegment(prepared.mediaSegment, this.loopDuration)
    this.mediaSegment = prepared.mediaSegment
    this.nextLoopTimestamp = this.loopDuration * 2
    this.playbackMode = 'native-mse'
    this.startBufferMaintenance()

    if (!this.visibilityPaused) {
      await this.video.play()
      this.scheduleFrameCallback()
    }
  }

  stop(): void {
    this.playing = false
    this.visibilityPaused = false
    this.cancelFrameCallback()
    if (this.bufferMaintenanceTimerId !== 0) {
      window.clearInterval(this.bufferMaintenanceTimerId)
      this.bufferMaintenanceTimerId = 0
    }
    this.video.pause()
    this.video.removeAttribute('src')
    this.video.load()

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
    this.sourceBuffer = null
    this.mediaSegment = null
    this.appendInFlight = false
    this.appendQueued = false
    this.loopDuration = this.duration
    this.frameRateMonitor.reset()
  }

  pauseForVisibility(): void {
    if (!this.playing || this.visibilityPaused) return
    this.visibilityPaused = true
    this.cancelFrameCallback()
    this.video.pause()
  }

  resumeFromVisibility(): void {
    if (!this.playing || !this.visibilityPaused) return
    this.visibilityPaused = false
    void this.video.play().then(() => this.scheduleFrameCallback()).catch(() => {})
  }

  getFrameRateSnapshot(): FrameRateSnapshot {
    return this.frameRateMonitor.snapshot()
  }

  private async prepareCmafSegment(
    onProgress?: (progress: PreparationProgress) => void,
  ): Promise<{
    initSegment: ArrayBuffer
    mediaSegment: ArrayBuffer
    mimeType: string
    segmentDuration: number
  }> {
    const codec = await this.videoTrack.getCodec()
    const decoderConfig = await this.videoTrack.getDecoderConfig()
    const codecString = decoderConfig?.codec ?? await this.videoTrack.getCodecParameterString()
    const firstTimestamp = await this.videoTrack.getFirstTimestamp()
    if (!codec || !codecString) throw new Error('Could not determine the video codec for MSE.')

    const mimeType = `video/mp4; codecs="${codecString}"`
    if (!('MediaSource' in window) || !MediaSource.isTypeSupported(mimeType)) {
      throw new Error(`MSE does not support ${mimeType}.`)
    }

    onProgress?.({ fraction: 0, detail: 'Preparing fragmented MP4…' })

    const initTarget = new BufferTarget()
    const mediaTarget = new BufferTarget()
    const output = new Output({
      format: new CmafOutputFormat(),
      target: mediaTarget,
      initTarget,
    })
    const source = new EncodedVideoPacketSource(codec)
    output.addVideoTrack(source, { rotation: await this.videoTrack.getRotation() })
    let segmentDuration = 0

    try {
      await output.start()
      const sink = new EncodedPacketSink(this.videoTrack)
      let firstPacket = true

      for await (const packet of sink.packets(undefined, undefined, { verifyKeyPackets: true })) {
        if (!this.playing) throw new Error('MSE preparation canceled.')

        const normalizedPacket = packet.clone({
          timestamp: packet.timestamp - firstTimestamp,
        })
        segmentDuration = Math.max(
          segmentDuration,
          normalizedPacket.timestamp + normalizedPacket.duration,
        )
        await source.add(
          normalizedPacket,
          firstPacket ? { decoderConfig: decoderConfig ?? undefined } : undefined,
        )
        firstPacket = false
        onProgress?.({
          fraction: Math.min(1, Math.max(0, (normalizedPacket.timestamp + normalizedPacket.duration) / this.duration)),
          detail: `${Math.min(this.duration, normalizedPacket.timestamp + normalizedPacket.duration).toFixed(1)} / `
            + `${this.duration.toFixed(1)} s · packaging encoded packets`,
        })
      }

      source.close()
      await output.finalize()
    } catch (error) {
      source.close()
      await output.cancel().catch(() => {})
      throw error
    }

    if (!initTarget.buffer || !mediaTarget.buffer) {
      throw new Error('MSE segment preparation produced no data.')
    }

    return {
      initSegment: initTarget.buffer,
      mediaSegment: mediaTarget.buffer,
      mimeType,
      segmentDuration: Math.max(0.001, segmentDuration),
    }
  }

  private async attachMediaSource(
    initSegment: ArrayBuffer,
    mediaSegment: ArrayBuffer,
    mimeType: string,
  ): Promise<void> {
    const mediaSource = new MediaSource()
    this.mediaSegment = mediaSegment
    this.objectUrl = URL.createObjectURL(mediaSource)
    this.video.src = this.objectUrl

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        mediaSource.removeEventListener('sourceopen', onOpen)
        try {
          this.sourceBuffer = mediaSource.addSourceBuffer(mimeType)
          this.sourceBuffer.mode = 'segments'
          resolve()
        } catch (error) {
          reject(error)
        }
      }
      mediaSource.addEventListener('sourceopen', onOpen, { once: true })
      mediaSource.addEventListener('error', () => reject(new Error('MediaSource failed to open.')), { once: true })
    })

    // Keep the arguments alive in this method so the initial append sequence
    // remains explicit and easy to inspect during device testing.
    void initSegment
  }

  private appendSegment(segment: ArrayBuffer, timestampOffset: number): Promise<void> {
    const sourceBuffer = this.sourceBuffer
    if (!sourceBuffer) return Promise.reject(new Error('MSE SourceBuffer is unavailable.'))

    return new Promise((resolve, reject) => {
      const onUpdateEnd = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('MSE SourceBuffer append failed.'))
      }
      const cleanup = () => {
        sourceBuffer.removeEventListener('updateend', onUpdateEnd)
        sourceBuffer.removeEventListener('error', onError)
        this.appendInFlight = false
      }

      this.appendInFlight = true
      sourceBuffer.addEventListener('updateend', onUpdateEnd, { once: true })
      sourceBuffer.addEventListener('error', onError, { once: true })
      try {
        sourceBuffer.timestampOffset = timestampOffset
        sourceBuffer.appendBuffer(segment.slice(0))
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }

  private scheduleFrameCallback(): void {
    if (!this.playing || this.visibilityPaused) return
    if ('requestVideoFrameCallback' in this.video) {
      this.frameCallbackId = this.video.requestVideoFrameCallback(this.onVideoFrame)
    } else {
      this.frameCallbackId = requestAnimationFrame(this.onFallbackFrame)
    }
  }

  private cancelFrameCallback(): void {
    if (this.frameCallbackId === 0) return
    if ('cancelVideoFrameCallback' in this.video) {
      this.video.cancelVideoFrameCallback(this.frameCallbackId)
    } else {
      cancelAnimationFrame(this.frameCallbackId)
    }
    this.frameCallbackId = 0
  }

  private onVideoFrame = (now: number, metadata: VideoFrameCallbackMetadata): void => {
    if (!this.playing || this.visibilityPaused) return
    this.inspectPresentedFrame(now, metadata.mediaTime)
    this.maintainBuffer()
    this.scheduleFrameCallback()
  }

  private onFallbackFrame = (now: number): void => {
    if (!this.playing || this.visibilityPaused) return
    this.inspectPresentedFrame(now, this.video.currentTime)
    this.maintainBuffer()
    this.scheduleFrameCallback()
  }

  private startBufferMaintenance(): void {
    if (this.bufferMaintenanceTimerId !== 0) return
    this.bufferMaintenanceTimerId = window.setInterval(() => {
      this.maintainBuffer()
    }, 100)
    this.maintainBuffer()
  }

  private inspectPresentedFrame(timestamp: number, mediaTime: number): void {
    const loopIndex = Math.floor(mediaTime / this.loopDuration)
    if (loopIndex > this.lastRenderedLoopIndex && this.lastRenderedLoopIndex >= 0) {
      this.loopGapMs = (mediaTime - loopIndex * this.loopDuration) * 1000
    }
    this.lastRenderedLoopIndex = Math.max(this.lastRenderedLoopIndex, loopIndex)
    this.frameRateMonitor.record(timestamp, true, this.bufferAheadSeconds())
  }

  private bufferAheadSeconds(): number {
    const currentTime = this.video.currentTime
    const buffered = this.video.buffered
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
        return Math.max(0, buffered.end(i) - currentTime)
      }
    }
    return 0
  }

  private maintainBuffer(): void {
    if (
      !this.playing
      || this.visibilityPaused
      || !this.sourceBuffer
      || !this.mediaSegment
    ) return

    const currentTime = this.video.currentTime
    const bufferedEnd = this.bufferedEndAt(currentTime)
    const bufferAhead = bufferedEnd - currentTime
    const targetAhead = this.loopDuration * 2

    if (
      (bufferAhead < targetAhead || !Number.isFinite(bufferAhead))
      && !this.appendInFlight
      && !this.appendQueued
    ) {
      const timestampOffset = this.nextLoopTimestamp
      this.nextLoopTimestamp += this.loopDuration
      this.appendQueued = true
      void this.appendSegment(this.mediaSegment, timestampOffset)
        .then(() => {
          this.appendError = null
        })
        .catch(error => {
          this.nextLoopTimestamp = timestampOffset
          this.appendError = error instanceof Error ? error.message : String(error)
          console.warn('MSE loop segment append failed; retrying.', error)
        })
        .finally(() => {
          this.appendQueued = false
          if (this.playing) this.maintainBuffer()
        })
    }

    if (
      !this.sourceBuffer.updating
      && currentTime > this.loopDuration * 3
      && this.sourceBuffer.buffered.length > 0
      && currentTime - this.sourceBuffer.buffered.start(0) > this.loopDuration * 1.5
    ) {
      this.sourceBuffer.remove(0, currentTime - this.loopDuration)
    }
  }

  private bufferedEndAt(currentTime: number): number {
    if (!this.sourceBuffer || this.sourceBuffer.buffered.length === 0) return 0

    let latestEnd = 0
    for (let i = 0; i < this.sourceBuffer.buffered.length; i++) {
      const start = this.sourceBuffer.buffered.start(i)
      const end = this.sourceBuffer.buffered.end(i)
      latestEnd = Math.max(latestEnd, end)
      if (start <= currentTime && currentTime <= end) return end
    }
    return latestEnd
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
const PREDECODE_STALL_TIMEOUT_MS = 3000
const MIB = 1024 * 1024

/**
 * Profile for the photo-frame hardware this player is being tuned for.
 *
 * Total system RAM is not the same thing as the memory available to a
 * Chromium/WebView renderer or to the video decoder. Keep a large reserve for
 * Android, the browser, the WebGL context, and decoder overhead. This is an
 * intentionally conservative starting point; increase it only after long
 * soak tests on the target unit show that the process remains stable.
 */
const TARGET_DEVICE = {
  name: 'Amlogic Cortex-A55 / Mali-G52 MC1 / 4 GB RAM',
  totalRamBytes: 3817 * MIB,
  fullLoopMemoryBudgetBytes: 512 * MIB,
}

class SeamlessLoopPlayer {
  private readonly videoTrack: InputVideoTrack
  private readonly duration: number
  private readonly videoWidth: number
  private readonly videoHeight: number
  private readonly renderer: FrameRenderer

  /** Shared, time-ordered queue of decoded frames. */
  private queue: Array<{ sample: VideoSample; playbackTime: number }> = []
  /** Reused decoded frames for short loops that fit the memory budget. */
  private fullLoopSamples: VideoSample[] | null = null
  private fullLoopMemoryBytes = 0
  private predecodeMemoryBytes = 0

  private playing = false
  private visibilityPaused = false
  private playbackMode: PlaybackState = 'preparing'
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
    renderer: FrameRenderer,
  ) {
    this.videoTrack = videoTrack
    this.duration = duration
    this.videoWidth = videoWidth
    this.videoHeight = videoHeight
    this.renderer = renderer
  }

  async start(onPreloadProgress?: (progress: PreparationProgress) => void): Promise<void> {
    this.playing = true
    this.visibilityPaused = false
    this.playbackMode = 'preparing'
    const generation = ++this.producerGeneration
    this.startTime = performance.now()
    this.lastRenderedLoopIndex = -1
    this.loopGapMs = null
    this.lastDrawnSample = null
    this.frameRateMonitor.reset()

    await this.preparePlayback(generation, onPreloadProgress)
    if (!this.playing || generation !== this.producerGeneration) return
    if (!this.visibilityPaused) this.rafId = requestAnimationFrame(this.render)
  }

  stop(): void {
    this.playing = false
    this.visibilityPaused = false
    this.producerGeneration += 1
    cancelAnimationFrame(this.rafId)

    this.clearStreamingQueue()
    for (const sample of this.fullLoopSamples ?? []) sample.close()
    this.fullLoopSamples = null
    this.fullLoopMemoryBytes = 0
    this.predecodeMemoryBytes = 0
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
      this.playbackMode = 'streaming'
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

  get playbackState(): PlaybackState {
    return this.playbackMode
  }

  get rendererBackend(): RendererBackend {
    return this.renderer.backend
  }

  get fullLoopMemory(): { usedBytes: number; budgetBytes: number } {
    return {
      usedBytes: this.playbackMode === 'preparing'
        ? this.predecodeMemoryBytes
        : this.fullLoopMemoryBytes,
      budgetBytes: TARGET_DEVICE.fullLoopMemoryBudgetBytes,
    }
  }

  getFrameRateSnapshot(): FrameRateSnapshot {
    return this.frameRateMonitor.snapshot()
  }

  // ── Private helpers ──────────────────────────

  private async preparePlayback(
    generation: number,
    onPreloadProgress?: (progress: PreparationProgress) => void,
  ): Promise<void> {
    const buffered = await this.tryPredecodeLoop(generation, onPreloadProgress)
    if (!this.playing || generation !== this.producerGeneration) return

    if (buffered) {
      this.predecodeMemoryBytes = 0
      this.playbackMode = 'full-loop'
      return
    }

    this.predecodeMemoryBytes = 0
    this.playbackMode = 'streaming'
    void this.startProducer(0, 0, generation)
  }

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
      let low = 0
      let high = this.queue.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (this.queue[middle].playbackTime <= t) low = middle + 1
        else high = middle
      }
      bestIdx = low - 1
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
   * Decode a loop once when its actual decoded samples fit the device profile's
   * memory budget. If it does not fit, release the temporary samples and stream
   * it. The budget, rather than duration, is the important limit here because
   * decoded bytes per second vary substantially with pixel format and frame
   * rate.
   */
  private async tryPredecodeLoop(
    generation: number,
    onProgress?: (progress: PreparationProgress) => void,
  ): Promise<boolean> {
    const sink = new VideoSampleSink(this.videoTrack)
    const samples: VideoSample[] = []
    let bytes = 0

    try {
      const iterator = sink.samples()[Symbol.asyncIterator]()
      while (true) {
        const nextResult = await waitForPromiseOrTimeout(
          iterator.next(),
          PREDECODE_STALL_TIMEOUT_MS,
        )
        if (nextResult === null) {
          // A hardware decoder can stop producing when too many VideoFrames
          // remain retained. Do not leave startup waiting forever; terminate
          // this attempt and use the bounded streaming path instead.
          void iterator.return?.()
          for (const queuedSample of samples) queuedSample.close()
          this.predecodeMemoryBytes = 0
          return false
        }
        if (nextResult.done) break

        const sample = nextResult.value
        if (!this.isProducerActive(generation)) {
          sample.close()
          for (const queuedSample of samples) queuedSample.close()
          return false
        }

        if (sample.timestamp >= 0 && sample.timestamp < this.duration) {
          const sampleBytes = this.sampleAllocationSize(sample)
          bytes += sampleBytes
          this.predecodeMemoryBytes = bytes
          onProgress?.({
            fraction: Math.min(1, sample.timestamp / this.duration),
            detail: `${sample.timestamp.toFixed(1)} / ${this.duration.toFixed(1)} s · `
              + `${(bytes / MIB).toFixed(0)} / ${(TARGET_DEVICE.fullLoopMemoryBudgetBytes / MIB).toFixed(0)} MiB`,
          })
          if (bytes > TARGET_DEVICE.fullLoopMemoryBudgetBytes) {
            sample.close()
            for (const queuedSample of samples) queuedSample.close()
            return false
          }
          samples.push(sample)
        } else {
          sample.close()
        }
      }

      if (samples.length === 0) {
        this.predecodeMemoryBytes = 0
        return false
      }
      this.fullLoopSamples = samples
      this.fullLoopMemoryBytes = bytes
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

let currentPlayer: LoopPlayer | null = null
let currentInput: Input | null = null
let loopGapIntervalId = 0
let frameRateIntervalId = 0

function updateFrameRateMonitor(player: LoopPlayer): void {
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
  const memory = player.fullLoopMemory
  fullLoopMemoryEl.textContent = player.playbackState === 'full-loop'
    ? `${(memory.usedBytes / MIB).toFixed(0)} / ${(memory.budgetBytes / MIB).toFixed(0)} MiB`
    : player.playbackState

  if (currentPlayer === player) setStatus(playbackStatus(player))
}

function resetFrameRateMonitor(): void {
  renderFpsEl.textContent = '—'
  displayedFpsEl.textContent = '—'
  frameTimeEl.textContent = '—'
  longFramesEl.textContent = '—'
  bufferAheadEl.textContent = '—'
  fullLoopMemoryEl.textContent = '—'
}

function teardown(): void {
  currentPlayer?.stop()
  currentPlayer = null
  playerContainer.classList.remove('has-video')
  playerContainer.classList.remove('native-playback')
  resetPreloadProgress()

  clearInterval(loopGapIntervalId)
  clearInterval(frameRateIntervalId)
  resetFrameRateMonitor()

  currentInput?.dispose()
  currentInput = null
}

async function createRenderer(
  canvas: HTMLCanvasElement,
  videoWidth: number,
  videoHeight: number,
): Promise<FrameRenderer> {
  const requestedBackend = new URLSearchParams(window.location.search).get('renderer')
  if (requestedBackend === 'webgpu') {
    const renderer = await WebGPURenderer.create(canvas)
    if (!renderer) {
      throw new Error('WebGPU was requested but is unavailable in this browser.')
    }
    return renderer
  }

  return new WebGLRenderer(canvas, videoWidth, videoHeight)
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
    playerContainer.style.setProperty(
      '--video-aspect-ratio',
      String(videoWidth / videoHeight),
    )
    playerContainer.classList.add('has-video')

    let player: LoopPlayer
    let nativePlayer: NativeMseLoopPlayer | null = null
    preloadStatusEl.hidden = false
    playerVideo.muted = true
    playerVideo.playsInline = true

    try {
      playerContainer.classList.add('native-playback')
      nativePlayer = new NativeMseLoopPlayer(playerVideo, videoTrack, duration)
      player = nativePlayer
      currentPlayer = player
      setStatus(playbackStatus(player))
      await player.start(progress => updatePreloadProgress(player, progress))
    } catch {
      nativePlayer?.stop()
      playerContainer.classList.remove('native-playback')

      const renderer = await createRenderer(canvas, videoWidth, videoHeight)
      player = new SeamlessLoopPlayer(
        videoTrack, duration, videoWidth, videoHeight, renderer,
      )
      currentPlayer = player
      setStatus(`Preparing playback (${player.rendererBackend})`)
      await player.start(progress => updatePreloadProgress(player, progress))
    }

    if (currentPlayer !== player) return
    resetPreloadProgress()
    setStatus(playbackStatus(player))

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
