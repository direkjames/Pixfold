export const MAX_SIZE = 2000;

/** Colours are packed 0xAABBGGRR (what a little-endian Uint32Array over RGBA bytes gives). */
export const hexToU32 = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16);
  return ((255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | ((n >> 16) & 255)) >>> 0;
};
export const u32ToHex = (c: number): string =>
  '#' + [c & 255, (c >> 8) & 255, (c >> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('');

export interface Change { name: string; idx: Uint32Array; before: Uint32Array; after: Uint32Array }
interface Rect { x0: number; y0: number; x1: number; y1: number }

export class Doc {
  readonly data: Uint32Array;
  dirty: Rect | null = null;

  constructor(readonly w: number, readonly h: number, data?: Uint32Array) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIZE || h > MAX_SIZE)
      throw new RangeError(`Canvas must be between 1 and ${MAX_SIZE} pixels`);
    this.data = data ?? new Uint32Array(w * h);
  }

  set(i: number, c: number) {
    if (this.data[i] === c) return;
    this.data[i] = c;
    this.mark(i);
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
    const src = forward ? c.after : c.before;
    for (let k = 0; k < c.idx.length; k++) this.set(c.idx[k], src[k]);
  }

  clear() { this.data.fill(0); this.dirty = { x0: 0, y0: 0, x1: this.w - 1, y1: this.h - 1 }; }
}

/** Records the first value of every pixel it touches, so a stroke can be undone or reverted live. */
export class Stroke {
  private before = new Map<number, number>();
  constructor(private doc: Doc) {}
  get touched() { return this.before.size; }
  set(i: number, c: number) {
    if (!this.before.has(i)) this.before.set(i, this.doc.data[i]);
    this.doc.set(i, c);
  }
  revert(i: number) {
    const b = this.before.get(i);
    if (b !== undefined) this.doc.set(i, b);
  }
  revertAll() {
    for (const [i, b] of this.before) this.doc.set(i, b);
    this.before.clear();
  }
  commit(name: string): Change | null {
    const idx: number[] = [], bef: number[] = [], aft: number[] = [];
    for (const [i, b] of this.before) {
      const a = this.doc.data[i];
      if (a !== b) { idx.push(i); bef.push(b); aft.push(a); }
    }
    return idx.length ? { name, idx: Uint32Array.from(idx), before: Uint32Array.from(bef), after: Uint32Array.from(aft) } : null;
  }
}

/** Undo stack. Stores only the pixels that changed, and drops the oldest entries past a memory cap. */
export class History {
  items: Change[] = [];
  pos = 0;
  private entries = 0;
  constructor(private cap = 6_000_000) {}

  push(c: Change) {
    for (const d of this.items.splice(this.pos)) this.entries -= d.idx.length;
    this.items.push(c);
    this.pos = this.items.length;
    this.entries += c.idx.length;
    while (this.entries > this.cap && this.items.length > 1) {
      this.entries -= this.items.shift()!.idx.length;
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
