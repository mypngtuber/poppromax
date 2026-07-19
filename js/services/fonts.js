/**
 * fonts.js — system font detection + custom TTF/OTF import.
 */
import { db } from './db.js';
import { emit } from '../store.js';

const COMMON_FONTS = [
  'Arial', 'Arial Black', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Impact',
  'Times New Roman', 'Georgia', 'Garamond', 'Courier New', 'Comic Sans MS',
  'Segoe UI', 'Calibri', 'Cambria', 'Consolas', 'Franklin Gothic Medium',
  'Gill Sans', 'Helvetica', 'Futura', 'Optima', 'Rockwell', 'Bahnschrift',
  'Cairo', 'Inter', 'Amiri', 'Noto Sans Arabic', 'Segoe Print',
];

let detected = null;
const customFonts = new Map();

/** Detect installed fonts. Uses Local Font Access API when available, else canvas probing. */
export async function detectSystemFonts() {
  if (detected) return detected;
  const found = new Set(['Cairo', 'Inter']); // bundled webfonts
  try {
    if ('queryLocalFonts' in window) {
      const fonts = await window.queryLocalFonts();
      for (const f of fonts) found.add(f.family);
    } else {
      throw new Error('no API');
    }
  } catch {
    // canvas width probing fallback
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const test = 'mmmmmmmmmmlliWWW';
    ctx.font = '72px monospace';
    const base = ctx.measureText(test).width;
    for (const f of COMMON_FONTS) {
      ctx.font = `72px "${f}", monospace`;
      if (Math.abs(ctx.measureText(test).width - base) > 0.5) found.add(f);
    }
  }
  detected = [...found].sort((a, b) => a.localeCompare(b));
  return detected;
}

/** Import a TTF/OTF file — available instantly + persisted */
export async function importFont(file) {
  const name = file.name.replace(/\.(ttf|otf)$/i, '');
  const buf = await file.arrayBuffer();
  const face = new FontFace(name, buf);
  await face.load();
  document.fonts.add(face);
  customFonts.set(name, true);
  await db.kvSet('font_' + name, { name, data: await blobToDataUrl(new Blob([buf])) });
  const fonts = (await db.kvGet('customFontList')) || [];
  if (!fonts.includes(name)) { fonts.push(name); await db.kvSet('customFontList', fonts); }
  if (detected && !detected.includes(name)) detected.push(name);
  emit('fonts');
  return name;
}

/** Restore persisted custom fonts on boot */
export async function restoreCustomFonts() {
  const fonts = (await db.kvGet('customFontList')) || [];
  for (const name of fonts) {
    try {
      const rec = await db.kvGet('font_' + name);
      if (!rec?.data) continue;
      const res = await fetch(rec.data);
      const face = new FontFace(name, await res.arrayBuffer());
      await face.load();
      document.fonts.add(face);
      customFonts.set(name, true);
    } catch { /* skip broken font */ }
  }
  return fonts;
}

export function getCustomFonts() { return [...customFonts.keys()]; }

function blobToDataUrl(blob) {
  return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}
