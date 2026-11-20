import { BLENDS, blendPixel, type Blend } from './composite';

export { BLENDS, type Blend };
export const MAX_SIZE = 2000;
const LAYER_BUDGET = 500_000_000; // bytes of layer pixels we allow in memory

/** How many layers fit: 2000x2000 layers are 16 MB each, small canvases allow up to 100. */
export const maxLayers = (w: number, h: number) => Math.max(2, Math.min(100, Math.floor(LAYER_BUDGET / (w * h * 4))));

/** Colours are packed 0xAABBGGRR (what a little-endian Uint32Array over RGBA bytes gives). */
export const hexToU32 = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return ((255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | ((n >> 16) & 255)) >>> 0;
};
export const u32ToHex = (c: number): string =>
  '#' + [c & 255, (c >> 8) & 255, (c >> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('');

export interface PixelChange { kind: 'px'; name: string; layer: number; idx: Uint32Array; before: Uint32Array; after: Uint32Array }
/** A layer action. `weight` is roughly how many pixels it keeps alive, so history can cap memory. */
export interface LayerChange { kind: 'layer'; name: string; weight: number; undo: () => void; redo: () => void }
export type Change = PixelChange | LayerChange;
const weightOf = (c: Change) => (c.kind === 'px' ? c.idx.length : c.weight);

export class Layer {
  visible = true;
  locked = false;
  opacity = 100;
  blend: Blend = 'normal';
  constructor(readonly id: number, public name: string, public px: Uint32Array) {}
}

export interface LayerSpec { name: string; visible: boolean; locked: boolean; opacity: number; blend: string; px: Uint32Array }
type Prop = 'name' | 'opacity' | 'blend' | 'visible' | 'locked';
interface Rect { x0: number; y0: number; x1: number; y1: number }

export class Doc {
  /** The flattened picture of all visible layers. This is what is shown, exported and counted. */
  readonly data: Uint32Array;
  layers: Layer[];
  active = 0;
  dirty: Rect | null = null;
  private nextId = 1;

  constructor(readonly w: number, readonly h: number, px?: Uint32Array) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIZE || h > MAX_SIZE)
      throw new RangeError(`Canvas must be between 1 and ${MAX_SIZE} pixels`);
    this.data = new Uint32Array(w * h);
    this.layers = [this.newLayer(px)];
    this.recompAll();
  }

  static fromLayers(w: number, h: number, specs: LayerSpec[], active = 0): Doc {
    const d = new Doc(w, h);
    if (specs.length < 1 || specs.length > maxLayers(w, h)) throw new RangeError('This file has too many layers for its canvas size');
    d.layers = specs.map((s) => {
      if (s.px.length !== w * h) throw new RangeError('A layer does not match the canvas size');
      const L = d.newLayer(s.px, String(s.name).slice(0, 64) || undefined);
      const o = Number(s.opacity);
      L.visible = !!s.visible;
      L.locked = !!s.locked;
      L.opacity = Number.isFinite(o) ? Math.min(100, Math.max(0, Math.round(o))) : 100;
      L.blend = (BLENDS as readonly string[]).includes(s.blend) ? (s.blend as Blend) : 'normal';
      return L;
    });
    d.active = Math.min(Math.max(0, Math.floor(active) || 0), d.layers.length - 1);
    d.recompAll();
    return d;
  }

  get layer() { return this.layers[this.active]; }
  get canAddLayer() { return this.layers.length < maxLayers(this.w, this.h); }
  private newLayer(px?: Uint32Array, name?: string) {
    const id = this.nextId++;
    return new Layer(id, name ?? `Layer ${id}`, px ?? new Uint32Array(this.w * this.h));
  }

  // ----- pixels -----
  /** Write one pixel on a layer and update the flattened picture there. */
  setPx(L: Layer, i: number, c: number) {
    if (L.px[i] === c) return;
    L.px[i] = c;
    this.recompPixel(i);
    this.mark(i);
  }
  private recompPixel(i: number) {
    let out = 0;
    for (const L of this.layers) if (L.visible) out = blendPixel(out, L.px[i], L.opacity, L.blend);
    this.data[i] = out;
  }
  recompAll() {
    for (let i = 0; i < this.data.length; i++) this.recompPixel(i);
    this.dirty = { x0: 0, y0: 0, x1: this.w - 1, y1: this.h - 1 };
  }
  private mark(i: number) {
    const x = i % this.w, y = (i / this.w) | 0, d = this.dirty;
    if (!d) this.dirty = { x0: x, y0: y, x1: x, y1: y };
    else {
      if (x < d.x0) d.x0 = x; if (x > d.x1) d.x1 = x;
      if (y < d.y0) d.y0 = y; if (y > d.y1) d.y1 = y;
    }
  }

  apply(c: Change, forward: boolean) {
    if (c.kind === 'layer') { (forward ? c.redo : c.undo)(); return; }
    const L = this.layers.find((l) => l.id === c.layer);
    if (!L) return;
    const src = forward ? c.after : c.before;
    for (let k = 0; k < c.idx.length; k++) this.setPx(L, c.idx[k], src[k]);
  }

  // ----- layer actions (each is applied now and returns the entry for history) -----
  private entry(name: string, weight: number, undo: () => void, redo: () => void): LayerChange {
    redo();
    return { kind: 'layer', name, weight, undo, redo };
  }

  addLayer(): LayerChange | null {
    if (!this.canAddLayer) return null;
    const L = this.newLayer(), at = this.active + 1, prev = this.active;
    return this.entry('New layer', 0,
      () => { this.layers.splice(at, 1); this.active = prev; },
      () => { this.layers.splice(at, 0, L); this.active = at; });
  }

  duplicateLayer(): LayerChange | null {
    if (!this.canAddLayer) return null;
    const src = this.layer, L = this.newLayer(src.px.slice(), `${src.name} copy`.slice(0, 64)), at = this.active + 1, prev = this.active;
    L.visible = src.visible; L.opacity = src.opacity; L.blend = src.blend;
    return this.entry('Duplicate layer', this.w * this.h,
      () => { this.layers.splice(at, 1); this.active = prev; this.recompAll(); },
      () => { this.layers.splice(at, 0, L); this.active = at; this.recompAll(); });
  }

  deleteLayer(): LayerChange | null {
    if (this.layers.length < 2) return null;
    const at = this.active, L = this.layers[at];
    return this.entry('Delete layer', this.w * this.h,
      () => { this.layers.splice(at, 0, L); this.active = at; this.recompAll(); },
      () => { this.layers.splice(at, 1); this.active = Math.min(at, this.layers.length - 1); this.recompAll(); });
  }

  moveLayer(from: number, to: number): LayerChange | null {
    to = Math.min(this.layers.length - 1, Math.max(0, to));
    if (from === to || !this.layers[from]) return null;
    const mv = (a: number, b: number) => { this.layers.splice(b, 0, this.layers.splice(a, 1)[0]); this.active = b; this.recompAll(); };
    return this.entry('Move layer', 0, () => mv(to, from), () => mv(from, to));
  }

  mergeDown(): LayerChange | null {
    const a = this.active;
    if (a < 1) return null;
    const top = this.layers[a], below = this.layers[a - 1], saved = below.px.slice();
    const merged = below.px.slice();
    if (top.visible) for (let i = 0; i < merged.length; i++) merged[i] = blendPixel(merged[i], top.px[i], top.opacity, top.blend);
    return this.entry('Merge down', 2 * this.w * this.h,
      () => { below.px = saved; this.layers.splice(a, 0, top); this.active = a; this.recompAll(); },
      () => { below.px = merged; this.layers.splice(a, 1); this.active = a - 1; this.recompAll(); });
  }

  /** Change a layer property right now (no history). Pair with `propChange` to make it undoable. */
  setProp<K extends Prop>(L: Layer, key: K, value: Layer[K]) {
    L[key] = value;
    if (key === 'opacity' || key === 'blend' || key === 'visible') this.recompAll();
  }
  /** History entry for a property change that was already applied (for example while dragging a slider). */
  propChange<K extends Prop>(L: Layer, key: K, from: Layer[K], to: Layer[K], name: string): LayerChange {
    return { kind: 'layer', name, weight: 0, undo: () => this.setProp(L, key, from), redo: () => this.setProp(L, key, to) };
  }
}

/** Records the first value of every pixel it touches on one layer, so a stroke can be undone or reverted live. */
export class Stroke {
  private before = new Map<number, number>();
  constructor(private doc: Doc, readonly layer: Layer) {}
  get touched() { return this.before.size; }
  set(i: number, c: number) {
    if (!this.before.has(i)) this.before.set(i, this.layer.px[i]);
    this.doc.setPx(this.layer, i, c);
  }
  revert(i: number) {
    const b = this.before.get(i);
    if (b !== undefined) this.doc.setPx(this.layer, i, b);
  }
  revertAll() {
    for (const [i, b] of this.before) this.doc.setPx(this.layer, i, b);
    this.before.clear();
  }
  commit(name: string): PixelChange | null {
    const idx: number[] = [], bef: number[] = [], aft: number[] = [];
    for (const [i, b] of this.before) {
      const a = this.layer.px[i];
      if (a !== b) { idx.push(i); bef.push(b); aft.push(a); }
    }
    return idx.length ? { kind: 'px', name, layer: this.layer.id, idx: Uint32Array.from(idx), before: Uint32Array.from(bef), after: Uint32Array.from(aft) } : null;
  }
}

/** Undo stack. Pixel edits store only the pixels that changed; the oldest entries are dropped past a memory cap. */
export class History {
  items: Change[] = [];
  pos = 0;
  private entries = 0;
  constructor(private cap = 6_000_000) {}

  push(c: Change) {
    for (const d of this.items.splice(this.pos)) this.entries -= weightOf(d);
    this.items.push(c);
    this.pos = this.items.length;
    this.entries += weightOf(c);
    while (this.entries > this.cap && this.items.length > 1) {
      this.entries -= weightOf(this.items.shift()!);
      this.pos--;
    }
  }
  undo(doc: Doc) { if (this.pos === 0) return false; doc.apply(this.items[--this.pos], false); return true; }
  redo(doc: Doc) { if (this.pos >= this.items.length) return false; doc.apply(this.items[this.pos++], true); return true; }
  jump(doc: Doc, to: number) {
    while (this.pos > to && this.undo(doc));
    while (this.pos < to && this.redo(doc));
  }
  clear() { this.items = []; this.pos = 0; this.entries = 0; }
}
