/**
 * mediaExtract.js — media extraction toolbox.
 *
 * 1) extractAudioAsset(videoFile)     — pull the audio track out of ANY video
 *    (e.g. sound-effect downloaded as a video) → WAV asset in the SFX/Music library.
 * 2) captureFrameAsset(videoFile, t)  — grab a single frame → PNG asset (screenshot b-roll).
 * 3) aiPickSegment(videoFile, need)   — user gives a full donor video; Gemini analyzes
 *    audio + sampled frames and returns the best time range matching the requested
 *    material description; we then trim it (video via MediaRecorder re-encode, or
 *    audio-only via WAV slice) and save the result as a library asset.
 */
import { db } from './db.js';
import { uid } from '../utils.js';
import { emit } from '../store.js';
import { callGemini, audioBufferToWav } from './gemini.js';
import { blobToBase64 } from '../utils.js';

/* ---------------- audio extraction ---------------- */

/** Decode a video/audio blob → mono WAV blob (full length, 44.1 kHz for quality). */
export async function decodeToWav(blob, sampleRate = 44100, { start = 0, end = null } = {}) {
  const buf = await blob.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await ac.decodeAudioData(buf.slice(0));
    const from = Math.max(0, start);
    const to = Math.min(decoded.duration, end ?? decoded.duration);
    const frames = Math.max(1, Math.ceil((to - from) * sampleRate));
    const off = new OfflineAudioContext(1, frames, sampleRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start(0, from, to - from);
    const rendered = await off.startRendering();
    return { blob: audioBufferToWav(rendered), duration: to - from };
  } finally { ac.close(); }
}

/**
 * Extract the audio track from a video file and save it as a library asset.
 * @param {File|Blob} file  video (or audio) file
 * @param {string} category 'sfx' | 'music'
 * @param {string} name
 * @param {{start?:number,end?:number}} range optional trim range
 */
export async function extractAudioAsset(file, category, name, range = {}) {
  const { blob, duration } = await decodeToWav(file, 44100, range);
  const asset = {
    id: uid(), name: name || 'extracted-audio', fileName: (name || 'extracted') + '.wav',
    mime: 'audio/wav', kind: 'audio', category, size: blob.size,
    duration, width: 0, height: 0, createdAt: Date.now(),
    favorite: false, tags: ['extracted'], bgCategory: null, lastUsed: 0, blob,
  };
  await db.saveAsset(asset);
  emit('assets');
  return asset;
}

/* ---------------- frame capture ---------------- */

function loadVideo(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onloadeddata = () => resolve({ v, url });
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Cannot decode video')); };
    v.src = url;
  });
}
function seekTo(v, t) {
  return new Promise(res => {
    const done = () => { v.removeEventListener('seeked', done); res(); };
    v.addEventListener('seeked', done);
    v.currentTime = Math.min(Math.max(0, t), Math.max(0, (v.duration || 1) - 0.05));
    setTimeout(done, 1200); // safety
  });
}

/** Capture one frame at time t → PNG blob */
export async function captureFrameBlob(file, t) {
  const { v, url } = await loadVideo(file);
  try {
    await seekTo(v, t);
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return await new Promise(res => c.toBlob(res, 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

/** Capture a frame and save as image asset */
export async function captureFrameAsset(file, t, category, name) {
  const blob = await captureFrameBlob(file, t);
  const { v, url } = await loadVideo(file);
  const w = v.videoWidth, h = v.videoHeight;
  URL.revokeObjectURL(url);
  const asset = {
    id: uid(), name: name || 'frame', fileName: (name || 'frame') + '.png',
    mime: 'image/png', kind: 'image', category, size: blob.size,
    duration: 0, width: w, height: h, createdAt: Date.now(),
    favorite: false, tags: ['frame'], bgCategory: null, lastUsed: 0, blob,
  };
  await db.saveAsset(asset);
  emit('assets');
  return asset;
}

/* ---------------- video segment trim (re-encode) ---------------- */

/**
 * Trim a segment [start,end] out of a video by playing it through a canvas
 * and re-encoding with MediaRecorder (WebM, incl. original audio).
 */
export async function trimVideoSegment(file, start, end, onProgress) {
  const { v, url } = await loadVideo(file);
  try {
    const W = v.videoWidth, H = v.videoHeight;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const stream = c.captureStream(30);
    // audio via WebAudio tap
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();
    try { ac.createMediaElementSource(v).connect(dest); } catch { /* no audio track */ }
    for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);

    const mime = ['video/webm;codecs=vp9,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000 });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const stopped = new Promise(r => { rec.onstop = r; });

    await seekTo(v, start);
    v.muted = false; v.volume = 1;
    rec.start(250);
    await v.play();
    await new Promise(res => {
      const loop = () => {
        ctx.drawImage(v, 0, 0, W, H);
        onProgress?.((v.currentTime - start) / Math.max(end - start, 0.01));
        if (v.currentTime >= end || v.ended) return res();
        requestAnimationFrame(loop);
      };
      loop();
    });
    v.pause();
    rec.stop();
    await stopped;
    ac.close();
    return new Blob(chunks, { type: 'video/webm' });
  } finally { URL.revokeObjectURL(url); }
}

/** Save a trimmed segment as a library video asset */
export async function saveVideoSegmentAsset(file, start, end, category, name, onProgress) {
  const blob = await trimVideoSegment(file, start, end, onProgress);
  const asset = {
    id: uid(), name: name || 'segment', fileName: (name || 'segment') + '.webm',
    mime: 'video/webm', kind: 'video', category, size: blob.size,
    duration: end - start, width: 0, height: 0, createdAt: Date.now(),
    favorite: false, tags: ['segment'], bgCategory: null, lastUsed: 0, blob,
  };
  await db.saveAsset(asset);
  emit('assets');
  return asset;
}

/* ---------------- AI: pick best segment from donor video ---------------- */

const PICK_PROMPT = `You are a video editor's assistant. The user provides:
1) A MATERIAL REQUEST describing exactly what clip/moment is needed.
2) The donor video's AUDIO track.
3) Sampled FRAMES from the donor video, each labeled with its timestamp in seconds.

Analyze BOTH the audio and the frames to find the best matching time range.
Return STRICT JSON only:
{"found":true|false,"start":seconds,"end":seconds,"confidence":0-1,"reason":"short explanation","suggestedName":"short-file-name"}
Rules: segment 0.5-15s unless request implies longer; prefer moments where audio AND visuals match the request; if nothing matches set found=false.`;

/**
 * Gemini analyzes donor video (audio + sampled frames) and returns the best segment.
 * @param {File|Blob} file donor video
 * @param {string} needDescription what material is needed
 */
export async function aiPickSegment(file, needDescription, onStatus) {
  onStatus?.('audio');
  const { v, url } = await loadVideo(file);
  const duration = v.duration || 0;
  try {
    // 1) audio (16k mono, capped at 3 min for payload size)
    const { blob: wav } = await decodeToWav(file, 16000, { start: 0, end: Math.min(duration, 180) });
    // 2) sampled frames — up to 10, JPEG small
    onStatus?.('frames');
    const count = Math.min(10, Math.max(4, Math.floor(duration / 4)));
    const parts = [{ text: PICK_PROMPT }, { text: `MATERIAL REQUEST: ${needDescription}\nVideo duration: ${duration.toFixed(1)}s` }];
    parts.push({ inlineData: { mimeType: 'audio/wav', data: await blobToBase64(wav) } });
    const c = document.createElement('canvas');
    const scale = Math.min(1, 480 / (v.videoWidth || 480));
    c.width = Math.round((v.videoWidth || 480) * scale);
    c.height = Math.round((v.videoHeight || 854) * scale);
    const cctx = c.getContext('2d');
    for (let i = 0; i < count; i++) {
      const t = (duration * (i + 0.5)) / count;
      await seekTo(v, t);
      cctx.drawImage(v, 0, 0, c.width, c.height);
      const jpg = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.7));
      parts.push({ text: `Frame at ${t.toFixed(1)}s:` });
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: await blobToBase64(jpg) } });
    }
    onStatus?.('ai');
    const text = await callGemini(parts);
    let raw = text.trim();
    const f = raw.indexOf('{'), l = raw.lastIndexOf('}');
    if (f >= 0) raw = raw.slice(f, l + 1);
    const res = JSON.parse(raw);
    if (res.found) {
      res.start = Math.max(0, +res.start || 0);
      res.end = Math.min(duration, +res.end || res.start + 3);
      if (res.end <= res.start) res.end = Math.min(duration, res.start + 3);
    }
    return res;
  } finally { URL.revokeObjectURL(url); }
}
