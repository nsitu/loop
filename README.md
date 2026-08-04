# loop

Web-based local video player focused on seamless looping.

## Features

- Local file selection with `<input type="file">`
- Optional File System Access picker with IndexedDB handle persistence
- Native MSE loop mode: Mediabunny packages the selected video as CMAF/fMP4,
  then the browser's hardware-backed `<video>` element plays repeated segments
  on one continuous timeline
- Loop-boundary gap measurement via `requestVideoFrameCallback`
- WebCodecs + WebGL2 fallback when MSE cannot package or play the source codec
- Fullscreen toggle, wake-lock support, and playback auto-recovery

## Renderer backends

Playback first tries native MSE. Mediabunny packages the encoded video packets
into a CMAF/fMP4 init segment and media segment; MSE appends repeated copies
with timestamp offsets while native video decoding and presentation remain in
the browser's media pipeline. If that path is unavailable, playback uses
WebGL2 by default, with WebGL1 fallback. The WebGL2 path keeps texture storage
and quad geometry resident instead of reallocating them for each frame.

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
