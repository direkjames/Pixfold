import { describe, expect, it } from 'vitest';
import { Doc, History, MAX_SIZE, Stroke, hexToU32, u32ToHex } from './doc';
import { ellipsePoints, floodFill, line, pixelPerfect, rectPoints } from './raster';

describe('raster', () => {
  it('line includes both ends and has no gaps', () => {
    const p = line(0, 0, 5, 2);
    expect(p[0]).toEqual({ x: 0, y: 0 });
    expect(p.at(-1)).toEqual({ x: 5, y: 2 });
    for (let i = 1; i < p.length; i++) {
      expect(Math.abs(p[i].x - p[i - 1].x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p[i].y - p[i - 1].y)).toBeLessThanOrEqual(1);
    }
  });
  it('line works for a single point and backwards', () => {
    expect(line(3, 3, 3, 3)).toEqual([{ x: 3, y: 3 }]);
    expect(line(4, 0, 0, 0).length).toBe(5);
  });
  it('rect outline and fill counts', () => {
    expect(rectPoints(0, 0, 3, 2, false).length).toBe(10);
    expect(rectPoints(0, 0, 3, 2, true).length).toBe(12);
    expect(rectPoints(2, 2, 2, 2, false).length).toBe(1);
  });
  it('ellipse stays inside its box, is symmetric, and outline is smaller than fill', () => {
    const f = ellipsePoints(0, 0, 8, 6, true), o = ellipsePoints(0, 0, 8, 6, false);
    expect(o.length).toBeLessThan(f.length);
    for (const p of f) {
      expect(p.x >= 0 && p.x <= 8 && p.y >= 0 && p.y <= 6).toBe(true);
      expect(f.some((q) => q.x === 8 - p.x && q.y === p.y)).toBe(true);
    }
  });
  it('pixel-perfect removes the L corner', () => {
    const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
    expect(pixelPerfect(path)).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    const straight = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    expect(pixelPerfect(straight)).toEqual(straight);
  });
  it('flood fill stays inside walls', () => {
    const w = 5, h = 5, d = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) d[y * w + 2] = 1; // wall down the middle
    expect(floodFill(d, w, h, 0, 0).length).toBe(10);
    expect(floodFill(d, w, h, 4, 4).length).toBe(10);
    expect(floodFill(d, w, h, 2, 2).length).toBe(5);
  });
});

describe('doc and history', () => {
  it('rejects canvases over the limit', () => {
    expect(() => new Doc(MAX_SIZE + 1, 10)).toThrow(RangeError);
    expect(() => new Doc(0, 10)).toThrow(RangeError);
    expect(() => new Doc(MAX_SIZE, MAX_SIZE)).not.toThrow();
  });
  it('colour packing round trips', () => {
    expect(u32ToHex(hexToU32('#12877f'))).toBe('#12877f');
  });
  it('undo and redo restore pixels', () => {
    const doc = new Doc(4, 4), h = new History(), red = hexToU32('#ff0000');
    const s = new Stroke(doc);
    s.set(0, red); s.set(5, red);
    h.push(s.commit('Pencil')!);
    expect(doc.data[5]).toBe(red);
    h.undo(doc);
    expect(doc.data[0]).toBe(0);
    h.redo(doc);
    expect(doc.data[0]).toBe(red);
  });
  it('a stroke that changes nothing makes no history entry', () => {
    const doc = new Doc(2, 2), s = new Stroke(doc);
    s.set(0, 0);
    expect(s.commit('Pencil')).toBeNull();
  });
  it('reverting a stroke restores the original', () => {
    const doc = new Doc(3, 3), s = new Stroke(doc);
    s.set(4, 9); s.revertAll();
    expect(doc.data[4]).toBe(0);
  });
  it('history drops the oldest entries over the cap and keeps position valid', () => {
    const doc = new Doc(10, 10), h = new History(5);
    for (let i = 0; i < 4; i++) {
      const s = new Stroke(doc);
      for (let k = 0; k < 3; k++) s.set(i * 3 + k, i + 1);
      h.push(s.commit('x')!);
    }
    expect(h.items.length).toBe(1);
    expect(h.pos).toBe(1);
  });
  it('a new stroke after undo discards the redo branch', () => {
    const doc = new Doc(4, 4), h = new History();
    for (const i of [0, 1]) { const s = new Stroke(doc); s.set(i, 7); h.push(s.commit('x')!); }
    h.undo(doc);
    const s = new Stroke(doc); s.set(2, 7); h.push(s.commit('y')!);
    expect(h.items.length).toBe(2);
    expect(h.redo(doc)).toBe(false);
  });
});
