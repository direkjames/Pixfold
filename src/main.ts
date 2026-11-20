import './style.css';
import { BLENDS, Doc, History, MAX_SIZE, Stroke, hexToU32, maxLayers, u32ToHex, type Blend, type Layer, type LayerChange, type PixelChange } from './doc';
import { ellipsePoints, floodFill, line, mirrorSpots, pushPerfect, rectPoints, type Pt } from './raster';
import {
  allMask, combine, decodeMask, eachInMask, encodeMask, flipClip, invertMask, liftClip, maskBox, placeClip, polygonMask,
  rectMask, rotateClip, wandMask, type Clip, type Mask, type SelMode,
} from './selection';
import { SCALES, fromImage, maxScale, pickFile, saveBlob, toPng } from './io';
import { EXT, ProjectError, decodeProject, encodeProject } from './project';
import { loadDoc, pref, saveDoc } from './store';
import { View } from './view';

type ToolId = 'pencil' | 'eraser' | 'fill' | 'picker' | 'line' | 'rect' | 'ellipse' | 'marquee' | 'lasso' | 'wand' | 'move' | 'pan' | 'zoom';
type Theme = 'light' | 'dark' | 'system';
const NAMES: Record<ToolId, string> = {
  pencil: 'Pencil', eraser: 'Eraser', fill: 'Fill', picker: 'Color picker', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse',
  marquee: 'Rectangle select', lasso: 'Lasso', wand: 'Magic wand', move: 'Move', pan: 'Pan', zoom: 'Zoom',
};
const BRUSH: ToolId[] = ['pencil', 'eraser', 'line', 'rect', 'ellipse'];
const SELECT_TOOLS: ToolId[] = ['marquee', 'lasso', 'wand'];
const KEYS: Record<string, ToolId> = { b: 'pencil', e: 'eraser', g: 'fill', i: 'picker', l: 'line', u: 'rect', o: 'ellipse', m: 'marquee', q: 'lasso', w: 'wand', v: 'move', h: 'pan', z: 'zoom' };
const HELP: Partial<Record<ToolId, string>> = {
  fill: 'Fills the touching pixels of the same colour on this layer.',
  picker: 'Click to pick a colour from what you see. Hold Alt to read only this layer. Right click sets the second colour.',
  marquee: 'Drag to select a rectangle. Hold Shift to add, Alt to remove. Click to deselect.',
  lasso: 'Draw around what you want. Hold Shift to add, Alt to remove. Click to deselect.',
  wand: 'Click to select the pixels of the same colour on this layer. Hold Shift to add, Alt to remove.',
  move: 'Drag to move the selection, or the whole layer if nothing is selected. Hold Ctrl to copy. Arrow keys nudge by one pixel.',
  pan: 'Drag to move around. You can also hold Space with any tool.',
  zoom: 'Click to zoom in, Alt+click to zoom out.',
};
const DEFAULT_PALETTE = ['#2a2233', '#e4504a', '#ff8a7a', '#fff1dc', '#f2d7b0', '#d9b88a', '#12877f', '#ffc53d', '#ff7a3d', '#3e7cb1', '#7bc8f6', '#a5d86e', '#6b4f9e', '#f7a8c4', '#8a8f98', '#ffffff'];
const HEX = /^#[0-9a-f]{6}$/;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let tool: ToolId = 'pencil';
let size = 1, perfect = true, fillShape = false;
let symH = false, symV = false;                 // mirror drawing across the canvas centre
let selMode: SelMode = 'replace', wandTouching = true;
let sel: Mask | null = null;                    // the selection, one byte per canvas pixel
let clip: Clip | null = null;                   // what Copy and Cut hold (inside Pixfold only)
let fg = '#e4504a', bg = '#fff1dc';
let palette = [...DEFAULT_PALETTE];
let recent: string[] = [];
let docName = 'untitled.pfold';
let doc: Doc;
let view: View;
const history = new History();

// ---------- toast ----------
let toastTimer = 0;
function toast(msg: string, ms = 3200) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

// A bug or a failed browser call must never leave the user guessing.
let lastFail = 0;
const fail = () => {
  if (Date.now() - lastFail < 5000) return;
  lastFail = Date.now();
  toast('Something went wrong. Your drawing is still here: press Ctrl+S to save a copy.', 6000);
};
addEventListener('unhandledrejection', fail);
addEventListener('error', fail);

// ---------- theme ----------
let theme: Theme = (['light', 'dark', 'system'] as const).find((t) => t === pref.get('theme')) ?? 'system';
const mq = matchMedia('(prefers-color-scheme: dark)');
const THEME_ICON: Record<Theme, string> = {
  light: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg class="i" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  system: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
};
function applyTheme() {
  const dark = theme === 'dark' || (theme === 'system' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const b = $('theme');
  b.innerHTML = THEME_ICON[theme];
  const label = `Theme: ${theme}. Click to change`;
  b.setAttribute('aria-label', label); b.title = label;
  view?.readTheme();
}
mq.addEventListener('change', applyTheme);
$('theme').onclick = () => {
  theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
  pref.set('theme', theme);
  applyTheme();
};

// ---------- autosave ----------
let saveTimer = 0;
function scheduleSave() {
  $('saved').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 800 + (doc.layers.length * doc.w * doc.h) / 100_000); // big drawings wait longer
}
let saving = false, saveAgain = false;
async function flushSave() {
  clearTimeout(saveTimer);
  if (saving) { saveAgain = true; return; } // one write at a time; run again afterwards for newer changes
  saving = true;
  let ok = false;
  try { ok = await saveDoc({ v: 3, w: doc.w, h: doc.h, project: await encodeProject(doc, palette), palette, fg, bg, name: docName }); }
  catch { ok = false; }
  saving = false;
  $('saved').textContent = ok ? 'Autosaved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Autosave failed. Press Ctrl+S to keep your work';
  if (saveAgain) { saveAgain = false; void flushSave(); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushSave(); });

// ---------- panels ----------
function setFg(c: string) { fg = c.toLowerCase(); refreshColors(); }
function setBg(c: string) { bg = c.toLowerCase(); refreshColors(); }
function refreshColors() {
  $('fgsw').style.background = fg; $('bgsw').style.background = bg;
  ($('fgin') as HTMLInputElement).value = fg; ($('bgin') as HTMLInputElement).value = bg;
  document.querySelectorAll<HTMLButtonElement>('#pal button[data-c]').forEach((b) => {
    b.classList.toggle('on', b.dataset.c === fg);
    b.classList.toggle('bgon', b.dataset.c === bg && b.dataset.c !== fg);
  });
}

function renderPalette() {
  const pal = $('pal');
  pal.replaceChildren();
  let from = -1;
  palette.forEach((c, i) => {
    const b = document.createElement('button');
    b.dataset.c = c; b.style.background = c; b.draggable = true;
    b.title = `${c}  ·  click: draw  ·  right click: background  ·  double click: edit  ·  Alt+click: remove`;
    b.setAttribute('aria-label', `Colour ${c}`);
    b.onclick = (e) => {
      if (e.altKey) { palette.splice(i, 1); renderPalette(); scheduleSave(); } else setFg(c);
    };
    b.oncontextmenu = (e) => { e.preventDefault(); setBg(c); };
    b.ondblclick = () => {
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = c;
      inp.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.append(inp);
      inp.oninput = () => { palette[i] = inp.value.toLowerCase(); renderPalette(); };
      inp.onchange = () => { inp.remove(); scheduleSave(); };
      inp.showPicker?.();
    };
    b.ondragstart = (e) => { from = i; b.classList.add('drag'); e.dataTransfer?.setData('text/plain', String(i)); };
    b.ondragend = () => b.classList.remove('drag');
    b.ondragover = (e) => e.preventDefault();
    b.ondrop = (e) => {
      e.preventDefault();
      if (from < 0 || from === i) return;
      palette.splice(i, 0, palette.splice(from, 1)[0]);
      from = -1; renderPalette(); scheduleSave();
    };
    pal.append(b);
  });
  const add = document.createElement('button');
  add.className = 'add'; add.textContent = '+'; add.title = 'Add the current colour'; add.setAttribute('aria-label', 'Add current colour to palette');
  add.onclick = addColor;
  pal.append(add);
  refreshColors();
}
function addColor() {
  if (palette.includes(fg)) return toast('That colour is already in the palette');
  if (palette.length >= 256) return toast('The palette is full (256 colours)');
  palette.push(fg); renderPalette(); scheduleSave();
}

function pushRecent(c: string) {
  recent = [c, ...recent.filter((x) => x !== c)].slice(0, 8);
  const row = $('recentrow');
  row.replaceChildren();
  for (const r of recent) {
    const b = document.createElement('button');
    b.style.background = r; b.title = r; b.setAttribute('aria-label', `Recent colour ${r}`);
    b.onclick = () => setFg(r);
    row.append(b);
  }
  $('recent').hidden = false;
}

function refreshOptions() {
  $('opttitle').textContent = NAMES[tool];
  $('st').textContent = NAMES[tool];
  $('size').closest('.row')!.toggleAttribute('hidden', !BRUSH.includes(tool));
  $('pp').closest('.row')!.toggleAttribute('hidden', tool !== 'pencil' && tool !== 'eraser');
  ($('pp') as HTMLButtonElement).disabled = size > 1;
  $('fillrow').toggleAttribute('hidden', tool !== 'rect' && tool !== 'ellipse');
  $('symrow').toggleAttribute('hidden', !BRUSH.includes(tool));
  $('selrow').toggleAttribute('hidden', !SELECT_TOOLS.includes(tool));
  $('wandrow').toggleAttribute('hidden', tool !== 'wand');
  $('opthelp').textContent = HELP[tool] ?? '';
  document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) => {
    const on = b.dataset.tool === tool;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
  $('stage').classList.toggle('pan', tool === 'pan');
  $('stage').classList.toggle('zoomc', tool === 'zoom');
}

function refreshHistory() {
  const ol = $('hist');
  const start = Math.max(0, history.items.length - 300);
  const mk = (label: string, to: number, count?: number) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = label;
    if (count !== undefined) { const s = document.createElement('small'); s.textContent = count.toLocaleString(); b.append(s); }
    if (to === history.pos) { b.className = 'on'; b.setAttribute('aria-current', 'step'); } else if (to > history.pos) b.className = 'future';
    b.onclick = () => { history.jump(doc, to); afterChange(); };
    li.append(b); ol.append(li);
  };
  ol.replaceChildren();
  mk(start > 0 ? '…earlier steps' : 'New canvas', start);
  history.items.slice(start).forEach((c, i) => mk(c.name, start + i + 1, c.kind === 'px' ? c.idx.length : undefined));
  ol.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  $('hcount').textContent = history.items.length ? String(history.items.length) : '';
  ($('undo') as HTMLButtonElement).disabled = history.pos === 0;
  ($('redo') as HTMLButtonElement).disabled = history.pos >= history.items.length;
}

let countTimer = 0, colorCount = '–';
function scheduleCount() {
  clearTimeout(countTimer);
  countTimer = window.setTimeout(() => {
    if (doc.w * doc.h > 262_144) colorCount = '–';
    else { const s = new Set<number>(); for (const v of doc.data) if (v >>> 24) s.add(v); colorCount = String(s.size); }
    refreshInfo();
  }, 250);
}
function refreshInfo() {
  $('info').innerHTML = `Size <b>${doc.w} × ${doc.h}</b><br>Colors <b>${colorCount}</b><br>Zoom <b>${Math.round(view.zoom * 100)}%</b>`;
}

function afterChange() {
  view.invalidate(); refreshHistory(); renderLayers(); scheduleSave(); scheduleCount();
}

function loadDocument(d: Doc, name: string) {
  doc = d; docName = name;
  history.clear();
  view.setDoc(d);
  setSelection(null);
  $('fname').textContent = name;
  $('sc').textContent = `${d.w} × ${d.h}`;
  refreshHistory(); renderLayers(); refreshInfo(); scheduleSave(); scheduleCount();
}

// ---------- layers ----------
const ICON = {
  eye: '<svg class="i" viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg class="i" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/></svg>',
  lock: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
};

function thumb(L: Layer) {
  const T = 28, c = document.createElement('canvas');
  c.width = c.height = T;
  const g = c.getContext('2d')!, img = g.createImageData(T, T), px = new Uint32Array(img.data.buffer);
  const s = Math.max(doc.w, doc.h) / T, ox = (T - doc.w / s) / 2, oy = (T - doc.h / s) / 2;
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const sx = Math.floor((x - ox) * s), sy = Math.floor((y - oy) * s);
    if (sx >= 0 && sy >= 0 && sx < doc.w && sy < doc.h) px[y * T + x] = L.px[sy * doc.w + sx];
  }
  g.putImageData(img, 0, 0);
  return c;
}

function pushLayerOp(c: LayerChange | null, failMsg?: string) {
  if (!c) { if (failMsg) toast(failMsg); return; }
  history.push(c); afterChange();
}
const addLayer = () => pushLayerOp(doc.addLayer(), `This canvas allows up to ${maxLayers(doc.w, doc.h)} layers.`);
const dupLayer = () => pushLayerOp(doc.duplicateLayer(), `This canvas allows up to ${maxLayers(doc.w, doc.h)} layers.`);
const delLayer = () => pushLayerOp(doc.deleteLayer(), 'A drawing needs at least one layer.');
const mergeDown = () => pushLayerOp(doc.mergeDown(), 'There is no layer below to merge into.');
const moveLayer = (d: number) => pushLayerOp(doc.moveLayer(doc.active, doc.active + d));
$('ladd').onclick = addLayer; $('ldup').onclick = dupLayer; $('ldel').onclick = delLayer; $('lmerge').onclick = mergeDown;

function setActive(i: number) { doc.active = i; renderLayers(); }
function flatChanged() { view.invalidate(); renderLayers(); scheduleSave(); scheduleCount(); }

let layerDrag = -1;
function renderLayers() {
  const ul = $('layers');
  ul.replaceChildren();
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const L = doc.layers[i];
    const li = document.createElement('li');
    li.className = 'layer' + (i === doc.active ? ' on' : '') + (L.visible ? '' : ' dim');
    li.dataset.i = String(i); li.draggable = true;
    li.title = 'Click to select · double-click to rename · drag to reorder';
    li.append(thumb(L));
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = L.name;
    nm.ondblclick = () => startRename(i);
    li.append(nm);
    const eye = document.createElement('button');
    eye.innerHTML = L.visible ? ICON.eye : ICON.eyeOff; eye.className = L.visible ? '' : 'off';
    eye.setAttribute('aria-label', `${L.visible ? 'Hide' : 'Show'} ${L.name}`); eye.setAttribute('aria-pressed', String(L.visible));
    eye.onclick = (e) => { e.stopPropagation(); doc.setProp(L, 'visible', !L.visible); flatChanged(); };
    const lk = document.createElement('button');
    lk.innerHTML = L.locked ? ICON.lock : ICON.unlock; lk.className = L.locked ? '' : 'off';
    lk.setAttribute('aria-label', `${L.locked ? 'Unlock' : 'Lock'} ${L.name}`); lk.setAttribute('aria-pressed', String(L.locked));
    lk.onclick = (e) => { e.stopPropagation(); doc.setProp(L, 'locked', !L.locked); renderLayers(); scheduleSave(); };
    li.append(eye, lk);
    li.onclick = () => setActive(i);
    li.ondragstart = (e) => { layerDrag = i; e.dataTransfer?.setData('text/plain', String(i)); };
    li.ondragover = (e) => { if (layerDrag >= 0) { e.preventDefault(); li.classList.add('over'); } };
    li.ondragleave = () => li.classList.remove('over');
    li.ondrop = (e) => { e.preventDefault(); const from = layerDrag; layerDrag = -1; if (from >= 0) pushLayerOp(doc.moveLayer(from, i)); };
    li.ondragend = () => { layerDrag = -1; renderLayers(); };
    ul.append(li);
  }
  const L = doc.layer;
  $('lcount').textContent = `${doc.layers.length} of ${maxLayers(doc.w, doc.h)}`;
  ($('lop') as HTMLInputElement).value = String(L.opacity); $('lopv').textContent = `${L.opacity}%`;
  ($('lbl') as HTMLSelectElement).value = L.blend;
  ($('ladd') as HTMLButtonElement).disabled = ($('ldup') as HTMLButtonElement).disabled = !doc.canAddLayer;
  ($('ldel') as HTMLButtonElement).disabled = doc.layers.length < 2;
  ($('lmerge') as HTMLButtonElement).disabled = doc.active < 1;
}

function startRename(i: number) {
  const nm = $('layers').querySelector(`[data-i="${i}"] .nm`);
  if (!nm) return;
  const inp = document.createElement('input');
  inp.className = 'rn'; inp.value = doc.layers[i].name; inp.maxLength = 64;
  inp.setAttribute('aria-label', 'Layer name');
  nm.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const L = doc.layers[i], v = inp.value.trim().slice(0, 64);
    if (save && v && v !== L.name) {
      const old = L.name;
      doc.setProp(L, 'name', v);
      history.push(doc.propChange(L, 'name', old, v, 'Rename layer'));
      afterChange();
    } else renderLayers();
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
  inp.onclick = (e) => e.stopPropagation();
}

const lop = $('lop') as HTMLInputElement, lbl = $('lbl') as HTMLSelectElement;
let opFrom: number | null = null, opPending = -1, opFrame = 0;
// Re-flattening a huge canvas takes a moment, so dragging the slider applies at most once per frame.
const applyOpacity = () => {
  opFrame = 0;
  if (opPending < 0) return;
  doc.setProp(doc.layer, 'opacity', opPending);
  opPending = -1;
  view.invalidate(); scheduleCount();
};
lop.addEventListener('input', () => {
  const L = doc.layer, v = Number(lop.value);
  if (opFrom === null) opFrom = L.opacity;
  opPending = v;
  $('lopv').textContent = `${v}%`;
  if (!opFrame) opFrame = requestAnimationFrame(applyOpacity);
});
lop.addEventListener('change', () => {
  cancelAnimationFrame(opFrame);
  applyOpacity();
  const L = doc.layer;
  if (opFrom !== null && opFrom !== L.opacity) { history.push(doc.propChange(L, 'opacity', opFrom, L.opacity, 'Layer opacity')); afterChange(); }
  opFrom = null;
});
for (const b of BLENDS) lbl.append(new Option(b[0].toUpperCase() + b.slice(1), b));
lbl.addEventListener('change', () => {
  const L = doc.layer, from = L.blend, to = lbl.value as Blend;
  if (from === to) return;
  doc.setProp(L, 'blend', to);
  history.push(doc.propChange(L, 'blend', from, to, 'Layer blend'));
  afterChange();
});

// ---------- drawing ----------
let space = false;
type Drag =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'draw' }
  | { kind: 'marquee'; a: Pt; b: Pt; mode: SelMode }
  | { kind: 'lasso'; pts: Pt[]; mode: SelMode }
  | { kind: 'move'; m: MoveState };
let drag: Drag | null = null;
let stroke: Stroke | null = null;
let color = 0, start: Pt = { x: 0, y: 0 }, lastPt: Pt | null = null, lastDrawn: Pt = { x: 0, y: 0 };
let kept: Pt[] = [];
const refs = new Map<number, number>();

const inDoc = (p: Pt) => p.x >= 0 && p.y >= 0 && p.x < doc.w && p.y < doc.h;
const brushOrigin = () => (size - 1) >> 1;

/** With a selection, drawing only changes pixels inside it. */
const allowed = (i: number) => !sel || sel[i] === 1;

/** Write one pixel, and its mirror images when mirroring is on. Nothing is written outside the canvas or the selection. */
function put(x: number, y: number, c: number) {
  for (const q of mirrorSpots(x, y, doc.w, doc.h, symH, symV)) {
    if (q.x < 0 || q.y < 0 || q.x >= doc.w || q.y >= doc.h) continue;
    const i = q.y * doc.w + q.x;
    if (allowed(i)) stroke!.set(i, c);
  }
}
function stamp(p: Pt, c: number) {
  const o = brushOrigin();
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) put(p.x - o + dx, p.y - o + dy, c);
}
const usePerfect = () => perfect && size === 1 && (tool === 'pencil' || tool === 'eraser');
/** Pixel-perfect drawing paints a point, then may take back the corner pixel before it; counts keep shared mirror pixels right. */
function paintPerfect(p: Pt, d: 1 | -1) {
  for (const q of mirrorSpots(p.x, p.y, doc.w, doc.h, symH, symV)) {
    if (q.x < 0 || q.y < 0 || q.x >= doc.w || q.y >= doc.h) continue;
    const i = q.y * doc.w + q.x;
    if (!allowed(i)) continue;
    const n = (refs.get(i) ?? 0) + d;
    refs.set(i, n);
    if (d > 0) stroke!.set(i, color); else if (n <= 0) stroke!.revert(i);
  }
}
function addPoint(p: Pt) {
  if (!usePerfect()) { stamp(p, color); return; }
  paintPerfect(p, 1);
  const removed = pushPerfect(kept, p);
  if (removed) paintPerfect(removed, -1);
}
function extend(to: Pt) {
  const seg = line(lastDrawn.x, lastDrawn.y, to.x, to.y);
  seg.shift();
  for (const p of seg) addPoint(p);
  lastDrawn = to;
}

function shapePoints(a: Pt, b: Pt, shift: boolean): Pt[] {
  let dx = b.x - a.x, dy = b.y - a.y;
  if (shift) {
    if (tool === 'line') {
      if (Math.abs(dx) > 2 * Math.abs(dy)) dy = 0;
      else if (Math.abs(dy) > 2 * Math.abs(dx)) dx = 0;
      else { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx) * m; dy = Math.sign(dy) * m; }
    } else { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = (Math.sign(dx) || 1) * m; dy = (Math.sign(dy) || 1) * m; }
  }
  const e = { x: a.x + dx, y: a.y + dy };
  if (tool === 'line') return line(a.x, a.y, e.x, e.y);
  return (tool === 'rect' ? rectPoints : ellipsePoints)(a.x, a.y, e.x, e.y, fillShape);
}
function drawShape(p: Pt, shift: boolean) {
  stroke!.revertAll();
  const solid = fillShape && tool !== 'line';
  for (const q of shapePoints(start, p, shift)) {
    if (solid) put(q.x, q.y, color); else stamp(q, color);
  }
}

function doFill(p: Pt, c: number) {
  const L = doc.layer;
  if (!inDoc(p) || L.px[p.y * doc.w + p.x] === c) return;
  let idx = floodFill(L.px, doc.w, doc.h, p.x, p.y);
  if (sel) idx = idx.filter((i) => sel![i] === 1); // a selection limits where fill can reach
  if (!idx.length) return;
  const before = new Uint32Array(idx.length), after = new Uint32Array(idx.length).fill(c);
  for (let k = 0; k < idx.length; k++) before[k] = L.px[idx[k]];
  const ch: PixelChange = { kind: 'px', name: 'Fill', layer: L.id, idx, before, after };
  doc.apply(ch, true);
  history.push(ch); afterChange();
}

/** The picker reads the visible result; with Alt held it reads only the selected layer. */
function pick(p: Pt, button: number, layerOnly = false) {
  if (!inDoc(p)) return;
  const v = (layerOnly ? doc.layer.px : doc.data)[p.y * doc.w + p.x];
  if (v >>> 24 === 0) return toast('That pixel is transparent');
  (button === 2 ? setBg : setFg)(u32ToHex(v));
}

function canDraw() {
  const L = doc.layer;
  if (!L.visible) toast('This layer is hidden. Show it to draw on it.');
  else if (L.locked) toast('This layer is locked. Unlock it to draw on it.');
  return L.visible && !L.locked;
}

// ---------- selection ----------
function setSelection(m: Mask | null) {
  sel = m;
  view.setSelection(m);
  const b = m && maskBox(m, doc.w, doc.h);
  $('ssel').textContent = b ? `${b.x1 - b.x0 + 1} × ${b.y1 - b.y0 + 1}` : '–';
}

/** A history entry that changes pixels and the selection together, so undo and redo put both back. */
function selEntry(name: string, pc: PixelChange | null, before: Mask | null, after: Mask | null): LayerChange {
  const n = doc.w * doc.h, b = encodeMask(before), a = encodeMask(after);
  return {
    kind: 'layer', name, weight: (pc?.idx.length ?? 0) + (b?.length ?? 0) + (a?.length ?? 0),
    undo: () => { if (pc) doc.apply(pc, false); setSelection(decodeMask(b, n)); },
    redo: () => { if (pc) doc.apply(pc, true); setSelection(decodeMask(a, n)); },
  };
}
/** Any pixels are already changed; this moves the selection and records one undo step for both. */
function commitSelection(name: string, pc: PixelChange | null, after: Mask | null) {
  const before = sel;
  if (!pc && !before && !after) return;
  setSelection(after);
  history.push(selEntry(name, pc, before, after));
  afterChange();
}
const selectAll = () => commitSelection('Select all', null, allMask(doc.w, doc.h));
const deselect = () => { if (sel) commitSelection('Deselect', null, null); };
const invertSel = () => commitSelection('Invert selection', null, sel ? invertMask(sel) : allMask(doc.w, doc.h));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** What a move is carrying: the selected pixels of the active layer (or the whole layer when nothing is selected). */
interface MoveState { clip: Clip; whole: boolean; copy: boolean; start: Pt; dx: number; dy: number; mask: Mask | null }

function liftForMove() {
  const whole = !sel;
  const c = liftClip(doc.layer.px, sel ?? allMask(doc.w, doc.h), doc.w, doc.h);
  return c ? { clip: c, whole } : null;
}
/** Show the piece shifted by (dx, dy): undo what the last step did, clear the source (unless copying), then place it. */
function applyMove(s: Stroke, m: MoveState, dx: number, dy: number) {
  s.revertAll();
  const c = m.clip;
  if (!m.copy) {
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
      const k = y * c.w + x;
      if (c.mask[k] && c.px[k] >>> 24) s.set((c.y + y) * doc.w + c.x + x, 0); // only opaque pixels need clearing
    }
  }
  const pl = placeClip(c, dx, dy, doc.w, doc.h);
  for (let k = 0; k < pl.idx.length; k++) s.set(pl.idx[k], pl.color[k]);
  m.dx = dx; m.dy = dy; m.mask = pl.mask;
}
function startMove(p: Pt, e: PointerEvent) {
  const l = liftForMove();
  if (!l) return toast('Nothing to move');
  let opaque = 0;
  for (let k = 0; k < l.clip.px.length; k++) if (l.clip.mask[k] && l.clip.px[k] >>> 24) opaque++;
  if (opaque > MAX_LIVE_MOVE) return toast('That piece is too big to drag. Select a smaller area, or move it with the arrow keys.', 5000);
  stroke = new Stroke(doc, doc.layer);
  drag = { kind: 'move', m: { clip: l.clip, whole: l.whole, copy: e.ctrlKey || e.metaKey, start: p, dx: 0, dy: 0, mask: null } };
  canvas.setPointerCapture(e.pointerId);
}
function finishMove(m: MoveState) {
  const s = stroke;
  stroke = null;
  if (!s || (m.dx === 0 && m.dy === 0)) { view.selShift = { x: 0, y: 0 }; view.invalidate(); return; }
  const pc = s.commit(m.copy ? 'Copy and move' : 'Move');
  commitSelection(m.copy ? 'Copy and move' : 'Move', pc, m.whole ? sel : combine(null, m.mask!, 'replace'));
}
/**
 * Change many pixels of the active layer at once. A Stroke keeps a Map entry per pixel, which is too heavy for
 * millions of pixels, so big edits (delete, paste, rotate, arrow-key moves) build the undo arrays directly.
 */
function bulkChange(name: string, clear: number[], set: { idx: number[]; color: number[] }): PixelChange | null {
  const L = doc.layer, n = L.px.length, val = new Uint32Array(n), hit = new Uint8Array(n);
  for (const i of clear) hit[i] = 1;
  for (let k = 0; k < set.idx.length; k++) { hit[set.idx[k]] = 1; val[set.idx[k]] = set.color[k]; }
  let count = 0;
  for (let i = 0; i < n; i++) if (hit[i] && val[i] !== L.px[i]) count++;
  if (!count) return null;
  const idx = new Uint32Array(count), before = new Uint32Array(count), after = new Uint32Array(count);
  for (let i = 0, k = 0; i < n; i++) if (hit[i] && val[i] !== L.px[i]) { idx[k] = i; before[k] = L.px[i]; after[k] = val[i]; k++; }
  const ch: PixelChange = { kind: 'px', name, layer: L.id, idx, before, after };
  doc.apply(ch, true);
  return ch;
}
/** Canvas indices of the opaque pixels inside a mask on the active layer (the ones that must be cleared when they move away). */
function opaqueIn(mask: Mask): number[] {
  const px = doc.layer.px, out: number[] = [];
  eachInMask(mask, doc.w, doc.h, (i) => { if (px[i] >>> 24) out.push(i); });
  return out;
}
const MAX_LIVE_MOVE = 600_000; // dragging re-draws the piece on every mouse move, so very large pieces move with the arrow keys instead

function nudge(dx: number, dy: number) {
  if (!canDraw()) return;
  const l = liftForMove();
  if (!l) return;
  const pl = placeClip(l.clip, dx, dy, doc.w, doc.h);
  const ch = bulkChange('Nudge', opaqueIn(sel ?? allMask(doc.w, doc.h)), pl);
  commitSelection('Nudge', ch, l.whole ? sel : combine(null, pl.mask, 'replace'));
}

function copySel(quiet = false): boolean {
  if (!sel) { toast('Select something first'); return false; }
  clip = liftClip(doc.layer.px, sel, doc.w, doc.h);
  if (clip && !quiet) toast('Copied');
  return !!clip;
}
function deleteSel(name = 'Delete') {
  if (!sel) return toast('Select something first');
  if (!canDraw()) return;
  const ch = bulkChange(name, opaqueIn(sel), { idx: [], color: [] });
  if (ch) { history.push(ch); afterChange(); } else toast('Nothing to remove in the selection');
}
const cutSel = () => { if (copySel(true)) deleteSel('Cut'); };
function pasteClip() {
  if (!clip) return toast('Copy or cut something first');
  if (!canDraw()) return;
  const mid = view.toDoc(view.cw / 2, view.ch / 2); // land in the middle of what you are looking at
  const nx = clamp(Math.round(mid.x - clip.w / 2), 0, Math.max(0, doc.w - clip.w));
  const ny = clamp(Math.round(mid.y - clip.h / 2), 0, Math.max(0, doc.h - clip.h));
  const pl = placeClip(clip, nx - clip.x, ny - clip.y, doc.w, doc.h);
  commitSelection('Paste', bulkChange('Paste', [], pl), combine(null, pl.mask, 'replace'));
}

const TRANSFORMS = { fh: 'Flip horizontal', fv: 'Flip vertical', cw: 'Rotate 90° clockwise', ccw: 'Rotate 90° counter-clockwise', '180': 'Rotate 180°' } as const;
/** Flip or rotate the selection, or the whole active layer when nothing is selected. */
function transform(kind: keyof typeof TRANSFORMS) {
  if (!canDraw()) return;
  const whole = !sel, L = doc.layer;
  if (whole && (kind === 'cw' || kind === 'ccw') && doc.w !== doc.h) return toast('Select an area first. Turning a whole layer by 90° needs a square canvas.');
  const mask = sel ?? allMask(doc.w, doc.h);
  const c = liftClip(L.px, mask, doc.w, doc.h);
  if (!c) return;
  const t = kind === 'fh' ? flipClip(c, 'h') : kind === 'fv' ? flipClip(c, 'v') : rotateClip(c, kind);
  const pl = placeClip(t, 0, 0, doc.w, doc.h);
  const ch = bulkChange(TRANSFORMS[kind], opaqueIn(mask), pl);
  if (!ch && whole) return toast('Nothing to change on this layer');
  commitSelection(TRANSFORMS[kind], ch, whole ? null : combine(null, pl.mask, 'replace'));
}

function finishSelect(d: Extract<Drag, { kind: 'marquee' | 'lasso' }>) {
  const click = d.kind === 'marquee' ? d.a.x === d.b.x && d.a.y === d.b.y : d.pts.length < 3;
  if (click) { if (d.mode === 'replace') deselect(); return; }
  const m = d.kind === 'marquee' ? rectMask(doc.w, doc.h, d.a.x, d.a.y, d.b.x, d.b.y) : polygonMask(doc.w, doc.h, d.pts);
  commitSelection('Select', null, combine(sel, m, d.mode));
}

const canvas = $('view') as HTMLCanvasElement;
const local = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; };

function updateHover(p: Pt | null) {
  if (!p || !inDoc(p)) { view.hover = null; $('sx').textContent = '–'; view.invalidate(); return; }
  const s = BRUSH.includes(tool) ? size : 1, o = s > 1 ? brushOrigin() : 0;
  view.hover = { x: p.x - o, y: p.y - o, size: s };
  $('sx').textContent = `${p.x}, ${p.y}`;
  view.invalidate();
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (drag) return;
  const { sx, sy } = local(e);
  const p = view.toDoc(sx, sy);
  if (e.button === 1 || (e.button === 0 && (space || tool === 'pan'))) {
    drag = { kind: 'pan', x: e.clientX, y: e.clientY };
    $('stage').classList.add('panning'); canvas.setPointerCapture(e.pointerId); e.preventDefault(); return;
  }
  if (e.button !== 0 && e.button !== 2) return;
  const drawTools: ToolId[] = ['pencil', 'eraser', 'fill', 'line', 'rect', 'ellipse'];
  if (e.altKey && drawTools.includes(tool)) return pick(p, e.button);
  if (tool === 'picker') return pick(p, e.button, e.altKey);
  if (tool === 'zoom') return view.zoomStep(e.altKey || e.button === 2 ? -1 : 1, sx, sy);
  if (SELECT_TOOLS.includes(tool)) {
    if (e.button !== 0) return;
    const mode: SelMode = e.shiftKey ? 'add' : e.altKey ? 'sub' : selMode;
    if (tool === 'wand') {
      if (inDoc(p)) commitSelection('Magic wand', null, combine(sel, wandMask(doc.layer.px, doc.w, doc.h, p.x, p.y, wandTouching), mode));
      return;
    }
    drag = tool === 'marquee' ? { kind: 'marquee', a: p, b: p, mode } : { kind: 'lasso', pts: [p], mode };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (tool === 'move') { if (e.button === 0 && canDraw()) startMove(p, e); return; }
  if (!canDraw()) return;
  color = tool === 'eraser' ? 0 : hexToU32(e.button === 2 ? bg : fg);
  if (tool !== 'eraser') pushRecent(e.button === 2 ? bg : fg);
  if (tool === 'fill') return doFill(p, color);

  stroke = new Stroke(doc, doc.layer);
  drag = { kind: 'draw' };
  canvas.setPointerCapture(e.pointerId);
  start = p; kept = []; refs.clear();
  if (tool === 'pencil' || tool === 'eraser') {
    if (e.shiftKey && lastPt) { kept = [lastPt]; lastDrawn = lastPt; extend(p); }
    else { lastDrawn = p; addPoint(p); }
  } else drawShape(p, e.shiftKey);
  view.invalidate();
});

canvas.addEventListener('pointermove', (e) => {
  const { sx, sy } = local(e);
  const p = view.toDoc(sx, sy);
  if (!drag) return updateHover(p);
  if (drag.kind === 'pan') {
    view.ox = Math.round(view.ox + e.clientX - drag.x); view.oy = Math.round(view.oy + e.clientY - drag.y);
    drag.x = e.clientX; drag.y = e.clientY; view.invalidate(); return;
  }
  if (drag.kind === 'marquee') {
    drag.b = p; view.marquee = { x0: drag.a.x, y0: drag.a.y, x1: p.x, y1: p.y };
    updateHover(p); return;
  }
  if (drag.kind === 'lasso') {
    const last = drag.pts[drag.pts.length - 1];
    if (last.x !== p.x || last.y !== p.y) drag.pts.push(p);
    view.lasso = drag.pts;
    updateHover(p); return;
  }
  if (drag.kind === 'move') {
    const m = drag.m, dx = p.x - m.start.x, dy = p.y - m.start.y;
    if (dx !== m.dx || dy !== m.dy) { applyMove(stroke!, m, dx, dy); if (!m.whole) view.selShift = { x: dx, y: dy }; }
    updateHover(p); return;
  }
  if (tool === 'pencil' || tool === 'eraser') {
    const evs = e.getCoalescedEvents?.() ?? [];
    for (const ce of evs.length ? evs : [e]) { const c = local(ce); extend(view.toDoc(c.sx, c.sy)); }
    lastPt = lastDrawn;
  } else drawShape(p, e.shiftKey);
  updateHover(p);
  view.invalidate();
});

function endDrag() {
  const d = drag;
  drag = null;
  $('stage').classList.remove('panning');
  if (!d || d.kind === 'pan') return;
  if (d.kind === 'marquee' || d.kind === 'lasso') { view.marquee = null; view.lasso = null; finishSelect(d); view.invalidate(); return; }
  if (d.kind === 'move') { finishMove(d.m); return; }
  if (!stroke) return;
  if (tool === 'pencil' || tool === 'eraser') lastPt = lastDrawn;
  const ch = stroke.commit(NAMES[tool]);
  stroke = null;
  if (ch) { history.push(ch); afterChange(); }
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { if (!drag) updateHover(null); });

let wheelAcc = 0;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) < 40) return;
  const { sx, sy } = local(e as unknown as PointerEvent);
  view.zoomStep(wheelAcc < 0 ? 1 : -1, sx, sy);
  wheelAcc = 0;
}, { passive: false });

// drop an image on the canvas to open it
const stage = $('stage');
stage.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
stage.addEventListener('drop', async (e) => {
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  e.preventDefault();
  await openBlob(f, f.name);
});

// ---------- file actions ----------
const baseName = () => docName.replace(/\.[^.]+$/, '');
async function openBlob(file: Blob, name: string) {
  try {
    if (file.size > 300_000_000) throw new RangeError('That file is too large to open.');
    if (name.toLowerCase().endsWith(EXT)) {
      const r = await decodeProject(file);
      if (r.palette.length) { palette = r.palette; renderPalette(); }
      loadDocument(r.doc, name);
    } else loadDocument(await fromImage(file), name);
    toast(`Opened ${name}`);
  } catch (err) {
    toast(err instanceof RangeError || err instanceof ProjectError ? err.message : 'Pixfold could not open that file. Use a Pixfold project, PNG, GIF or WebP file.');
  }
}
let busy = false; // a double press of Ctrl+S or Ctrl+O must not open two dialogs
async function openFile() {
  if (busy) return;
  busy = true;
  try { const r = await pickFile(); if (r) await openBlob(r.file, r.file.name); }
  catch { toast('Could not open the file picker'); }
  finally { busy = false; }
}
async function saveFile() {
  if (busy) return;
  busy = true;
  try {
    const name = await saveBlob(await encodeProject(doc, palette), baseName() + EXT, 'project');
    if (name) { docName = name; $('fname').textContent = name; toast(`Saved ${name}`); scheduleSave(); }
  } catch { toast('Could not save the project'); }
  finally { busy = false; }
}

const dnew = $('dnew') as HTMLDialogElement, dexp = $('dexp') as HTMLDialogElement;
function openNew() {
  $('nwarn').hidden = history.items.length === 0;
  $('nerr').hidden = true;
  ($('nw') as HTMLInputElement).value = String(doc.w); ($('nh') as HTMLInputElement).value = String(doc.h);
  dnew.showModal();
  ($('nw') as HTMLInputElement).select();
}
const presets = $('presets');
for (const n of [16, 32, 64, 128, 256]) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = `${n}×${n}`;
  b.onclick = () => { ($('nw') as HTMLInputElement).value = String(n); ($('nh') as HTMLInputElement).value = String(n); };
  presets.append(b);
}
$('ncancel').onclick = () => dnew.close();
$('fnew').addEventListener('submit', (e) => {
  e.preventDefault();
  const w = Number(($('nw') as HTMLInputElement).value), h = Number(($('nh') as HTMLInputElement).value);
  try { loadDocument(new Doc(w, h), 'untitled.pfold'); dnew.close(); }
  catch { const er = $('nerr'); er.textContent = `Width and height must be whole numbers from 1 to ${MAX_SIZE}.`; er.hidden = false; }
});

let expScale = 1;
function openExport() {
  const box = $('scales');
  box.replaceChildren();
  const max = maxScale(doc.w, doc.h);
  if (expScale > max) expScale = 1;
  for (const s of SCALES) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = `${s}×`; b.disabled = s > max;
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(s === expScale));
    b.classList.toggle('on', s === expScale);
    b.onclick = () => { expScale = s; openExport.refresh(); };
    box.append(b);
  }
  openExport.refresh();
  if (!dexp.open) dexp.showModal();
}
openExport.refresh = () => {
  document.querySelectorAll<HTMLButtonElement>('#scales button').forEach((b) => {
    const on = b.textContent === `${expScale}×`;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  });
  $('expinfo').textContent = `Output size: ${doc.w * expScale} × ${doc.h * expScale} px`;
};
$('xcancel').onclick = () => dexp.close();
$('fexp').addEventListener('submit', async (e) => {
  e.preventDefault();
  dexp.close();
  try {
    const base = baseName();
    const name = await saveBlob(await toPng(doc, expScale), expScale > 1 ? `${base}-${expScale}x.png` : `${base}.png`, 'png');
    if (name) toast(`Exported ${name}`);
  } catch { toast('Could not export the image'); }
});
$('export').onclick = openExport;

// ---------- edit actions ----------
function undo() { if (history.undo(doc)) afterChange(); }
function redo() { if (history.redo(doc)) afterChange(); }
$('undo').onclick = undo; $('redo').onclick = redo;
function clearLayer() {
  if (!canDraw()) return;
  const clear: number[] = [], px = doc.layer.px;
  for (let i = 0; i < px.length; i++) if (px[i]) clear.push(i);
  const ch = bulkChange('Clear layer', clear, { idx: [], color: [] });
  if (ch) { history.push(ch); afterChange(); } else toast('This layer is already empty');
}
const toggleGrid = () => { view.grid = !view.grid; view.invalidate(); };

// ---------- menus ----------
type Item = '-' | { label: string; key?: string; run: () => void; off?: () => boolean; check?: () => boolean };
const MENUS: Record<string, Item[]> = {
  file: [
    { label: 'New…', key: 'Ctrl+N', run: openNew }, { label: 'Open…', key: 'Ctrl+O', run: openFile }, '-',
    { label: 'Save project', key: 'Ctrl+S', run: saveFile }, { label: 'Export PNG…', key: 'Ctrl+E', run: openExport },
  ],
  layer: [
    { label: 'New layer', key: 'Shift+N', run: addLayer, off: () => !doc.canAddLayer },
    { label: 'Duplicate layer', run: dupLayer, off: () => !doc.canAddLayer },
    { label: 'Delete layer', run: delLayer, off: () => doc.layers.length < 2 },
    { label: 'Merge down', run: mergeDown, off: () => doc.active < 1 }, '-',
    { label: 'Move up', run: () => moveLayer(1), off: () => doc.active >= doc.layers.length - 1 },
    { label: 'Move down', run: () => moveLayer(-1), off: () => doc.active < 1 }, '-',
    { label: 'Rename…', run: () => startRename(doc.active) },
    { label: 'Clear layer', run: clearLayer },
  ],
  edit: [
    { label: 'Undo', key: 'Ctrl+Z', run: undo, off: () => history.pos === 0 },
    { label: 'Redo', key: 'Ctrl+Y', run: redo, off: () => history.pos >= history.items.length }, '-',
    { label: 'Cut', key: 'Ctrl+X', run: cutSel, off: () => !sel },
    { label: 'Copy', key: 'Ctrl+C', run: () => { copySel(); }, off: () => !sel },
    { label: 'Paste', key: 'Ctrl+V', run: pasteClip, off: () => !clip },
    { label: 'Delete', key: 'Del', run: () => deleteSel(), off: () => !sel }, '-',
    { label: 'Flip horizontal', key: 'Shift+H', run: () => transform('fh') },
    { label: 'Flip vertical', key: 'Shift+V', run: () => transform('fv') },
    { label: 'Rotate 90° clockwise', run: () => transform('cw') },
    { label: 'Rotate 90° counter-clockwise', run: () => transform('ccw') },
    { label: 'Rotate 180°', run: () => transform('180') },
  ],
  select: [
    { label: 'Select all', key: 'Ctrl+A', run: selectAll },
    { label: 'Deselect', key: 'Ctrl+D', run: deselect, off: () => !sel },
    { label: 'Invert selection', key: 'Ctrl+I', run: invertSel },
  ],
  view: [
    { label: 'Zoom in', key: '+', run: () => view.zoomStep(1) }, { label: 'Zoom out', key: '-', run: () => view.zoomStep(-1) },
    { label: 'Fit to window', key: 'Ctrl+0', run: () => view.fit() }, '-',
    { label: 'Pixel grid', key: "'", run: toggleGrid, check: () => view.grid },
    { label: 'Mirror horizontally', run: () => setSym(!symH, symV), check: () => symH },
    { label: 'Mirror vertically', run: () => setSym(symH, !symV), check: () => symV },
  ],
  palette: [
    { label: 'Add current colour', run: addColor },
    { label: 'Reset to default palette', run: () => { palette = [...DEFAULT_PALETTE]; renderPalette(); scheduleSave(); } },
  ],
};
const pop = $('menupop');
let openBtn: HTMLElement | null = null;
function closeMenu() { pop.hidden = true; openBtn?.setAttribute('aria-expanded', 'false'); openBtn = null; }
document.querySelectorAll<HTMLButtonElement>('[data-menu]').forEach((btn) => {
  btn.onclick = (e) => {
    e.stopPropagation();
    if (openBtn === btn) return closeMenu();
    closeMenu();
    pop.replaceChildren();
    for (const it of MENUS[btn.dataset.menu!]) {
      if (it === '-') { pop.append(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      b.setAttribute('role', it.check ? 'menuitemcheckbox' : 'menuitem');
      if (it.check) b.setAttribute('aria-checked', String(it.check()));
      b.disabled = it.off?.() ?? false;
      const l = document.createElement('span');
      l.textContent = (it.check?.() ? '✓ ' : '') + it.label;
      b.append(l);
      if (it.key) { const k = document.createElement('kbd'); k.textContent = it.key; b.append(k); }
      b.onclick = () => { closeMenu(); it.run(); };
      pop.append(b);
    }
    const r = btn.getBoundingClientRect();
    pop.style.left = `${r.left}px`; pop.style.top = `${r.bottom + 6}px`;
    pop.hidden = false; openBtn = btn; btn.setAttribute('aria-expanded', 'true');
    pop.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };
});
document.addEventListener('click', (e) => { if (!pop.contains(e.target as Node)) closeMenu(); });

// ---------- tool rail, options, zoom buttons ----------
function setTool(t: ToolId) { tool = t; refreshOptions(); updateHover(null); }
document.querySelectorAll<HTMLButtonElement>('.tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool as ToolId)));
$('size').addEventListener('input', () => {
  size = Number(($('size') as HTMLInputElement).value);
  $('sizev').textContent = `${size} px`;
  refreshOptions();
});
function bindSwitch(id: string, get: () => boolean, set: (v: boolean) => void) {
  const b = $(id);
  b.onclick = () => { set(!get()); b.setAttribute('aria-checked', String(get())); };
}
bindSwitch('pp', () => perfect, (v) => (perfect = v));
bindSwitch('fs', () => fillShape, (v) => (fillShape = v));
bindSwitch('wd', () => wandTouching, (v) => (wandTouching = v));
function setSym(h: boolean, v: boolean) {
  symH = h; symV = v;
  view.sym = { h, v };
  $('symh').setAttribute('aria-pressed', String(h)); $('symv').setAttribute('aria-pressed', String(v));
  view.invalidate();
}
$('symh').onclick = () => setSym(!symH, symV);
$('symv').onclick = () => setSym(symH, !symV);
document.querySelectorAll<HTMLButtonElement>('[data-selmode]').forEach((b) => (b.onclick = () => {
  selMode = b.dataset.selmode as SelMode;
  document.querySelectorAll<HTMLButtonElement>('[data-selmode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
$('zin').onclick = () => view.zoomStep(1);
$('zout').onclick = () => view.zoomStep(-1);
($('fgin') as HTMLInputElement).addEventListener('input', (e) => setFg((e.target as HTMLInputElement).value));
($('bgin') as HTMLInputElement).addEventListener('input', (e) => setBg((e.target as HTMLInputElement).value));

// ---------- keyboard ----------
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]') || typing(e.target)) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod) {
    const run = {
      z: e.shiftKey ? redo : undo, y: redo, s: saveFile, o: openFile, n: openNew, e: openExport, '0': () => view.fit(),
      a: selectAll, d: deselect, i: invertSel, c: () => { copySel(); }, x: cutSel, v: pasteClip,
    }[k];
    if (run) { e.preventDefault(); run(); }
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); if (!space) { space = true; $('stage').classList.add('pan'); } return; }
  if (e.key === 'Escape') { if (!pop.hidden) closeMenu(); else deselect(); return; }
  if (k === 'n' && e.shiftKey) { e.preventDefault(); return addLayer(); }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); return deleteSel(); }
  if (e.shiftKey && k === 'h') { e.preventDefault(); return transform('fh'); }
  if (e.shiftKey && k === 'v') { e.preventDefault(); return transform('fv'); }
  if (tool === 'move' && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const d = e.shiftKey ? 8 : 1;
    return nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0);
  }
  if (k in KEYS) return setTool(KEYS[k]);
  if (k === 'x') { const t = fg; setFg(bg); setBg(t); }
  else if (k === '[') bumpSize(-1);
  else if (k === ']') bumpSize(1);
  else if (k === '+' || k === '=') view.zoomStep(1);
  else if (k === '-' || k === '_') view.zoomStep(-1);
  else if (k === "'") toggleGrid();
});
addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || typing(e.target)) return;
  e.preventDefault();
  space = false; $('stage').classList.toggle('pan', tool === 'pan');
});
function bumpSize(d: number) {
  size = Math.min(64, Math.max(1, size + d));
  ($('size') as HTMLInputElement).value = String(size);
  $('sizev').textContent = `${size} px`;
  refreshOptions();
}

// ---------- start ----------
async function boot() {
  let d: Doc | null = null;
  let restoreFailed = false;
  const s = await loadDoc();
  if (s) {
    try {
      if (s.project instanceof Blob) {
        d = (await decodeProject(s.project)).doc;
      } else if (s.layers?.length) {
        const specs = s.layers.map((l) => ({ ...l, px: new Uint32Array(l.buffer) }));
        d = Doc.fromLayers(s.w, s.h, specs, s.active ?? 0);
      } else if (s.buffer && s.buffer.byteLength === s.w * s.h * 4) d = new Doc(s.w, s.h, new Uint32Array(s.buffer)); // saved by 0.1
    } catch { d = null; }
    restoreFailed = !d;
  }
  if (d && s) {
    try {
      if (Array.isArray(s.palette) && s.palette.length && s.palette.every((c) => HEX.test(c))) palette = s.palette;
      if (HEX.test(s.fg)) fg = s.fg;
      if (HEX.test(s.bg)) bg = s.bg;
      if (typeof s.name === 'string') docName = s.name;
    } catch { d = null; }
  }
  doc = d ?? new Doc(32, 32);
  view = new View(canvas, doc);
  view.onDraw = () => {
    const z = `${Math.round(view.zoom * 100)}%`;
    if ($('zlabel').textContent !== z) { $('zlabel').textContent = z; refreshInfo(); }
    const m = $('mini') as HTMLCanvasElement, g = m.getContext('2d')!;
    g.clearRect(0, 0, 72, 72);
    const sc = Math.min(72 / doc.w, 72 / doc.h), w = doc.w * sc, h = doc.h * sc;
    g.imageSmoothingEnabled = false;
    g.drawImage(view.off, (72 - w) / 2, (72 - h) / 2, w, h);
  };
  applyTheme();
  renderPalette();
  $('fname').textContent = docName;
  $('sc').textContent = `${doc.w} × ${doc.h}`;
  $('saved').textContent = d ? 'Restored your last drawing' : 'Not saved yet';
  refreshOptions(); refreshHistory(); renderLayers(); refreshInfo(); scheduleCount();
  view.invalidate();
  if (restoreFailed) toast('Your last drawing could not be restored.', 8000);
}
void boot();
