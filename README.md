# loop

Web-based local video player focused on seamless looping.

## Features

- Local file selection with `<input type="file">`
- Optional File System Access picker with IndexedDB handle persistence
- Native loop mode using `<video loop muted autoplay playsinline>`
- Loop-boundary gap measurement via `requestVideoFrameCallback`
- Experimental MSE continuous mode for fragmented MP4 (`fMP4`) files
- Fullscreen toggle, wake-lock support, and playback auto-recovery

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
