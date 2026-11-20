import { describe, expect, it } from 'vitest';
import { blendPixel } from './composite';
import { Doc, History, MAX_SIZE, Stroke, hexToU32, maxLayers, u32ToHex } from './doc';
import { ProjectError, decodeProject, encodeProject } from './project';
import { ellipsePoints, floodFill, line, pixelPerfect, rectPoints } from './raster';

const RED = hexToU32('#ff0000'), BLUE = hexToU32('#0000ff'), GREEN = hexToU32('#00ff00');

function paint(doc: Doc, px: number[], c: number, name = 'Pencil') {
  const s = new Stroke(doc, doc.layer);
  for (const i of px) s.set(i, c);
  return s.commit(name)!;
}

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
    for (let y = 0; y < h; y++) d[y * w + 2] = 1;
    expect(floodFill(d, w, h, 0, 0).length).toBe(10);
    expect(floodFill(d, w, h, 4, 4).length).toBe(10);
    expect(floodFill(d, w, h, 2, 2).length).toBe(5);
  });
});

describe('blending', () => {
  it('opaque normal replaces, transparent keeps', () => {
    expect(blendPixel(BLUE, RED, 100, 'normal')).toBe(RED);
    expect(blendPixel(BLUE, 0, 100, 'normal')).toBe(BLUE);
    expect(blendPixel(BLUE, RED, 0, 'normal')).toBe(BLUE);
  });
  it('50% opacity mixes the colours', () => {
    const m = blendPixel(BLUE, RED, 50, 'normal');
    expect(m & 255).toBe(128);
    expect((m >>> 16) & 255).toBe(128);
    expect(m >>> 24).toBe(255);
  });
  it('over transparent, opacity only lowers alpha', () => {
    const m = blendPixel(0, RED, 50, 'normal');
    expect(m & 255).toBe(255);
    expect(m >>> 24).toBe(128);
  });
  it('multiply with white keeps the base, with black gives black', () => {
    const base = hexToU32('#336699');
    expect(blendPixel(base, hexToU32('#ffffff'), 100, 'multiply')).toBe(base);
    expect(blendPixel(base, hexToU32('#000000'), 100, 'multiply')).toBe(hexToU32('#000000'));
  });
  it('screen with black keeps the base; darken and lighten pick per channel', () => {
    const base = hexToU32('#336699');
    expect(blendPixel(base, hexToU32('#000000'), 100, 'screen')).toBe(base);
    expect(blendPixel(hexToU32('#ff0000'), hexToU32('#0000ff'), 100, 'darken')).toBe(hexToU32('#000000'));
    expect(blendPixel(hexToU32('#ff0000'), hexToU32('#0000ff'), 100, 'lighten')).toBe(hexToU32('#ff00ff'));
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
    const doc = new Doc(4, 4), h = new History();
    h.push(paint(doc, [0, 5], RED));
    expect(doc.data[5]).toBe(RED);
    h.undo(doc);
    expect(doc.data[0]).toBe(0);
    h.redo(doc);
    expect(doc.data[0]).toBe(RED);
  });
  it('a stroke that changes nothing makes no history entry', () => {
    const doc = new Doc(2, 2), s = new Stroke(doc, doc.layer);
    s.set(0, 0);
    expect(s.commit('Pencil')).toBeNull();
  });
  it('reverting a stroke restores the original', () => {
    const doc = new Doc(3, 3), s = new Stroke(doc, doc.layer);
    s.set(4, 9); s.revertAll();
    expect(doc.layer.px[4]).toBe(0);
    expect(doc.data[4]).toBe(0);
  });
  it('history drops the oldest entries over the cap and keeps position valid', () => {
    const doc = new Doc(10, 10), h = new History(5);
    for (let i = 0; i < 4; i++) h.push(paint(doc, [i * 3, i * 3 + 1, i * 3 + 2], i + 1, 'x'));
    expect(h.items.length).toBe(1);
    expect(h.pos).toBe(1);
  });
  it('a new stroke after undo discards the redo branch', () => {
    const doc = new Doc(4, 4), h = new History();
    h.push(paint(doc, [0], 7, 'x')); h.push(paint(doc, [1], 7, 'x'));
    h.undo(doc);
    h.push(paint(doc, [2], 7, 'y'));
    expect(h.items.length).toBe(2);
    expect(h.redo(doc)).toBe(false);
  });
});

describe('layers', () => {
  it('draws only on the active layer and flattens in order', () => {
    const doc = new Doc(2, 2);
    doc.addLayer();
    expect(doc.layers.length).toBe(2);
    expect(doc.active).toBe(1);
    paint(doc, [0], RED);
    expect(doc.layers[0].px[0]).toBe(0);
    expect(doc.data[0]).toBe(RED);
  });
  it('a hidden layer does not show, and showing it again restores it', () => {
    const doc = new Doc(2, 2);
    paint(doc, [0], RED);
    doc.setProp(doc.layer, 'visible', false);
    expect(doc.data[0]).toBe(0);
    doc.setProp(doc.layer, 'visible', true);
    expect(doc.data[0]).toBe(RED);
  });
  it('upper layers cover lower ones', () => {
    const doc = new Doc(2, 2);
    paint(doc, [0], RED);
    doc.addLayer();
    paint(doc, [0], BLUE);
    expect(doc.data[0]).toBe(BLUE);
    doc.setProp(doc.layer, 'opacity', 0);
    expect(doc.data[0]).toBe(RED);
  });
  it('add, delete and move can be undone and redone', () => {
    const doc = new Doc(2, 2), h = new History();
    paint(doc, [0], RED);
    h.push(doc.addLayer()!);
    paint(doc, [1], BLUE);
    h.push(doc.moveLayer(1, 0)!);
    expect(doc.layers[0].px[1]).toBe(BLUE);
    h.push(doc.deleteLayer()!);
    expect(doc.layers.length).toBe(1);
    h.undo(doc); // delete
    expect(doc.layers.length).toBe(2);
    expect(doc.data[1]).toBe(BLUE);
    h.undo(doc); // move
    expect(doc.layers[1].px[1]).toBe(BLUE);
    h.undo(doc); // add
    expect(doc.layers.length).toBe(1);
    h.redo(doc);
    expect(doc.layers.length).toBe(2);
  });
  it('cannot delete the last layer or merge the bottom layer', () => {
    const doc = new Doc(2, 2);
    expect(doc.deleteLayer()).toBeNull();
    expect(doc.mergeDown()).toBeNull();
  });
  it('merge down combines the pixels and undo restores both layers', () => {
    const doc = new Doc(2, 2), h = new History();
    paint(doc, [0], RED);
    doc.addLayer();
    paint(doc, [1], BLUE);
    h.push(doc.mergeDown()!);
    expect(doc.layers.length).toBe(1);
    expect(doc.layers[0].px[0]).toBe(RED);
    expect(doc.layers[0].px[1]).toBe(BLUE);
    h.undo(doc);
    expect(doc.layers.length).toBe(2);
    expect(doc.layers[0].px[1]).toBe(0);
    expect(doc.layers[1].px[1]).toBe(BLUE);
    expect(doc.data[1]).toBe(BLUE);
  });
  it('duplicate copies the pixels', () => {
    const doc = new Doc(2, 2);
    paint(doc, [3], GREEN);
    const e = doc.duplicateLayer()!;
    expect(doc.layers.length).toBe(2);
    expect(doc.layer.px[3]).toBe(GREEN);
    e.undo();
    expect(doc.layers.length).toBe(1);
  });
  it('property changes are undoable', () => {
    const doc = new Doc(2, 2), h = new History();
    paint(doc, [0], RED);
    doc.addLayer();
    paint(doc, [0], BLUE);
    const L = doc.layer;
    doc.setProp(L, 'opacity', 0);
    h.push(doc.propChange(L, 'opacity', 100, 0, 'Layer opacity'));
    expect(doc.data[0]).toBe(RED);
    h.undo(doc);
    expect(doc.data[0]).toBe(BLUE);
  });
  it('undoing a stroke on a lower layer still works after other layers were added', () => {
    const doc = new Doc(2, 2), h = new History();
    h.push(paint(doc, [0], RED));
    h.push(doc.addLayer()!);
    h.undo(doc);
    h.undo(doc);
    expect(doc.layers[0].px[0]).toBe(0);
  });
  it('the layer limit shrinks as the canvas grows', () => {
    expect(maxLayers(16, 16)).toBe(100);
    expect(maxLayers(2000, 2000)).toBeLessThan(40);
    expect(maxLayers(2000, 2000)).toBeGreaterThanOrEqual(2);
  });
  it('refuses to add layers past the limit', () => {
    const doc = new Doc(2000, 2000);
    const max = maxLayers(2000, 2000);
    for (let i = 1; i < max; i++) expect(doc.addLayer()).not.toBeNull();
    expect(doc.addLayer()).toBeNull();
  });
});

describe('project file', () => {
  it('round trips layers and their settings', async () => {
    const doc = new Doc(3, 2);
    paint(doc, [0, 4], RED);
    doc.addLayer();
    paint(doc, [1], BLUE);
    doc.setProp(doc.layer, 'opacity', 60);
    doc.setProp(doc.layer, 'blend', 'multiply');
    doc.setProp(doc.layer, 'name', 'Shade');
    const back = await decodeProject(await encodeProject(doc, ['#ff0000', '#00ff00']));
    expect(back.doc.w).toBe(3);
    expect(back.doc.layers.length).toBe(2);
    expect(back.doc.layers[0].px[4]).toBe(RED);
    expect(back.doc.layers[1].px[1]).toBe(BLUE);
    expect(back.doc.layers[1].opacity).toBe(60);
    expect(back.doc.layers[1].blend).toBe('multiply');
    expect(back.doc.layers[1].name).toBe('Shade');
    expect(back.doc.active).toBe(1);
    expect(back.palette).toEqual(['#ff0000', '#00ff00']);
    expect(Array.from(back.doc.data)).toEqual(Array.from(doc.data));
  });
  it('rejects files that are not projects, are cut short, or are altered', async () => {
    const good = new Uint8Array(await (await encodeProject(new Doc(4, 4), [])).arrayBuffer());
    const bad = (bytes: Uint8Array) => decodeProject(new Blob([bytes as BlobPart]));
    await expect(bad(new Uint8Array([1, 2, 3, 4, 5, 6]))).rejects.toBeInstanceOf(ProjectError);
    await expect(bad(good.slice(0, 20))).rejects.toBeInstanceOf(ProjectError);
    const future = good.slice(); future[4] = 9;
    await expect(bad(future)).rejects.toThrow(/newer version/);
    const junk = good.slice(); junk.fill(7, 8);
    await expect(bad(junk)).rejects.toBeInstanceOf(ProjectError);
  });
});
