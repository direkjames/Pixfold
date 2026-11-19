# Developing Pixfold

```powershell
npm install
npm run dev        # local dev server
npm test           # unit tests (drawing maths, history, canvas limits)
npm run build      # typecheck + production build into dist/
```

## Layout

| File | What it does |
|---|---|
| `src/doc.ts` | The pixel buffer (`Uint32Array`, 0xAABBGGRR), the 2000 px limit, `Stroke` (records touched pixels) and `History` (undo stack of changed pixels only, capped at 6M entries) |
| `src/raster.ts` | Pure algorithms: line, rectangle, ellipse, flood fill, pixel-perfect filter |
| `src/view.ts` | Canvas rendering, zoom steps, pan, grid and checkerboard |
| `src/io.ts` | PNG export, image import, File System Access with a download fallback |
| `src/store.ts` | IndexedDB autosave and `localStorage` preferences. Every call fails safe |
| `src/main.ts` | Tools, panels, menus, shortcuts and dialogs |
| `scripts/hero.mjs` | Makes the README hero images from the running app (headless Chrome) |

## Notes

- Colours are packed as little-endian ABGR so the buffer can be shared with `ImageData` without copying.
- A shape being dragged is drawn live and reverted pixel by pixel, so no overlay layer is needed.
- Zoom only snaps to fixed steps (25% to 6400%) so pixels never blur.
- The data model is single-layer for now. Frames and layers would add a dimension to `Doc`.

## Hero images

```powershell
npm run build
npx vite preview --port 4173
node scripts/hero.mjs
```

Set `CHROME` to a Chrome or Edge path if it is not in the default location.
