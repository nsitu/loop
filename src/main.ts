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
        <div class="metric"><span>Long frames</span><strong id="longFrames">—</strong><small>over 1.5× normal</small></div>
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

const PREFETCH_SEC = 1.0   // start next-loop decode this many seconds before end
const MAX_AHEAD_SEC = 3.0  // max seconds of decoded frames to keep in memory

class SeamlessLoopPlayer {
  private readonly videoTrack: InputVideoTrack
  private readonly duration: number
  private readonly videoWidth: number
  private readonly videoHeight: number
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D

  /** Shared, time-ordered queue of decoded frames. */
  private queue: Array<{ sample: VideoSample; playbackTime: number }> = []

  private playing = false
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

    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Could not acquire 2D canvas context.')
    this.ctx = ctx
  }

  start(): void {
    this.playing = true
    this.startTime = performance.now()
    this.lastRenderedLoopIndex = -1
    this.loopGapMs = null
    this.lastDrawnSample = null
    this.frameRateMonitor.reset()

    // Kick off the first producer pipeline.  Each producer spawns the next one
    // automatically when it nears its end.
    void this.startProducer(0)

    this.rafId = requestAnimationFrame(this.render)
  }

  stop(): void {
    this.playing = false
    cancelAnimationFrame(this.rafId)

    for (const { sample } of this.queue) sample.close()
    this.queue = []
    this.lastDrawnSample = null
    this.frameRateMonitor.reset()
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
  private async startProducer(loopOffset: number): Promise<void> {
    const sink = new VideoSampleSink(this.videoTrack)
    let prefetchStarted = false

    try {
      for await (const sample of sink.samples()) {
        if (!this.playing) {
          sample.close()
          return
        }

        const pt = loopOffset + sample.timestamp
        this.queue.push({ sample, playbackTime: pt })

        // Pre-warm the next loop's decoder pipeline
        if (!prefetchStarted && sample.timestamp >= this.duration - PREFETCH_SEC) {
          prefetchStarted = true
          void this.startProducer(loopOffset + this.duration)
        }

        // Back-pressure: don't decode further than MAX_AHEAD_SEC ahead
        while (this.playing && pt > this.now + MAX_AHEAD_SEC) {
          await sleep(10)
        }
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
    // The queue is maintained in insertion order which is chronological because
    // each producer pushes frames in ascending timestamp order and the next
    // producer starts at a higher offset than the current one.
    let bestIdx = -1
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].playbackTime <= t) {
        bestIdx = i
      } else {
        break
      }
    }

    let displayedNewFrame = false
    if (bestIdx >= 0) {
      const { sample, playbackTime } = this.queue[bestIdx]
      displayedNewFrame = sample !== this.lastDrawnSample
      this.lastDrawnSample = sample

      // Detect and measure loop-boundary crossings
      const loopIdx = Math.floor(playbackTime / this.duration)
      if (loopIdx > this.lastRenderedLoopIndex && this.lastRenderedLoopIndex >= 0) {
        const expectedMs = this.startTime + loopIdx * this.duration * 1000
        this.loopGapMs = performance.now() - expectedMs
      }
      this.lastRenderedLoopIndex = Math.max(this.lastRenderedLoopIndex, loopIdx)

      // Draw with letterbox / pillarbox to fill the canvas
      this.drawFit(sample)

      // Release frames we've advanced past to free GPU memory
      for (let i = 0; i < bestIdx; i++) {
        this.queue[i].sample.close()
      }
      this.queue.splice(0, bestIdx)
    }

    const lastQueuedFrame = this.queue[this.queue.length - 1]
    const bufferAheadSec = lastQueuedFrame
      ? Math.max(0, lastQueuedFrame.playbackTime - t)
      : 0
    this.frameRateMonitor.record(timestamp, displayedNewFrame, bufferAheadSec)

    this.rafId = requestAnimationFrame(this.render)
  }

  /**
   * Draws `sample` centred in the canvas, preserving the video's aspect ratio
   * (letterbox or pillarbox as needed), with a black background.
   */
  private drawFit(sample: VideoSample): void {
    const cw = this.canvas.width
    const ch = this.canvas.height
    const vAspect = this.videoWidth / this.videoHeight
    const cAspect = cw / ch

    let dx = 0, dy = 0, dw = cw, dh = ch
    if (cAspect > vAspect) {
      dw = ch * vAspect
      dx = (cw - dw) / 2
    } else {
      dh = cw / vAspect
      dy = (ch - dh) / 2
    }

    this.ctx.fillStyle = '#000'
    this.ctx.fillRect(0, 0, cw, ch)
    sample.draw(this.ctx, dx, dy, dw, dh)
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
    player.start()

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
  if (document.visibilityState === 'visible' && currentPlayer) {
    void requestWakeLock()
  }
})

window.addEventListener('beforeunload', () => {
  void releaseWakeLock()
})

// ── Boot ──────────────────────────────────────

void restoreFileFromDb()
