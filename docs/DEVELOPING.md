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
| `src/selection.ts` | Pure selection logic: masks (rectangle, lasso, wand, add/remove/invert), run-length form for history, and clips (lift, flip, rotate, place) |
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
- Selection is one canvas-sized byte mask in `main.ts`, not saved in project files. Every drawing write goes through `put()`, which applies mirroring and clips to the selection. History entries that touch pixels and the selection together are layer entries made by `selEntry` (the mask is stored run-length encoded, so big selections stay small).
- Dragging a piece re-draws it live through a `Stroke` (a Map entry per pixel), so pieces over 600k opaque pixels refuse to drag and move with the arrow keys instead. Delete, paste, rotate, nudge and clear use `bulkChange`, which builds typed undo arrays directly and handles a fully painted 2000x2000 layer in about 0.3 s.
- Selection and clipboard are not part of the system clipboard: Copy and Paste work inside Pixfold only.
- Animation frames would add a dimension to each layer's pixels.

## Hosting and deploying

The site is on GitHub Pages at https://direkjames.github.io/Pixfold/. A push to `master` runs `.github/workflows/pages.yml` (install, tests, build, publish `dist/`), so a failing test blocks the deploy. Settings → Pages must stay on **GitHub Actions**: in "deploy from branch" mode the raw source `index.html` is served and the page shows as bare HTML. Never commit `dist/`.

`vite.config.ts` sets `base: './'` so the build works under `/Pixfold/`, and adds a Content-Security-Policy meta tag to the build only (Pages cannot send headers). The policy allows only the app's own files, so `assetsInlineLimit: 0` keeps the small fonts as files: inlined `data:` fonts are blocked by it. Check the console for policy errors after any change to assets.

Autosave stores a compressed `.pfold` blob in IndexedDB (key `current`, `v: 3`). Saves from 0.1 and 0.2 still load.

## Hero images and social preview

```powershell
npm run build
npx vite preview --port 4173
node scripts/hero.mjs
```

Set `CHROME` to a Chrome or Edge path if it is not in the default location. The script also writes `docs/screenshots/og.png`; copy it to `public/og.png` for the social preview.
