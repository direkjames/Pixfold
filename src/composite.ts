// Pure colour maths for flattening layers. Colours are packed 0xAABBGGRR; alpha is straight (not premultiplied).
export const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'] as const;
export type Blend = (typeof BLENDS)[number];

const MIX: Record<Exclude<Blend, 'normal'>, (b: number, s: number) => number> = {
  multiply: (b, s) => (b * s) / 255,
  screen: (b, s) => b + s - (b * s) / 255,
  overlay: (b, s) => (b < 128 ? (2 * b * s) / 255 : 255 - (2 * (255 - b) * (255 - s)) / 255),
  darken: (b, s) => Math.min(b, s),
  lighten: (b, s) => Math.max(b, s),
};

/** Lay `src` (with a layer opacity 0-100 and blend mode) over `dst`. */
export function blendPixel(dst: number, src: number, opacity: number, mode: Blend): number {
  const sa0 = src >>> 24;
  if (sa0 === 0 || opacity <= 0) return dst;
  if (sa0 === 255 && opacity >= 100 && mode === 'normal') return src;
  const sa = (sa0 / 255) * (opacity / 100);
  const da = (dst >>> 24) / 255;
  const oa = sa + da * (1 - sa);
  const mix = mode === 'normal' ? null : MIX[mode];
  let out = 0;
  for (let shift = 0; shift < 24; shift += 8) {
    const cb = (dst >>> shift) & 255, cs = (src >>> shift) & 255;
    const s = mix ? (1 - da) * cs + da * mix(cb, cs) : cs;
    const c = oa === 0 ? 0 : (s * sa + cb * da * (1 - sa)) / oa;
    out |= Math.min(255, Math.max(0, Math.round(c))) << shift;
  }
  return (out | (Math.round(oa * 255) << 24)) >>> 0;
}
