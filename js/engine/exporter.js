/**
 * exporter.js — export engines (rewritten).
 *
 * 1) MP4 H.264 export (primary):
 *    Frame-accurate OFFLINE pipeline — every frame is seeked & awaited before
 *    drawing (no dropped/black frames), encoded with WebCodecs (H.264/AVC),
 *    audio mixed with OfflineAudioContext (voice+music+sfx, dB gains, treble,
 *    fades) and encoded to AAC. Muxed into .mp4 via mp4-muxer (CDN).
 *    Fallbacks: MediaRecorder MP4 → MediaRecorder WebM (real-time).
 *
 * 2) Premiere Pro package: ZIP = project.fcpxml + Media/ folder containing a
 *    copy of every used material — import the XML in Premiere and everything
 *    is already linked (relative paths).
 *
 * 3) .vtproject export/import (full restore with embedded assets).
 */
import { VIDEO } from '../config.js';
import { Renderer } from './renderer.js';
import { db, assetUrl } from '../services/db.js';
import { escapeHtml } from '../utils.js';

const FPS = VIDEO.fps;
const MP4_MUXER_CDN = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm';
const JSZIP_CDN = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

/* ============================================================
 * OFFLINE AUDIO MIX — full project audio rendered to one buffer
 * ============================================================ */
async function renderAudioMix(project) {
  const sr = 48000;
  const frames = Math.max(sr, Math.ceil(project.duration * sr));
  const octx = new OfflineAudioContext(2, frames, sr);
  const mutedTracks = new Set(project.tracks.filter(tr => tr.muted).map(tr => tr.id));
  const dbToGain = (d) => Math.pow(10, d / 20);

  for (const clip of project.clips) {
    const isAudioTrack = clip.trackId === 'music' || clip.trackId === 'sfx';
    const isVt = clip.trackId === 'vtuber'; // VTuber voice comes from the video's audio track
    if (!isAudioTrack && !isVt) continue;
    if (!clip.assetId || clip.muted || mutedTracks.has(clip.trackId)) continue;
    const asset = await db.getAsset(clip.assetId);
    if (!asset?.blob) continue;
    let buf = null;
    try { buf = await octx.decodeAudioData(await asset.blob.arrayBuffer()); } catch { continue; }
    if (!buf) continue;

    const src = octx.createBufferSource();
    src.buffer = buf; src.loop = !!clip.loop;
    const gain = octx.createGain();
    const g = dbToGain(clip.volume ?? 0);
    let node = src;
    if (typeof clip.treble === 'number' && clip.treble !== 0) {
      const sh = octx.createBiquadFilter();
      sh.type = 'highshelf'; sh.frequency.value = 4000; sh.gain.value = clip.treble;
      node.connect(sh); node = sh;
    }
    node.connect(gain); gain.connect(octx.destination);

    const when = Math.max(0, clip.start);
    const offset = clip.inPoint || 0;
    const remain = Math.min(clip.duration, project.duration - when);
    if (remain <= 0) continue;

    gain.gain.setValueAtTime(clip.fadeIn > 0 ? 0.0001 : g, when);
    if (clip.fadeIn > 0) gain.gain.linearRampToValueAtTime(g, when + clip.fadeIn);
    if (clip.fadeOut > 0) {
      gain.gain.setValueAtTime(g, when + Math.max(0, remain - clip.fadeOut));
      gain.gain.linearRampToValueAtTime(0.0001, when + remain);
    }
    try {
      src.start(when,
        src.loop ? offset % buf.duration : Math.min(offset, Math.max(0, buf.duration - 0.01)),
        src.loop ? undefined : remain);
      if (src.loop) src.stop(when + remain);
    } catch { /* scheduling edge */ }
  }
  return octx.startRendering();
}

/* ============================================================
 * FRAME-ACCURATE SEEK — the black-frames fix.
 * Every active video is seeked to the exact frame time and we
 * WAIT for 'seeked' before drawing. Nothing is drawn stale.
 * ============================================================ */
async function seekActiveVideos(renderer, project, t) {
  const hidden = new Set(project.tracks.filter(tr => tr.hidden).map(tr => tr.id));
  const active = project.clips.filter(c =>
    c.assetId && t >= c.start && t < c.start + c.duration && !hidden.has(c.trackId));
  await Promise.all(active.map(async (c) => {
    const m = await renderer.getMedia(c.assetId);
    if (m.kind !== 'video' || !m.el) return;
    const el = m.el;
    if (!el.paused) el.pause();
    const local = (t - c.start) + (c.inPoint || 0);
    const dur = el.duration || 0;
    // EXACT same formula as renderer.syncVideoTime → render() won't re-seek
    const target = c.loop && dur > 0 ? local % dur : Math.min(local, Math.max(0, dur - 0.01));
    if (Math.abs(el.currentTime - target) < 0.004) return;
    await new Promise((res) => {
      const to = setTimeout(res, 600); // never hang on a broken frame
      el.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
      el.currentTime = target;
    });
  }));
}

/* ============================================================
 * MP4 H.264 EXPORT (WebCodecs + mp4-muxer)
 * ============================================================ */
async function exportMp4H264(project, onProgress, signal) {
  const { Muxer, ArrayBufferTarget } = await import(MP4_MUXER_CDN);

  const W = VIDEO.width, H = VIDEO.height;
  // Try several H.264 profiles/levels + hardware & software encoders,
  // then VP9-in-MP4 as a last WebCodecs resort (still .mp4, frame-accurate).
  const codecCandidates = [];
  for (const codec of ['avc1.640028', 'avc1.64002a', 'avc1.4d0028', 'avc1.42e028']) {
    for (const hw of ['no-preference', 'prefer-software']) {
      codecCandidates.push({ codec, hardwareAcceleration: hw, muxCodec: 'avc', extra: { avc: { format: 'avc' } } });
    }
  }
  codecCandidates.push({ codec: 'vp09.00.40.08', hardwareAcceleration: 'no-preference', muxCodec: 'vp9', extra: {} });

  let videoCfg = null, muxVideoCodec = 'avc', isH264 = true;
  for (const cand of codecCandidates) {
    const cfg = {
      codec: cand.codec, width: W, height: H,
      bitrate: 12_000_000, framerate: FPS,
      hardwareAcceleration: cand.hardwareAcceleration,
      ...cand.extra,
    };
    const s = await VideoEncoder.isConfigSupported(cfg).catch(() => null);
    if (s?.supported) { videoCfg = cfg; muxVideoCodec = cand.muxCodec; isH264 = cand.muxCodec === 'avc'; break; }
  }
  if (!videoCfg) throw new Error('h264-unsupported');

  // ---- audio: prefer AAC, fall back to Opus-in-MP4, else video-only ----
  onProgress?.(0.01, 'audio');
  const mix = await renderAudioMix(project);
  let audioKind = null; // 'aac' | 'opus' | null
  const aacCfg = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 };
  const opusCfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 };
  if ('AudioEncoder' in window) {
    if ((await AudioEncoder.isConfigSupported(aacCfg).catch(() => null))?.supported) audioKind = 'aac';
    else if ((await AudioEncoder.isConfigSupported(opusCfg).catch(() => null))?.supported) audioKind = 'opus';
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: muxVideoCodec, width: W, height: H, frameRate: FPS },
    ...(audioKind ? { audio: { codec: audioKind, sampleRate: 48000, numberOfChannels: 2 } } : {}),
    fastStart: 'in-memory',
  });

  let encErr = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encErr = e; },
  });
  videoEncoder.configure(videoCfg);

  let audioEncoder = null;
  if (audioKind) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => { encErr = e; },
    });
    audioEncoder.configure(audioKind === 'aac' ? aacCfg : opusCfg);
  }

  // ---- encode audio buffer in planar chunks ----
  if (audioEncoder) {
    const CH = 2, STEP = 4800; // 100ms
    for (let off = 0; off < mix.length; off += STEP) {
      const n = Math.min(STEP, mix.length - off);
      const data = new Float32Array(n * CH);
      for (let ch = 0; ch < CH; ch++) {
        mix.copyFromChannel(data.subarray(ch * n, ch * n + n), Math.min(ch, mix.numberOfChannels - 1), off);
      }
      const ad = new AudioData({
        format: 'f32-planar', sampleRate: 48000,
        numberOfFrames: n, numberOfChannels: CH,
        timestamp: Math.round(off / 48000 * 1e6), data,
      });
      audioEncoder.encode(ad);
      ad.close();
    }
  }

  // ---- render + encode every video frame (offline, frame-accurate) ----
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const renderer = new Renderer(canvas);
  const totalFrames = Math.max(1, Math.round(project.duration * FPS));

  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) {
      try { videoEncoder.close(); audioEncoder?.close(); } catch {}
      throw new DOMException('aborted', 'AbortError');
    }
    if (encErr) throw encErr;
    const t = i / FPS;
    await seekActiveVideos(renderer, project, t);
    await renderer.render(project, t, false);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(i * 1e6 / FPS),
      duration: Math.round(1e6 / FPS),
    });
    videoEncoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
    frame.close();
    // backpressure — don't flood the encoder queue
    while (videoEncoder.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 2));
    onProgress?.(0.03 + (i / totalFrames) * 0.92, 'video');
  }

  onProgress?.(0.96, 'finalize');
  await videoEncoder.flush();
  if (audioEncoder) await audioEncoder.flush();
  if (encErr) throw encErr;
  muxer.finalize();
  renderer.pauseAll();
  onProgress?.(1, 'done');
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4', h264: isH264 };
}

/* ============================================================
 * REAL-TIME FALLBACK (MediaRecorder) — only when WebCodecs
 * is unavailable. Tries MP4 mime first, then WebM.
 * ============================================================ */
async function exportRealtime(project, onProgress, signal) {
  const canvas = document.createElement('canvas');
  canvas.width = VIDEO.width; canvas.height = VIDEO.height;
  const renderer = new Renderer(canvas);

  // audio: play the offline-rendered mix through a MediaStreamDestination
  const actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') await actx.resume().catch(() => {});
  const dest = actx.createMediaStreamDestination();
  const mix = await renderAudioMix(project);
  const mixSrc = actx.createBufferSource();
  mixSrc.buffer = mix;
  mixSrc.connect(dest);

  const stream = canvas.captureStream(FPS);
  for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);

  const candidates = [
    ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
    ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm;codecs=vp8,opus', 'webm'],
    ['video/webm', 'webm'],
  ];
  const found = candidates.find(([m]) => MediaRecorder.isTypeSupported(m));
  if (!found) throw new Error('MediaRecorder unsupported');
  const [mime, ext] = found;

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => { rec.onstop = r; });

  const dur = project.duration;
  rec.start(250);
  mixSrc.start(0);

  const t0 = performance.now();
  let aborted = false;
  await new Promise((resolve) => {
    const tick = async () => {
      if (signal?.aborted) { aborted = true; return resolve(); }
      const t = (performance.now() - t0) / 1000;
      if (t >= dur) return resolve();
      await renderer.render(project, t, true);
      onProgress?.(t / dur, 'video');
      requestAnimationFrame(tick);
    };
    tick();
  });

  try { mixSrc.stop(); } catch {}
  renderer.pauseAll();
  rec.stop();
  await stopped;
  actx.close().catch(() => {});
  if (aborted) throw new DOMException('aborted', 'AbortError');
  onProgress?.(1, 'done');
  return { blob: new Blob(chunks, { type: mime.split(';')[0] }), ext };
}

/**
 * Public video export — MP4 H.264 first, graceful fallbacks.
 * @returns {Promise<{blob: Blob, ext: string}>}
 */
export async function exportVideo(project, onProgress, signal) {
  if ('VideoEncoder' in window) {
    try {
      return await exportMp4H264(project, onProgress, signal);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.warn('WebCodecs MP4 export failed → falling back to MediaRecorder', e);
    }
  }
  return exportRealtime(project, onProgress, signal);
}

/* ============================================================
 * FCPXML (Premiere-compatible)
 * pathForAsset(assetId, asset) → media file reference (relative)
 * ============================================================ */
const tc = (sec) => `${Math.max(0, Math.round(sec * FPS))}/${FPS}s`;

async function buildFcpXml(project, pathForAsset) {
  const assets = new Map();
  let assetIdx = 1;
  const getAssetRef = async (assetId) => {
    if (!assetId) return null;
    if (assets.has(assetId)) return assets.get(assetId);
    const a = await db.getAsset(assetId);
    if (!a) return null;
    const ref = {
      refId: 'r' + (++assetIdx),
      name: a.fileName || 'asset',
      src: pathForAsset(assetId, a),
      duration: a.duration || project.duration,
      kind: a.kind || 'video',
      hasVideo: a.kind === 'video' || a.kind === 'image' || a.kind === 'gif',
      hasAudio: a.kind === 'audio' || a.kind === 'video',
    };
    assets.set(assetId, ref);
    return ref;
  };

  const audioTracks = ['music', 'sfx'];
  const lanes = { background: 0, vtuber: 1, broll_vid: 2, broll_img: 3, memes: 4, overlays: 5, music: -1, sfx: -2 };

  const bg = project.clips.find(c => c.trackId === 'background');
  let connected = '';
  for (const clip of project.clips) {
    if (clip.trackId === 'captions' || clip.trackId === 'transitions') continue;
    if (clip === bg) continue;
    const ref = await getAssetRef(clip.assetId);
    if (!ref) continue;
    const lane = lanes[clip.trackId] ?? 6;
    const isAudio = audioTracks.includes(clip.trackId);
    connected += `
        <asset-clip ref="${ref.refId}" lane="${lane}" offset="${tc(clip.start)}" name="${escapeHtml(clip.name || ref.name)}" start="${tc(clip.inPoint || 0)}" duration="${tc(clip.duration)}"${isAudio ? ` audioRole="${clip.trackId === 'music' ? 'music' : 'effects'}"` : ''}>
${!isAudio ? `          <adjust-transform position="${((clip.x - VIDEO.width / 2) / VIDEO.width * 100).toFixed(2)} ${((VIDEO.height / 2 - clip.y) / VIDEO.height * 100).toFixed(2)}" scale="${(clip.scale / 100).toFixed(4)} ${(clip.scale / 100).toFixed(4)}" rotation="${-(clip.rotation || 0)}"/>` : ''}
        </asset-clip>`;
  }

  // captions as titles
  let titles = '';
  for (const clip of project.clips.filter(c => c.trackId === 'captions')) {
    titles += `
        <title ref="rTitle" lane="7" offset="${tc(clip.start)}" name="${escapeHtml((clip.text || '').slice(0, 30))}" duration="${tc(clip.duration)}">
          <text><text-style ref="ts1">${escapeHtml(clip.text || '')}</text-style></text>
        </title>`;
  }

  let bgClip = null;
  if (bg) {
    const ref = await getAssetRef(bg.assetId);
    if (ref) {
      bgClip = `<asset-clip ref="${ref.refId}" offset="0s" name="${escapeHtml(bg.name || 'Background')}" start="${tc(bg.inPoint || 0)}" duration="${tc(bg.duration)}">${connected}${titles}
      </asset-clip>`;
    }
  }
  if (!bgClip) {
    bgClip = `<gap name="Gap" offset="0s" duration="${tc(project.duration)}">${connected}${titles}
      </gap>`;
  }

  let resources = `
    <format id="r1" name="FFVideoFormat1080x1920p30" frameDuration="1/${FPS}s" width="${VIDEO.width}" height="${VIDEO.height}"/>
    <effect id="rTitle" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>`;
  for (const [, ref] of assets) {
    resources += `
    <asset id="${ref.refId}" name="${escapeHtml(ref.name)}" start="0s" duration="${tc(ref.duration || project.duration)}" hasVideo="${ref.hasVideo ? 1 : 0}" hasAudio="${ref.hasAudio ? 1 : 0}">
      <media-rep kind="original-media" src="${escapeHtml(ref.src)}"/>
    </asset>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>${resources}
  </resources>
  <library>
    <event name="${escapeHtml(project.name)}">
      <project name="${escapeHtml(project.name)}">
        <sequence format="r1" duration="${tc(project.duration)}" tcStart="0s" audioLayout="stereo" audioRate="48k">
          <spine>
            ${bgClip}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

/** Standalone FCPXML file (media referenced by filename next to the XML) */
export async function exportFcpXml(project) {
  const xml = await buildFcpXml(project, (id, a) => `./${safeFileName(a)}`);
  return new Blob([xml], { type: 'application/xml' });
}

/* ============================================================
 * PREMIERE PACKAGE — ZIP: project.fcpxml + Media/ (all materials)
 * ============================================================ */
function safeFileName(asset) {
  let name = asset.fileName || (asset.name + extFromMime(asset.mime));
  name = name.replace(/[\\/:*?"<>|]/g, '_');
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += extFromMime(asset.mime);
  return name;
}
function extFromMime(mime = '') {
  const map = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/flac': '.flac',
  };
  return map[mime] || '.bin';
}

/** Collect every asset id actually used by the project */
function usedAssetIds(project) {
  const ids = new Set();
  for (const c of project.clips) if (c.assetId) ids.add(c.assetId);
  if (project.vtuber?.assetId) ids.add(project.vtuber.assetId);
  if (project.background?.assetId) ids.add(project.background.assetId);
  for (const m of project.materials || []) if (m.assetId) ids.add(m.assetId);
  return ids;
}

/**
 * Export a full Premiere package as a ZIP blob:
 *   ProjectName/
 *     ProjectName.fcpxml   — import this in Premiere (File → Import)
 *     Media/…              — copies of ALL used materials (relative-linked)
 *     README.txt           — AR/EN instructions
 */
export async function exportPremierePackage(project, onProgress) {
  const { default: JSZip } = await import(JSZIP_CDN);
  const zip = new JSZip();
  const safeProj = (project.name || 'project').replace(/[\\/:*?"<>|]/g, '_');
  const rootDir = zip.folder(safeProj);
  const mediaDir = rootDir.folder('Media');

  // 1) media copies with unique names
  const ids = [...usedAssetIds(project)];
  const nameById = new Map();
  const taken = new Set();
  let done = 0;
  for (const id of ids) {
    const a = await db.getAsset(id);
    if (!a?.blob) continue;
    let fname = safeFileName(a);
    if (taken.has(fname.toLowerCase())) {
      const dot = fname.lastIndexOf('.');
      fname = `${fname.slice(0, dot)}_${id.slice(0, 6)}${fname.slice(dot)}`;
    }
    taken.add(fname.toLowerCase());
    nameById.set(id, fname);
    mediaDir.file(fname, a.blob, { compression: 'STORE' }); // media: no recompression
    onProgress?.(0.05 + (++done / Math.max(ids.length, 1)) * 0.55, 'media');
  }

  // 2) XML referencing ./Media/<file>
  const xml = await buildFcpXml(project, (id, a) => `./Media/${nameById.get(id) || safeFileName(a)}`);
  rootDir.file(`${safeProj}.fcpxml`, xml);

  // 3) instructions
  rootDir.file('README.txt',
`AI VTuber Shorts Editor — Premiere Pro Package
==============================================

EN:
1. Extract this ZIP anywhere (keep the folder structure).
2. In Premiere Pro: File → Import → select "${safeProj}.fcpxml".
3. All media lives in the "Media" folder next to the XML, so links resolve
   automatically. If Premiere asks to locate a file, point it to that folder.
Sequence: ${VIDEO.width}x${VIDEO.height} @ ${FPS}fps (9:16 vertical).

AR:
١. فك ضغط الملف في أي مكان (حافظ على ترتيب المجلدات).
٢. في بريمير برو: File ← Import ← اختر "${safeProj}.fcpxml".
٣. كل المواد موجودة في مجلد "Media" بجانب ملف الـ XML فيتم ربطها تلقائيًا.
   لو طلب بريمير تحديد مكان ملف، اختَر هذا المجلد.
التسلسل: ${VIDEO.width}×${VIDEO.height} بمعدل ${FPS} إطار/ثانية (رأسي 9:16).
`);

  // 4) zip it — media already stored uncompressed for speed
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } },
    (meta) => onProgress?.(0.62 + (meta.percent / 100) * 0.38, 'zip'),
  );
  onProgress?.(1, 'done');
  return blob;
}

/* ============================================================
 * .vtproject export/import
 * ============================================================ */
export async function exportVtProject(project, includeAssets = true) {
  const payload = { format: 'vtproject', version: 1, project };
  if (includeAssets) {
    payload.assets = [];
    for (const id of usedAssetIds(project)) {
      const a = await db.getAsset(id);
      if (!a) continue;
      const b64 = await new Promise(res => {
        const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(a.blob);
      });
      payload.assets.push({ ...a, blob: undefined, data: b64 });
    }
  }
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export async function importVtProject(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  if (payload.format !== 'vtproject' || !payload.project) throw new Error('Invalid .vtproject file');
  const p = payload.project;
  p.id = crypto.randomUUID ? crypto.randomUUID() : 'p' + Date.now();
  p.updatedAt = Date.now();
  for (const a of payload.assets || []) {
    if (!a.data) continue;
    const res = await fetch(a.data);
    const blob = await res.blob();
    await db.saveAsset({ ...a, data: undefined, blob });
  }
  await db.saveProject(p);
  return p;
}
