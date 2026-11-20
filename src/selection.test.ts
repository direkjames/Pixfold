import { describe, expect, it } from 'vitest';
import { mirrorSpots } from './raster';
import {
  allMask, combine, decodeMask, eachInMask, encodeMask, flipClip, invertMask, liftClip, maskBox, maskCount,
  placeClip, polygonMask, rectMask, rotateClip, wandMask, type Clip,
} from './selection';

const W = 8, H = 6;
const at = (m: Uint8Array, x: number, y: number) => m[y * W + x];

describe('masks', () => {
  it('rect mask covers the box, in any drag direction, and clips to the canvas', () => {
    const m = rectMask(W, H, 5, 4, 2, 1);
    expect(maskCount(m)).toBe(4 * 4);
    expect(maskBox(m, W, H)).toEqual({ x0: 2, y0: 1, x1: 5, y1: 4 });
    expect(maskCount(rectMask(W, H, -3, -3, 1, 1))).toBe(4);
    expect(maskCount(rectMask(W, H, 6, 4, 20, 20))).toBe(2 * 2);
  });
  it('polygon fills its inside and keeps its outline', () => {
    const tri = polygonMask(W, H, [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 5 }]);
    expect(at(tri, 1, 1)).toBe(1);
    expect(at(tri, 6, 5)).toBe(0);
    expect(at(tri, 0, 5)).toBe(1); // a corner of the outline
    const thin = polygonMask(W, H, [{ x: 1, y: 1 }, { x: 5, y: 1 }]);
    expect(maskCount(thin)).toBe(5); // a flat loop is just its line
  });
  it('polygon of a rectangle matches the rectangle', () => {
    const p = polygonMask(W, H, [{ x: 2, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 4 }, { x: 2, y: 4 }]);
    expect(Array.from(p)).toEqual(Array.from(rectMask(W, H, 2, 1, 5, 4)));
  });
  it('wand: touching vs everywhere', () => {
    const px = new Uint32Array(W * H);
    for (let y = 0; y < H; y++) px[y * W + 3] = 7; // a wall splits the empty area in two
    expect(maskCount(wandMask(px, W, H, 0, 0, true))).toBe(3 * H);
    expect(maskCount(wandMask(px, W, H, 0, 0, false))).toBe((W - 1) * H);
    expect(maskCount(wandMask(px, W, H, 3, 2, true))).toBe(H);
    expect(maskCount(wandMask(px, W, H, -1, 0, true))).toBe(0);
  });
  it('add, remove and replace', () => {
    const a = rectMask(W, H, 0, 0, 3, 3), b = rectMask(W, H, 2, 2, 5, 5);
    expect(maskCount(combine(a, b, 'add')!)).toBe(16 + 16 - 4);
    expect(maskCount(combine(a, b, 'sub')!)).toBe(16 - 4);
    expect(maskCount(combine(a, b, 'replace')!)).toBe(16);
    expect(combine(a, a, 'sub')).toBeNull();
    expect(combine(null, b, 'sub')).toBeNull();
    expect(maskCount(combine(null, b, 'add')!)).toBe(16);
  });
  it('invert flips every pixel, and all-selected inverts to nothing', () => {
    const m = rectMask(W, H, 0, 0, 1, 1);
    expect(maskCount(invertMask(m)!)).toBe(W * H - 4);
    expect(invertMask(allMask(W, H))).toBeNull();
  });
  it('run-length history form round trips, including empty and full', () => {
    for (const m of [rectMask(W, H, 1, 1, 6, 3), allMask(W, H), polygonMask(W, H, [{ x: 0, y: 0 }, { x: 7, y: 2 }, { x: 3, y: 5 }])]) {
      expect(Array.from(decodeMask(encodeMask(m), W * H)!)).toEqual(Array.from(m));
    }
    expect(encodeMask(null)).toBeNull();
    expect(decodeMask(null, 10)).toBeNull();
    expect(encodeMask(rectMask(W, H, 0, 0, 7, 5))!.length).toBe(2); // one run
  });
  it('visits each selected pixel once', () => {
    let n = 0;
    eachInMask(rectMask(W, H, 1, 1, 3, 2), W, H, () => n++);
    expect(n).toBe(6);
  });
});

function makeClip(): Clip {
  // 3 wide, 2 high:  1 2 3 / 4 5 6   (all selected), placed at (2, 1)
  return { x: 2, y: 1, w: 3, h: 2, px: Uint32Array.from([0xff000001, 0xff000002, 0xff000003, 0xff000004, 0xff000005, 0xff000006]), mask: new Uint8Array(6).fill(1) };
}
const grid = (c: Clip) => Array.from(c.px).map((v) => v & 255);

describe('clips', () => {
  it('lifting crops to the selection and copies only selected pixels', () => {
    const px = new Uint32Array(W * H);
    px[1 * W + 2] = 0xff000009; px[1 * W + 3] = 0xff00000a; px[4 * W + 7] = 0xff00000b;
    const c = liftClip(px, rectMask(W, H, 2, 1, 3, 2), W, H)!;
    expect([c.x, c.y, c.w, c.h]).toEqual([2, 1, 2, 2]);
    expect(grid(c)).toEqual([9, 10, 0, 0]);
    expect(liftClip(px, new Uint8Array(W * H), W, H)).toBeNull();
  });
  it('flips mirror the pixels and flipping twice restores them', () => {
    const c = makeClip();
    expect(grid(flipClip(c, 'h'))).toEqual([3, 2, 1, 6, 5, 4]);
    expect(grid(flipClip(c, 'v'))).toEqual([4, 5, 6, 1, 2, 3]);
    expect(grid(flipClip(flipClip(c, 'h'), 'h'))).toEqual(grid(c));
  });
  it('rotating swaps the box size and four turns come back', () => {
    const c = makeClip();
    const cw = rotateClip(c, 'cw');
    expect([cw.w, cw.h]).toEqual([2, 3]);
    expect(grid(cw)).toEqual([4, 1, 5, 2, 6, 3]);
    expect(grid(rotateClip(c, 'ccw'))).toEqual([3, 6, 2, 5, 1, 4]);
    expect(grid(rotateClip(c, '180'))).toEqual([6, 5, 4, 3, 2, 1]);
    let r = c;
    for (let i = 0; i < 4; i++) r = rotateClip(r, 'cw');
    expect(grid(r)).toEqual(grid(c));
    expect([r.x, r.y, r.w, r.h]).toEqual([c.x, c.y, c.w, c.h]);
    expect(grid(rotateClip(rotateClip(c, 'cw'), 'ccw'))).toEqual(grid(c));
  });
  it('rotating keeps the middle of the box where it was', () => {
    const c = makeClip(); // box x 2..4, y 1..2, middle at (3.5, 2)
    const r = rotateClip(c, 'cw'); // 2 wide, 3 high
    expect(Math.abs(r.x + r.w / 2 - (c.x + c.w / 2))).toBeLessThanOrEqual(0.5); // at most half a pixel off
    expect(Math.abs(r.y + r.h / 2 - (c.y + c.h / 2))).toBeLessThanOrEqual(0.5);
  });
  it('placing shifts the pixels, drops what leaves the canvas and skips transparent ones', () => {
    const c = makeClip();
    const p = placeClip(c, 1, 1, W, H);
    expect(p.idx).toEqual([2 * W + 3, 2 * W + 4, 2 * W + 5, 3 * W + 3, 3 * W + 4, 3 * W + 5]);
    expect(maskCount(p.mask)).toBe(6);
    const edge = placeClip(c, 4, 0, W, H); // x 6..8: the last column falls off
    expect(edge.idx.length).toBe(4);
    const t = { ...c, px: Uint32Array.from([0, 0xff000002, 0, 0, 0, 0]) };
    const tp = placeClip(t, 0, 0, W, H);
    expect(tp.idx.length).toBe(1);
    expect(maskCount(tp.mask)).toBe(6); // the shape still counts
  });
});

describe('mirror', () => {
  it('mirrors across the centre of even and odd sizes', () => {
    expect(mirrorSpots(1, 2, 8, 6, true, false)).toEqual([{ x: 1, y: 2 }, { x: 6, y: 2 }]);
    expect(mirrorSpots(1, 2, 8, 6, false, true)).toEqual([{ x: 1, y: 2 }, { x: 1, y: 3 }]);
    expect(mirrorSpots(1, 2, 8, 6, true, true).length).toBe(4);
    expect(mirrorSpots(1, 2, 8, 6, false, false)).toEqual([{ x: 1, y: 2 }]);
  });
  it('the middle pixel of an odd canvas has no separate mirror image', () => {
    expect(mirrorSpots(2, 2, 5, 5, true, true)).toEqual([{ x: 2, y: 2 }]);
    expect(mirrorSpots(2, 0, 5, 5, true, true).length).toBe(2);
  });
});
