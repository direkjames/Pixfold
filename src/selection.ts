// Pure selection logic: masks, lasso, magic wand, and lifted pieces ("clips") that can be moved, flipped and rotated.
// A mask is canvas sized, 1 = selected. No DOM here, so all of it is tested.
import { floodFill, line, type Pt } from './raster';

export type Mask = Uint8Array;
export type SelMode = 'replace' | 'add' | 'sub';
export interface Box { x0: number; y0: number; x1: number; y1: number }

export const allMask = (W: number, H: number): Mask => new Uint8Array(W * H).fill(1);

export function rectMask(W: number, H: number, ax: number, ay: number, bx: number, by: number): Mask {
  const m = new Uint8Array(W * H);
  const x0 = Math.max(0, Math.min(ax, bx)), x1 = Math.min(W - 1, Math.max(ax, bx));
  const y0 = Math.max(0, Math.min(ay, by)), y1 = Math.min(H - 1, Math.max(ay, by));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * W + x] = 1;
  return m;
}

/** Fill the inside of a freehand outline (even-odd rule). The outline pixels themselves are selected too, so thin loops still work. */
export function polygonMask(W: number, H: number, pts: Pt[]): Mask {
  const m = new Uint8Array(W * H);
  if (!pts.length) return m;
  const mark = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < W && y < H) m[y * W + x] = 1; };
  const n = pts.length;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (const p of line(a.x, a.y, b.x, b.y)) mark(p.x, p.y);
    minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
  }
  for (let y = Math.max(0, minY); y <= Math.min(H - 1, maxY); y++) {
    const yc = y + 0.5, xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (a.y === b.y) continue;
      const ya = a.y + 0.5, yb = b.y + 0.5;
      if (yc < Math.min(ya, yb) || yc >= Math.max(ya, yb)) continue;
      xs.push(a.x + 0.5 + ((yc - ya) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5)), to = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      for (let x = from; x <= to; x++) m[y * W + x] = 1;
    }
  }
  return m;
}

/** Magic wand: pixels with exactly the colour under the click, touching it or anywhere on the layer. */
export function wandMask(px: Uint32Array, W: number, H: number, x: number, y: number, contiguous: boolean): Mask {
  const m = new Uint8Array(W * H);
  if (x < 0 || y < 0 || x >= W || y >= H) return m;
  if (contiguous) for (const i of floodFill(px, W, H, x, y)) m[i] = 1;
  else { const t = px[y * W + x]; for (let i = 0; i < px.length; i++) if (px[i] === t) m[i] = 1; }
  return m;
}

export function maskCount(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
}

export function maskBox(m: Mask, W: number, H: number): Box | null {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!m[y * W + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Run `fn` for every selected pixel index. */
export function eachInMask(m: Mask, W: number, H: number, fn: (i: number) => void) {
  const b = maskBox(m, W, H);
  if (!b) return;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { const i = y * W + x; if (m[i]) fn(i); }
}

/** Combine the current selection with a new shape. Returns null when nothing is left selected. */
export function combine(a: Mask | null, b: Mask, mode: SelMode): Mask | null {
  let out: Mask;
  if (mode === 'replace' || !a) out = mode === 'sub' ? new Uint8Array(b.length) : b.slice();
  else {
    out = new Uint8Array(a.length);
    if (mode === 'add') for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
    else for (let i = 0; i < a.length; i++) out[i] = a[i] && !b[i] ? 1 : 0;
  }
  return maskCount(out) ? out : null;
}

export function invertMask(m: Mask): Mask | null {
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = m[i] ? 0 : 1;
  return maskCount(out) ? out : null;
}

/** Run-length form for undo history: [start, length, start, length, ...]. Selections are usually a few big runs. */
export function encodeMask(m: Mask | null): Uint32Array | null {
  if (!m) return null;
  const runs: number[] = [];
  for (let i = 0; i < m.length;) {
    if (!m[i]) { i++; continue; }
    let j = i;
    while (j < m.length && m[j]) j++;
    runs.push(i, j - i);
    i = j;
  }
  return Uint32Array.from(runs);
}
export function decodeMask(r: Uint32Array | null, n: number): Mask | null {
  if (!r) return null;
  const m = new Uint8Array(n);
  for (let k = 0; k < r.length; k += 2) m.fill(1, r[k], r[k] + r[k + 1]);
  return m;
}

/** A selected piece cut out of a layer: pixels and shape, cropped to the selection's box (which sits at x, y on the canvas). */
export interface Clip { x: number; y: number; w: number; h: number; px: Uint32Array; mask: Mask }

export function liftClip(px: Uint32Array, mask: Mask, W: number, H: number): Clip | null {
  const b = maskBox(mask, W, H);
  if (!b) return null;
  const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
  const cp = new Uint32Array(w * h), cm = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (b.y0 + y) * W + b.x0 + x;
    if (mask[s]) { cp[y * w + x] = px[s]; cm[y * w + x] = 1; }
  }
  return { x: b.x0, y: b.y0, w, h, px: cp, mask: cm };
}

export function flipClip(c: Clip, axis: 'h' | 'v'): Clip {
  const px = new Uint32Array(c.px.length), mask = new Uint8Array(c.mask.length);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const nx = axis === 'h' ? c.w - 1 - x : x, ny = axis === 'v' ? c.h - 1 - y : y;
    px[ny * c.w + nx] = c.px[y * c.w + x]; mask[ny * c.w + nx] = c.mask[y * c.w + x];
  }
  return { ...c, px, mask };
}

/** Rotate by 90 degrees (or 180) around the middle of the piece's box. */
export function rotateClip(c: Clip, dir: 'cw' | 'ccw' | '180'): Clip {
  if (dir === '180') {
    const px = new Uint32Array(c.px.length), mask = new Uint8Array(c.mask.length);
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const i = (c.h - 1 - y) * c.w + (c.w - 1 - x);
      px[i] = c.px[y * c.w + x]; mask[i] = c.mask[y * c.w + x];
    }
    return { ...c, px, mask };
  }
  const w = c.h, h = c.w, px = new Uint32Array(w * h), mask = new Uint8Array(w * h);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    const nx = dir === 'cw' ? c.h - 1 - y : y, ny = dir === 'cw' ? x : c.w - 1 - x;
    px[ny * w + nx] = c.px[y * c.w + x]; mask[ny * w + nx] = c.mask[y * c.w + x];
  }
  // Truncating (not rounding) the half pixel an odd/even box leaves means two turns undo each other instead of drifting.
  return { x: c.x + Math.trunc((c.w - c.h) / 2), y: c.y + Math.trunc((c.h - c.w) / 2), w, h, px, mask };
}

/**
 * Where a clip's pixels land when shifted by (dx, dy) on a W x H canvas. Transparent source pixels write nothing
 * (so they never wipe what is underneath); the new selection shape still includes them. Off-canvas parts are dropped.
 */
export function placeClip(c: Clip, dx: number, dy: number, W: number, H: number) {
  const idx: number[] = [], color: number[] = [], mask = new Uint8Array(W * H);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    if (!c.mask[y * c.w + x]) continue;
    const tx = c.x + dx + x, ty = c.y + dy + y;
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    const i = ty * W + tx, col = c.px[y * c.w + x];
    mask[i] = 1;
    if (col >>> 24) { idx.push(i); color.push(col); }
  }
  return { idx, color, mask };
}
