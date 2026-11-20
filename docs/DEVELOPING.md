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
| `src/doc.ts` | `Doc` (layers plus the flattened picture in `doc.data`, 0xAABBGGRR), the 2000 px limit, the layer limit (`maxLayers`), layer actions that return undo entries, `Stroke` (records touched pixels on one layer) and `History` (undo stack, capped at 6M entries) |
| `src/composite.ts` | Pure colour maths: blend modes and opacity |
| `src/project.ts` | The `.pfold` project file: encode, decode, validation |
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
- `doc.data` is always the flattened result. Tools write to the active layer through `doc.setPx`, which updates that one pixel of the flattened picture, so views, export and colour counts never see layers.
- History has two kinds of entry: changed pixels on a layer (by layer id), and layer actions (closures with a `weight` for the memory cap). Visibility and lock toggles are not in history, as in Aseprite.
- `.pfold` layout: `PFLD` + version byte, then gzip of `[u32 JSON length][JSON][raw RGBA bytes per layer, bottom first]`. The decoder checks the exact size and caps unpacked data at 700 MB. Bump the version byte for any format change.
- Autosave (IndexedDB key `current`) holds all layers; drawings saved by 0.1 (one `buffer`) still load as a single layer.
- Animation frames would add a dimension to each layer's pixels.

## Hero images

```powershell
npm run build
npx vite preview --port 4173
node scripts/hero.mjs
```

Set `CHROME` to a Chrome or Edge path if it is not in the default location.
