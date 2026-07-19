/**
 * assets.js — Material Manager: upload, validate, categorize, library persistence.
 */
import { db, assetUrl, invalidateAssetUrl } from './db.js';
import { uid, kindFromMime, probeMedia } from '../utils.js';
import { emit } from '../store.js';

const MAX_SIZE = 500 * 1024 * 1024;

/** Extension → {mime, kind} fallback (many files arrive with empty/odd MIME types) */
const EXT_MAP = {
  png: ['image/png', 'image'], jpg: ['image/jpeg', 'image'], jpeg: ['image/jpeg', 'image'],
  webp: ['image/webp', 'image'], gif: ['image/gif', 'gif'],
  mp4: ['video/mp4', 'video'], m4v: ['video/mp4', 'video'], mov: ['video/quicktime', 'video'],
  webm: ['video/webm', 'video'], mkv: ['video/x-matroska', 'video'], avi: ['video/x-msvideo', 'video'],
  mp3: ['audio/mpeg', 'audio'], wav: ['audio/wav', 'audio'], ogg: ['audio/ogg', 'audio'],
  m4a: ['audio/mp4', 'audio'], aac: ['audio/aac', 'audio'], flac: ['audio/flac', 'audio'],
};

/** Resolve the real mime+kind of a file — MIME first, extension fallback. */
export function resolveFileType(file) {
  let mime = file.type || '';
  let kind = mime ? kindFromMime(mime) : 'other';
  if (kind === 'other') {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const hit = EXT_MAP[ext];
    if (hit) { mime = hit[0]; kind = hit[1]; }
  }
  return { mime, kind };
}

/**
 * Import a File into the library.
 * @param {File} file
 * @param {string} category vtuber|background|broll|meme|music|sfx|other
 */
export async function importFile(file, category = 'other', extra = {}) {
  const { mime, kind } = resolveFileType(file);
  if (kind === 'other') throw new Error(`Unsupported file type: ${file.type || file.name}`);
  if (file.size > MAX_SIZE) throw new Error('File too large (max 500MB)');
  const meta = await probeMedia(file, kind === 'gif' ? 'image' : kind);
  // sanity check: a "video" that decodes with no dimensions and no duration is broken
  if (kind === 'video' && !meta.width && !meta.duration) {
    throw new Error(`Cannot decode video "${file.name}" — codec may be unsupported by the browser (try MP4/H.264 or WebM)`);
  }
  const asset = {
    id: uid(), name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name,
    mime, kind, category, size: file.size,
    duration: meta.duration || 0, width: meta.width || 0, height: meta.height || 0,
    createdAt: Date.now(), favorite: false, tags: extra.tags || [], bgCategory: extra.bgCategory || null,
    lastUsed: 0,
    blob: file,
  };
  await db.saveAsset(asset);
  emit('assets');
  return asset;
}

export async function listAssets(filter = {}) {
  let all = await db.listAssets();
  if (filter.category) all = all.filter(a => a.category === filter.category);
  if (filter.kind) all = all.filter(a => a.kind === filter.kind);
  if (filter.search) {
    const q = filter.search.toLowerCase();
    all = all.filter(a => a.name.toLowerCase().includes(q) || a.tags?.some(t => t.toLowerCase().includes(q)));
  }
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function removeAsset(id) {
  invalidateAssetUrl(id);
  await db.deleteAsset(id);
  emit('assets');
}

export async function markUsed(id) {
  const a = await db.getAsset(id);
  if (a) { a.lastUsed = Date.now(); await db.saveAsset(a); }
}

export async function toggleFavorite(id) {
  const a = await db.getAsset(id);
  if (a) { a.favorite = !a.favorite; await db.saveAsset(a); emit('assets'); }
}

export { assetUrl };
