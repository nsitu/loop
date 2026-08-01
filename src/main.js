import './style.css'

document.querySelector('#app').innerHTML = `
  <main class="layout">
    <h1>Seamless Loop Video Player</h1>
    <p class="hint">Choose a local video and loop it with native or MSE playback.</p>

    <section class="controls">
      <label class="file-input">
        <span>Select video file</span>
        <input id="fileInput" type="file" accept="video/*" />
      </label>
      <button id="pickerButton" type="button">Pick & remember (where supported)</button>
      <label>
        Loop mode
        <select id="loopMode">
          <option value="native">Native &lt;video loop&gt;</option>
          <option value="mse">MSE continuous (fMP4)</option>
        </select>
      </label>
      <button id="fullscreenButton" type="button">Fullscreen</button>
    </section>

    <video id="player" controls loop muted autoplay playsinline></video>

    <section class="status" aria-live="polite">
      <p><strong>Loaded:</strong> <span id="fileName">None</span></p>
      <p><strong>Loop boundary gap:</strong> <span id="loopGap">Waiting…</span></p>
      <p><strong>Playback mode:</strong> <span id="modeStatus">Native</span></p>
      <p><strong>Recovery:</strong> <span id="recoveryStatus">Idle</span></p>
    </section>
  </main>
`

const fileInput = document.querySelector('#fileInput')
const pickerButton = document.querySelector('#pickerButton')
const loopMode = document.querySelector('#loopMode')
const fullscreenButton = document.querySelector('#fullscreenButton')
const player = document.querySelector('#player')
const fileName = document.querySelector('#fileName')
const loopGap = document.querySelector('#loopGap')
const modeStatus = document.querySelector('#modeStatus')
const recoveryStatus = document.querySelector('#recoveryStatus')

const DB_NAME = 'loop-player-db'
const STORE_NAME = 'settings'
const HANDLE_KEY = 'last-file-handle'

let selectedFile = null
let mediaSource = null
let sourceBuffer = null
let mseChunk = null
let wakeLock = null
let recovering = false
let frameWatcherActive = false
let lastFrame = null
let currentObjectUrl = null

const codecCandidates = [
  'video/mp4; codecs="avc1.64001e, mp4a.40.2"',
  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  'video/mp4; codecs="hvc1.1.6.L120.B0, mp4a.40.2"',
  'video/mp4'
]

function setStatus(message, target = recoveryStatus) {
  target.textContent = message
}

function setFileName(file) {
  fileName.textContent = file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : 'None'
}

function openDb() {
  if (!('indexedDB' in window)) {
    return Promise.resolve(null)
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function dbPut(key, value) {
  const db = await openDb()
  if (!db) return

  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(value, key)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

async function dbGet(key) {
  const db = await openDb()
  if (!db) return null

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error)
  })
}

function setVideoSource(source) {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl)
    currentObjectUrl = null
  }

  if (source instanceof MediaSource) {
    player.src = ''
    player.srcObject = source
  } else if (source instanceof Blob) {
    player.srcObject = null
    const blobUrl = URL.createObjectURL(source)
    if (!blobUrl.startsWith('blob:')) {
      URL.revokeObjectURL(blobUrl)
      throw new Error('Unexpected URL scheme from createObjectURL.')
    }
    currentObjectUrl = blobUrl
    player.src = currentObjectUrl
  } else if (!source) {
    player.srcObject = null
    player.src = ''
  } else {
    throw new Error('Unsupported video source type.')
  }
}

function teardownMse() {
  sourceBuffer = null
  mseChunk = null
  if (player.srcObject === mediaSource) {
    player.srcObject = null
    player.src = ''
  }

  if (mediaSource) {
    mediaSource.onsourceopen = null
    mediaSource = null
  }
}

function isLikelyFragmentedMp4(buffer) {
  const bytes = new Uint8Array(buffer)
  const maxScan = Math.min(bytes.length - 4, 512 * 1024)
  let foundMoof = false
  let foundMdat = false

  for (let i = 0; i < maxScan; i += 1) {
    if (bytes[i] === 0x6d && bytes[i + 1] === 0x6f && bytes[i + 2] === 0x6f && bytes[i + 3] === 0x66) {
      foundMoof = true
    }
    if (bytes[i] === 0x6d && bytes[i + 1] === 0x64 && bytes[i + 2] === 0x61 && bytes[i + 3] === 0x74) {
      foundMdat = true
    }
    if (foundMoof && foundMdat) return true
  }

  return false
}

function getSupportedCodec() {
  return codecCandidates.find((codec) => MediaSource.isTypeSupported(codec)) ?? null
}

function primeMseLoop() {
  if (!sourceBuffer || !mseChunk || sourceBuffer.updating) return

  const bufferedEnd = player.buffered.length ? player.buffered.end(player.buffered.length - 1) : 0
  const availableBuffer = bufferedEnd - player.currentTime

  if (availableBuffer < 4) {
    sourceBuffer.appendBuffer(mseChunk.slice(0))
  }
}

async function setupMsePlayback(file) {
  if (!('MediaSource' in window)) {
    setStatus('MSE is not available. Falling back to native loop.')
    return false
  }

  const codec = getSupportedCodec()
  if (!codec) {
    setStatus('No supported MP4 codec for MSE. Falling back to native loop.')
    return false
  }

  const buffer = await file.arrayBuffer()
  if (!isLikelyFragmentedMp4(buffer)) {
    setStatus('The selected file is not fragmented MP4. Falling back to native loop.')
    return false
  }

  teardownMse()
  mediaSource = new MediaSource()
  mseChunk = new Uint8Array(buffer)

  return new Promise((resolve) => {
    mediaSource.onsourceopen = () => {
      sourceBuffer = mediaSource.addSourceBuffer(codec)
      sourceBuffer.mode = 'sequence'
      sourceBuffer.addEventListener('updateend', primeMseLoop)
      sourceBuffer.appendBuffer(mseChunk.slice(0))
      resolve(true)
    }

    player.removeAttribute('loop')
    setVideoSource(mediaSource)
  })
}

function setupNativePlayback() {
  teardownMse()
  player.setAttribute('loop', '')
  setVideoSource(selectedFile)
  modeStatus.textContent = 'Native <video loop>'
}

async function activatePlaybackMode() {
  if (!selectedFile) return

  const resumeTime = player.currentTime || 0

  if (loopMode.value === 'mse') {
    const activated = await setupMsePlayback(selectedFile)
    if (activated) {
      modeStatus.textContent = 'MSE continuous append loop'
    } else {
      loopMode.value = 'native'
      setupNativePlayback()
    }
  } else {
    setupNativePlayback()
  }

  player.addEventListener(
    'loadedmetadata',
    () => {
      if (resumeTime > 0 && Number.isFinite(player.duration) && resumeTime < player.duration) {
        player.currentTime = resumeTime
      }
      player.play().catch(() => {
        setStatus('Autoplay blocked. Press play to start.')
      })
    },
    { once: true }
  )

  player.load()
}

async function setSelectedFile(file, handle = null) {
  selectedFile = file
  setFileName(file)
  setStatus('Ready')

  if (handle && 'indexedDB' in window) {
    try {
      await dbPut(HANDLE_KEY, handle)
    } catch {
      setStatus('Could not store file handle for later sessions.')
    }
  }

  await activatePlaybackMode()
}

async function restoreFileFromDb() {
  if (!('showOpenFilePicker' in window) || !('indexedDB' in window)) return

  try {
    const handle = await dbGet(HANDLE_KEY)
    if (!handle) return

    const permission = await handle.queryPermission({ mode: 'read' })
    if (permission !== 'granted') return

    const file = await handle.getFile()
    await setSelectedFile(file, handle)
    setStatus('Restored file handle from IndexedDB.')
  } catch {
    setStatus('No readable stored file handle found.')
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return

  try {
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', () => {
      wakeLock = null
    })
  } catch {
    setStatus('Screen wake lock unavailable on this device.')
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return
  await wakeLock.release()
  wakeLock = null
}

function monitorLoopBoundary() {
  if (frameWatcherActive || typeof player.requestVideoFrameCallback !== 'function') return

  frameWatcherActive = true
  const watch = (now, metadata) => {
    if (lastFrame && metadata.mediaTime + 0.05 < lastFrame.mediaTime && Number.isFinite(player.duration)) {
      const wrappedDelta = (player.duration - lastFrame.mediaTime) + metadata.mediaTime
      const expectedMs = wrappedDelta * 1000
      const observedMs = now - lastFrame.now
      const gapMs = observedMs - expectedMs
      loopGap.textContent = `${gapMs.toFixed(2)} ms`
    }

    lastFrame = { mediaTime: metadata.mediaTime, now }
    player.requestVideoFrameCallback(watch)
  }

  player.requestVideoFrameCallback(watch)
}

function scheduleRecovery(reason) {
  if (recovering || !selectedFile) return

  recovering = true
  setStatus(`Recovering from ${reason}...`)

  window.setTimeout(async () => {
    const resumeTime = player.currentTime || 0
    await activatePlaybackMode()

    player.addEventListener(
      'loadedmetadata',
      async () => {
        if (resumeTime > 0 && Number.isFinite(player.duration) && resumeTime < player.duration) {
          player.currentTime = resumeTime
        }

        try {
          await player.play()
          setStatus('Recovered')
        } catch {
          setStatus('Recovery requires user interaction.')
        }

        recovering = false
      },
      { once: true }
    )
  }, 300)
}

fileInput.addEventListener('change', async (event) => {
  const [file] = event.target.files || []
  if (file) {
    await setSelectedFile(file)
  }
})

pickerButton.addEventListener('click', async () => {
  if (!('showOpenFilePicker' in window)) {
    setStatus('File System Access API is not available in this browser.')
    return
  }

  try {
    const [handle] = await window.showOpenFilePicker({
      types: [
        {
          description: 'Video files',
          accept: {
            'video/*': ['.mp4', '.m4v', '.webm', '.mov']
          }
        }
      ],
      excludeAcceptAllOption: false,
      multiple: false
    })

    const file = await handle.getFile()
    await setSelectedFile(file, handle)
    setStatus('Loaded and saved handle in IndexedDB.')
  } catch {
    setStatus('Picker cancelled.')
  }
})

loopMode.addEventListener('change', () => {
  activatePlaybackMode().catch(() => {
    setStatus('Could not switch playback mode.')
  })
})

fullscreenButton.addEventListener('click', async () => {
  if (!document.fullscreenElement) {
    await player.requestFullscreen()
  } else {
    await document.exitFullscreen()
  }
})

player.addEventListener('play', () => {
  monitorLoopBoundary()
  requestWakeLock()
})

player.addEventListener('pause', releaseWakeLock)
player.addEventListener('ended', () => scheduleRecovery('ended state'))
player.addEventListener('stalled', () => scheduleRecovery('stall'))
player.addEventListener('error', () => scheduleRecovery('player error'))

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !player.paused) {
    requestWakeLock()
  }
})

window.addEventListener('beforeunload', () => {
  releaseWakeLock()
})

restoreFileFromDb()
