# loop

Web-based local video player focused on seamless looping.

## Features

- Local file selection with `<input type="file">`
- Optional File System Access picker with IndexedDB handle persistence
- Native loop mode using `<video loop muted autoplay playsinline>`
- Loop-boundary gap measurement via `requestVideoFrameCallback`
- Experimental MSE continuous mode for fragmented MP4 (`fMP4`) files
- Fullscreen toggle, wake-lock support, and playback auto-recovery

## Renderer backends

Playback uses WebGL2 by default, with WebGL1 fallback. The WebGL2 path keeps
texture storage and quad geometry resident instead of reallocating them for
each frame.

WebGPU can be tested on a supported secure origin with:

```text
?renderer=webgpu
```

If WebGPU is unavailable, the explicit WebGPU mode reports an error rather
than silently changing the renderer being measured.

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

## GitHub Pages

A workflow in `.github/workflows/deploy-pages.yml` builds and deploys `dist/` to GitHub Pages on pushes to `main`.
