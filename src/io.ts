import { Doc, MAX_SIZE } from './doc';

export const MAX_EXPORT = 16384;
export const SCALES = [1, 2, 4, 8, 16];

export function maxScale(w: number, h: number) {
  return Math.max(1, Math.floor(MAX_EXPORT / Math.max(w, h)));
}

function surface(doc: Doc) {
  const c = document.createElement('canvas');
  c.width = doc.w; c.height = doc.h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(doc.data.buffer.slice(0) as ArrayBuffer), doc.w, doc.h), 0, 0);
  return c;
}

export function toPng(doc: Doc, scale = 1): Promise<Blob> {
  const src = surface(doc);
  let out = src;
  if (scale > 1) {
    out = document.createElement('canvas');
    out.width = doc.w * scale; out.height = doc.h * scale;
    const g = out.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.drawImage(src, 0, 0, out.width, out.height);
  }
  return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('Could not create the PNG'))), 'image/png'));
}

export async function fromImage(file: Blob): Promise<Doc> {
  const bmp = await createImageBitmap(file);
  try {
    if (bmp.width > MAX_SIZE || bmp.height > MAX_SIZE)
      throw new RangeError(`That image is ${bmp.width}×${bmp.height}. Pixfold opens images up to ${MAX_SIZE}×${MAX_SIZE}.`);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height);
    return new Doc(c.width, c.height, new Uint32Array(px.data.buffer));
  } finally { bmp.close(); }
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const pngTypes = [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }];

/** Save with the system dialog where the browser has one; otherwise a normal download. Returns the saved name or null if cancelled. */
export async function savePng(blob: Blob, suggested: string): Promise<string | null> {
  const w = window as any;
  if (w.showSaveFilePicker) {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: suggested, types: pngTypes });
      const s = await h.createWritable();
      await s.write(blob); await s.close();
      return h.name as string;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  download(blob, suggested);
  return suggested;
}

export async function pickPng(): Promise<{ file: File } | null> {
  const w = window as any;
  if (w.showOpenFilePicker) {
    try {
      const [h] = await w.showOpenFilePicker({ types: [{ description: 'Images', accept: { 'image/png': ['.png'], 'image/gif': ['.gif'], 'image/webp': ['.webp'] } }] });
      return { file: await h.getFile() };
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'image/png,image/gif,image/webp';
    i.onchange = () => res(i.files?.[0] ? { file: i.files[0] } : null);
    i.addEventListener('cancel', () => res(null));
    i.click();
  });
}
