import type { Doc } from './doc';

export const ZOOMS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

interface Hover { x: number; y: number; size: number }

/** Draws the document and owns the viewport (zoom and pan). Zoom only snaps to fixed steps so pixels stay crisp. */
export class View {
  zoom = 8;
  ox = 0;
  oy = 0;
  cw = 0;
  ch = 0;
  grid = true;
  hover: Hover | null = null;
  doc!: Doc;
  private dpr = 1;
  private ctx: CanvasRenderingContext2D;
  readonly off = document.createElement('canvas');
  onDraw: (() => void) | null = null;
  private offCtx = this.off.getContext('2d')!;
  private img!: ImageData;
  private raf = 0;
  private col = { chk1: '#fff', chk2: '#e9e5de', grid: 'rgba(0,0,0,.07)', ink: '#1b1a1f', sun: '#ffc53d', shadow: 'rgba(40,30,20,.25)', line: '#e2dacd' };

  constructor(private canvas: HTMLCanvasElement, doc: Doc) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    this.setDoc(doc);
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  setDoc(doc: Doc) {
    this.doc = doc;
    this.off.width = doc.w;
    this.off.height = doc.h;
    this.img = new ImageData(new Uint8ClampedArray(doc.data.buffer as ArrayBuffer, doc.data.byteOffset, doc.data.byteLength), doc.w, doc.h);
    this.offCtx.putImageData(this.img, 0, 0);
    doc.dirty = null;
    this.fit();
  }

  readTheme() {
    const s = getComputedStyle(document.documentElement);
    const g = (n: string, d: string) => s.getPropertyValue(n).trim() || d;
    this.col = { chk1: g('--chk1', '#fff'), chk2: g('--chk2', '#e9e5de'), grid: g('--grid', 'rgba(0,0,0,.07)'), ink: g('--ink', '#1b1a1f'), sun: g('--sun', '#ffc53d'), shadow: g('--canvas-glow', 'rgba(40,30,20,.25)'), line: g('--line', '#e2dacd') };
    this.invalidate();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const first = this.cw === 0 && r.width > 0;
    this.dpr = window.devicePixelRatio || 1;
    this.cw = r.width;
    this.ch = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    if (first && this.doc) this.fit();
    this.invalidate();
  }

  fit() {
    const z = Math.min((this.cw - 120) / this.doc.w, (this.ch - 140) / this.doc.h);
    this.zoom = ZOOMS.filter((l) => l <= z).pop() ?? ZOOMS[0];
    this.center();
  }

  center() {
    this.ox = Math.round((this.cw - this.doc.w * this.zoom) / 2);
    this.oy = Math.round((this.ch - this.doc.h * this.zoom) / 2 - 10);
    this.invalidate();
  }

  /** dir > 0 zooms in, < 0 zooms out; (sx, sy) is the screen point that stays put. */
  zoomStep(dir: number, sx = this.cw / 2, sy = this.ch / 2) {
    let i = ZOOMS.findIndex((l) => l >= this.zoom - 1e-6);
    if (i < 0) i = ZOOMS.length - 1;
    const n = Math.min(ZOOMS.length - 1, Math.max(0, i + (dir > 0 ? 1 : -1)));
    if (n === i) return;
    const old = this.zoom;
    this.zoom = ZOOMS[n];
    this.ox = Math.round(sx - ((sx - this.ox) / old) * this.zoom);
    this.oy = Math.round(sy - ((sy - this.oy) / old) * this.zoom);
    this.invalidate();
  }

  toDoc(sx: number, sy: number) {
    return { x: Math.floor((sx - this.ox) / this.zoom), y: Math.floor((sy - this.oy) / this.zoom) };
  }
  inside(x: number, y: number) { return x >= 0 && y >= 0 && x < this.doc.w && y < this.doc.h; }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private draw() {
    const { ctx, zoom: z, ox, oy, doc, col } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    const bw = doc.w * z, bh = doc.h * z;
    if (doc.dirty) {
      const d = doc.dirty;
      this.offCtx.putImageData(this.img, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1);
      doc.dirty = null;
    }
    ctx.save();
    ctx.shadowColor = col.shadow; ctx.shadowBlur = 40; ctx.shadowOffsetY = 16;
    ctx.fillStyle = col.chk1; ctx.fillRect(ox, oy, bw, bh);
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, bw, bh); ctx.clip();
    const cell = z * Math.max(1, Math.round(32 / z));
    const i0 = Math.max(0, Math.floor(-ox / cell)), i1 = Math.min(Math.ceil(bw / cell), Math.ceil((this.cw - ox) / cell));
    const j0 = Math.max(0, Math.floor(-oy / cell)), j1 = Math.min(Math.ceil(bh / cell), Math.ceil((this.ch - oy) / cell));
    ctx.fillStyle = col.chk2;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) if ((i + j) & 1) ctx.fillRect(ox + i * cell, oy + j * cell, cell, cell);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.off, ox, oy, bw, bh);
    if (this.grid && z >= 8) {
      ctx.strokeStyle = col.grid; ctx.lineWidth = 1; ctx.beginPath();
      const gx0 = Math.max(0, Math.floor(-ox / z)), gx1 = Math.min(doc.w, Math.ceil((this.cw - ox) / z));
      const gy0 = Math.max(0, Math.floor(-oy / z)), gy1 = Math.min(doc.h, Math.ceil((this.ch - oy) / z));
      for (let i = gx0; i <= gx1; i++) { const x = ox + i * z + 0.5; ctx.moveTo(x, oy); ctx.lineTo(x, oy + bh); }
      for (let j = gy0; j <= gy1; j++) { const y = oy + j * z + 0.5; ctx.moveTo(ox, y); ctx.lineTo(ox + bw, y); }
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = col.line; ctx.lineWidth = 1;
    ctx.strokeRect(ox - 0.5, oy - 0.5, bw + 1, bh + 1);

    const h = this.hover;
    if (h && this.inside(h.x, h.y)) {
      const s = h.size * z, x = ox + h.x * z, y = oy + h.y * z;
      ctx.lineWidth = 2; ctx.strokeStyle = col.sun; ctx.strokeRect(x - 1, y - 1, s + 2, s + 2);
      ctx.lineWidth = 1; ctx.strokeStyle = col.ink; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    }
    this.onDraw?.();
  }
}
