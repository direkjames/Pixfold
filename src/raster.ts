// Pure pixel algorithms. No DOM, so they are easy to test.
export interface Pt { x: number; y: number }

/** Bresenham line, both end points included. */
export function line(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const pts: Pt[] = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

export function rectPoints(ax: number, ay: number, bx: number, by: number, filled: boolean): Pt[] {
  const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
  const pts: Pt[] = [];
  for (let y = y0; y <= y1; y++) {
    const edgeRow = y === y0 || y === y1;
    if (filled || edgeRow) for (let x = x0; x <= x1; x++) pts.push({ x, y });
    else { pts.push({ x: x0, y }); if (x1 !== x0) pts.push({ x: x1, y }); }
  }
  return pts;
}

/** Ellipse inscribed in the box (ax,ay)-(bx,by). Outline = filled pixels that touch an empty one. */
export function ellipsePoints(ax: number, ay: number, bx: number, by: number, filled: boolean): Pt[] {
  const x0 = Math.min(ax, bx), y0 = Math.min(ay, by);
  const w = Math.abs(bx - ax) + 1, h = Math.abs(by - ay) + 1;
  const inside = new Uint8Array(w * h);
  const cx = (w - 1) / 2, cy = (h - 1) / 2, rx = w / 2, ry = h / 2;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const dx = (i - cx) / rx, dy = (j - cy) / ry;
    if (dx * dx + dy * dy <= 1) inside[j * w + i] = 1;
  }
  const at = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && inside[j * w + i] === 1;
  const pts: Pt[] = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (!inside[j * w + i]) continue;
    if (filled || !(at(i - 1, j) && at(i + 1, j) && at(i, j - 1) && at(i, j + 1))) pts.push({ x: x0 + i, y: y0 + j });
  }
  return pts;
}

/** Three points make an "L" when the middle one is a corner pixel that pixel-perfect drawing drops. */
export function isCorner(a: Pt, b: Pt, c: Pt): boolean {
  if (Math.abs(a.x - c.x) !== 1 || Math.abs(a.y - c.y) !== 1) return false;
  return (b.x === a.x && b.y === c.y) || (b.y === a.y && b.x === c.x);
}

/** Add a point to a path; returns the corner point that was removed, if any. */
export function pushPerfect(path: Pt[], p: Pt): Pt | null {
  path.push(p);
  const n = path.length;
  if (n >= 3 && isCorner(path[n - 3], path[n - 2], path[n - 1])) return path.splice(n - 2, 1)[0];
  return null;
}

export function pixelPerfect(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) pushPerfect(out, p);
  return out;
}

/** Indices of the connected region (4-way) that has the same colour as the start pixel. */
export function floodFill(data: Uint32Array, w: number, h: number, sx: number, sy: number): Uint32Array {
  const target = data[sy * w + sx];
  const seen = new Uint8Array(w * h);
  const out: number[] = [];
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    const row = y * w;
    if (seen[row + x] || data[row + x] !== target) continue;
    while (x > 0 && !seen[row + x - 1] && data[row + x - 1] === target) x--;
    let up = false, down = false;
    while (x < w && !seen[row + x] && data[row + x] === target) {
      seen[row + x] = 1;
      out.push(row + x);
      if (y > 0) {
        const ok = data[row - w + x] === target && !seen[row - w + x];
        if (ok && !up) { stack.push(x, y - 1); up = true; } else if (!ok) up = false;
      }
      if (y < h - 1) {
        const ok = data[row + w + x] === target && !seen[row + w + x];
        if (ok && !down) { stack.push(x, y + 1); down = true; } else if (!ok) down = false;
      }
      x++;
    }
  }
  return Uint32Array.from(out);
}
