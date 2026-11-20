// The .pfold project file: 5 header bytes ("PFLD" + version), then a gzip stream holding
// [u32 JSON length][JSON: size, active layer, palette, layer settings][raw RGBA bytes of each layer, bottom first].
import { Doc, MAX_SIZE, type LayerSpec } from './doc';

export const EXT = '.pfold';
const MAGIC = [0x50, 0x46, 0x4c, 0x44];
const VERSION = 1;
const LIMIT = 700_000_000; // most data we will unpack, so a tiny hostile file cannot fill memory
const HEX = /^#[0-9a-f]{6}$/;

export class ProjectError extends Error {}

export async function encodeProject(doc: Doc, palette: string[]): Promise<Blob> {
  const meta = {
    w: doc.w, h: doc.h, active: doc.active, palette,
    layers: doc.layers.map((l) => ({ name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend })),
  };
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, json.length, true);
  const parts: BlobPart[] = [head, json, ...doc.layers.map((l) => new Uint8Array(l.px.buffer as ArrayBuffer, l.px.byteOffset, l.px.byteLength))];
  const packed = await new Response(new Blob(parts).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  return new Blob([new Uint8Array([...MAGIC, VERSION]), packed], { type: 'application/octet-stream' });
}

async function unpack(file: Blob): Promise<Uint8Array> {
  const reader = file.slice(5).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LIMIT) { await reader.cancel(); throw new ProjectError('This project is too large to open.'); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return all;
}

export async function decodeProject(file: Blob): Promise<{ doc: Doc; palette: string[] }> {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (head.length < 5 || MAGIC.some((b, i) => head[i] !== b)) throw new ProjectError('That is not a Pixfold project file.');
  if (head[4] > VERSION) throw new ProjectError('This project was made with a newer version of Pixfold.');
  let bytes: Uint8Array;
  try { bytes = await unpack(file); }
  catch (e) { throw e instanceof ProjectError ? e : new ProjectError('This project file is damaged.'); }

  const damaged = () => new ProjectError('This project file is damaged.');
  if (bytes.length < 4) throw damaged();
  const jsonLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  if (jsonLen > 1_000_000 || 4 + jsonLen > bytes.length) throw damaged();
  let meta: any;
  try { meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jsonLen))); } catch { throw damaged(); }

  const { w, h } = meta ?? {};
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > MAX_SIZE || h > MAX_SIZE) throw damaged();
  if (!Array.isArray(meta.layers) || meta.layers.length < 1 || meta.layers.length > 100) throw damaged();
  const size = w * h * 4;
  if (bytes.length !== 4 + jsonLen + meta.layers.length * size) throw damaged();

  const specs: LayerSpec[] = meta.layers.map((m: any, k: number) => {
    const at = 4 + jsonLen + k * size;
    return {
      name: typeof m?.name === 'string' ? m.name : '', visible: m?.visible !== false, locked: m?.locked === true,
      opacity: m?.opacity, blend: String(m?.blend), px: new Uint32Array(bytes.slice(at, at + size).buffer),
    };
  });
  let doc: Doc;
  try { doc = Doc.fromLayers(w, h, specs, meta.active); } catch { throw damaged(); }
  const palette = Array.isArray(meta.palette) ? meta.palette.filter((c: unknown): c is string => typeof c === 'string' && HEX.test(c)).slice(0, 256) : [];
  return { doc, palette };
}
