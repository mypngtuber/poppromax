/**
 * store.js — central app state + unlimited undo/redo history + autosave.
 * Event-driven: subscribe(event, fn). Events: project, timeline, selection,
 * playback, assets, settings, ai, route.
 */
import { db } from './services/db.js';
import { APP, VIDEO, VTUBER_DEFAULTS, CHROMA_DEFAULTS, CAPTION_DEFAULTS, MUSIC_DEFAULTS, GEMINI_DEFAULT_MODEL, TRACKS } from './config.js';
import { uid, encryptLocal, decryptLocal } from './utils.js';

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, data) { listeners.get(event)?.forEach(fn => fn(data)); }

/* ---------------- settings ---------------- */
export const settings = {
  get apiKey() { const e = localStorage.getItem('vt_api_key'); return e ? decryptLocal(e) : ''; },
  set apiKey(v) { v ? localStorage.setItem('vt_api_key', encryptLocal(v)) : localStorage.removeItem('vt_api_key'); },
  get model() { return localStorage.getItem('vt_model') || GEMINI_DEFAULT_MODEL; },
  set model(v) { localStorage.setItem('vt_model', v); },
};

/* ---------------- project factory ---------------- */
export function createProjectData(name) {
  const now = Date.now();
  return {
    id: uid(), name, version: APP.version,
    createdAt: now, updatedAt: now, archived: false,
    video: { ...VIDEO },
    duration: 30,
    tracks: TRACKS.map(t => ({ ...t, locked: false, hidden: false, muted: false })),
    clips: [],          // all clips across tracks
    captions: [],       // word-level: {id,start,end,text}
    captionStyle: { ...CAPTION_DEFAULTS },
    vtuber: { assetId: null, ...VTUBER_DEFAULTS, chroma: { ...CHROMA_DEFAULTS } },
    background: { assetId: null, type: 'color', color: '#101018' },
    musicSettings: { ...MUSIC_DEFAULTS },
    aiAnalysis: null,   // Gemini JSON
    materials: [],      // material requests
    markers: [],
  };
}

export function createClip(trackId, opts = {}) {
  return {
    id: uid(), trackId,
    start: 0, duration: 3, inPoint: 0,
    assetId: null, name: '',
    // transform
    x: VIDEO.width / 2, y: VIDEO.height / 2, scale: 100, rotation: 0, opacity: 100,
    flipH: false, flipV: false,
    // fx
    transitionIn: 'fade', transitionOut: 'fade', transDur: 0.3, animation: 'none',
    // audio
    volume: 0, muted: false, fadeIn: 0, fadeOut: 0, // volume in dB
    // caption clip only
    text: '', words: null,
    ...opts,
  };
}

/* ---------------- state ---------------- */
export const state = {
  route: 'dashboard',
  project: null,            // active project data (mutable current)
  selection: [],            // selected clip ids
  playhead: 0,
  playing: false,
  dirty: false,
};

/* ---------------- history (unlimited undo/redo) ---------------- */
let undoStack = [];
let redoStack = [];

function snapshot(label) {
  return { label, time: Date.now(), data: JSON.stringify(projectPersistable()) };
}
function projectPersistable() {
  const p = state.project;
  return p ? { ...p } : null;
}

/** Call BEFORE mutating project state */
export function pushHistory(label) {
  if (!state.project) return;
  undoStack.push(snapshot(label));
  redoStack = [];
  emit('history');
}
export function undo() {
  if (!undoStack.length || !state.project) return;
  redoStack.push(snapshot('current'));
  const s = undoStack.pop();
  state.project = JSON.parse(s.data);
  state.selection = state.selection.filter(id => state.project.clips.some(c => c.id === id));
  markDirty();
  emit('project'); emit('timeline'); emit('selection'); emit('history');
}
export function redo() {
  if (!redoStack.length || !state.project) return;
  undoStack.push(snapshot('current'));
  const s = redoStack.pop();
  state.project = JSON.parse(s.data);
  state.selection = state.selection.filter(id => state.project.clips.some(c => c.id === id));
  markDirty();
  emit('project'); emit('timeline'); emit('selection'); emit('history');
}
export function historyInfo() { return { undo: undoStack.map(s => s.label), redo: redoStack.map(s => s.label) }; }
function resetHistory() { undoStack = []; redoStack = []; emit('history'); }

/* ---------------- project lifecycle ---------------- */
export async function newProject(name) {
  const p = createProjectData(name);
  await db.saveProject(p);
  await openProject(p.id);
  return p;
}
/**
 * Normalize/migrate a loaded project so stale VTuber data from older
 * versions can never break rendering (black screen causes):
 *  - vtuber object missing fields → filled with plain defaults
 *  - chroma missing/legacy → rebuilt, enabled is a strict boolean (default OFF)
 *  - vtuber clips with invalid duration (Infinity-duration WebM bug) → fixed
 */
function normalizeProject(p) {
  const vt = p.vtuber || {};
  p.vtuber = {
    assetId: vt.assetId ?? null,
    x: isFinite(vt.x) ? vt.x : VTUBER_DEFAULTS.x,
    y: isFinite(vt.y) ? vt.y : VTUBER_DEFAULTS.y,
    scale: isFinite(vt.scale) && vt.scale > 0 ? vt.scale : VTUBER_DEFAULTS.scale,
    rotation: vt.rotation ?? 0, opacity: vt.opacity ?? 100,
    chroma: { ...CHROMA_DEFAULTS, ...(vt.chroma || {}), enabled: vt.chroma?.enabled === true },
  };
  for (const c of p.clips || []) {
    if (!isFinite(c.duration) || c.duration <= 0) c.duration = 30;
    // legacy per-clip chroma flag is dead — keying is driven only by p.vtuber.chroma.enabled
    if ('chroma' in c) delete c.chroma;
  }
  return p;
}

export async function openProject(id) {
  const p = await db.getProject(id);
  if (!p) throw new Error('Project not found');
  state.project = normalizeProject(p);
  state.selection = [];
  state.playhead = 0;
  state.playing = false;
  state.dirty = false;
  resetHistory();
  await db.kvSet('lastProjectId', id);
  emit('project'); emit('timeline'); emit('selection');
}
export function closeProject() {
  state.project = null; state.selection = []; state.playing = false;
  resetHistory();
  emit('project');
}
export async function saveProject(silent = false) {
  if (!state.project) return;
  state.project.updatedAt = Date.now();
  await db.saveProject(JSON.parse(JSON.stringify(state.project)));
  state.dirty = false;
  if (!silent) emit('saved');
}
export function markDirty() { state.dirty = true; }

/* autosave every minute + crash recovery */
let autosaveTimer = null;
export function startAutosave() {
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(async () => {
    if (state.project && state.dirty) {
      await saveProject(true);
      await db.kvSet('autosave_' + state.project.id, { time: Date.now(), data: JSON.stringify(state.project) });
      emit('autosaved');
    }
  }, APP.autosaveIntervalMs);
  window.addEventListener('beforeunload', () => { if (state.project && state.dirty) { try { navigator.sendBeacon && saveProject(true); } catch {} } });
}

/* ---------------- clip operations ---------------- */
export function getClip(id) { return state.project?.clips.find(c => c.id === id) ?? null; }
export function addClip(clip, label = 'Add clip') {
  pushHistory(label);
  state.project.clips.push(clip);
  recalcDuration(); markDirty(); emit('timeline');
  return clip;
}
export function updateClip(id, patch, label = 'Edit clip', withHistory = true) {
  const c = getClip(id); if (!c) return;
  if (withHistory) pushHistory(label);
  Object.assign(c, patch);
  recalcDuration(); markDirty(); emit('timeline');
}
export function deleteClips(ids, label = 'Delete') {
  if (!ids.length) return;
  pushHistory(label);
  state.project.clips = state.project.clips.filter(c => !ids.includes(c.id));
  state.selection = state.selection.filter(id => !ids.includes(id));
  recalcDuration(); markDirty(); emit('timeline'); emit('selection');
}
export function duplicateClips(ids) {
  if (!ids.length) return;
  pushHistory('Duplicate');
  const copies = [];
  for (const id of ids) {
    const c = getClip(id); if (!c) continue;
    const copy = { ...JSON.parse(JSON.stringify(c)), id: uid(), start: c.start + c.duration };
    state.project.clips.push(copy); copies.push(copy.id);
  }
  state.selection = copies;
  recalcDuration(); markDirty(); emit('timeline'); emit('selection');
}
export function splitClip(id, time) {
  const c = getClip(id); if (!c) return;
  if (time <= c.start + 0.05 || time >= c.start + c.duration - 0.05) return;
  pushHistory('Split');
  const off = time - c.start;
  const right = { ...JSON.parse(JSON.stringify(c)), id: uid(), start: time, duration: c.duration - off, inPoint: (c.inPoint || 0) + off };
  c.duration = off;
  state.project.clips.push(right);
  markDirty(); emit('timeline');
}
export function setSelection(ids) { state.selection = ids; emit('selection'); }
export function recalcDuration() {
  const p = state.project; if (!p) return;
  let max = 5;
  for (const c of p.clips) max = Math.max(max, c.start + c.duration);
  for (const w of p.captions) max = Math.max(max, w.end);
  p.duration = Math.max(10, Math.ceil(max + 0.5));
}

/* ---------------- playback ---------------- */
export function setPlayhead(t) {
  state.playhead = Math.max(0, Math.min(t, state.project?.duration ?? 0));
  emit('playback');
}
export function setPlaying(v) { state.playing = v; emit('playback'); }

/* ---------------- routing ---------------- */
export function navigate(route) {
  state.route = route;
  emit('route');
}
