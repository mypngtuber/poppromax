/**
 * exporter.js — export engines.
 * 1) Video export: renders the timeline to WebM (VP9 + Opus) via canvas.captureStream + MediaRecorder.
 *    (FFmpeg-wasm H.264 path can be added later without touching callers.)
 * 2) FCPXML export: Premiere/FCP-compatible XML preserving timing, tracks, captions, audio.
 */
import { VIDEO } from '../config.js';
import { Renderer } from './renderer.js';
import { AudioEngine } from './audio.js';
import { assetUrl } from '../services/db.js';
import { db } from '../services/db.js';
import { escapeHtml } from '../utils.js';

/**
 * Render project to a WebM blob in real time.
 * @param {object} project
 * @param {function} onProgress 0..1
 * @param {AbortSignal} signal
 */
export async function exportVideo(project, onProgress, signal) {
  const canvas = document.createElement('canvas');
  canvas.width = VIDEO.width; canvas.height = VIDEO.height;
  const renderer = new Renderer(canvas);
  const audio = new AudioEngine();
  const ctx = audio.ensureCtx();

  // mix voice (vtuber video audio) through WebAudio into the recorded stream
  const dest = ctx.createMediaStreamDestination();
  const vtClip = project.clips.find(c => c.trackId === 'vtuber' && c.assetId);
  let vtEl = null;
  if (vtClip) {
    const url = await assetUrl(vtClip.assetId);
    vtEl = document.createElement('video');
    vtEl.src = url; vtEl.crossOrigin = 'anonymous'; vtEl.playsInline = true;
    await new Promise(r => { vtEl.onloadeddata = r; vtEl.onerror = r; });
    try {
      const src = ctx.createMediaElementSource(vtEl);
      src.connect(dest);
    } catch { /* already connected */ }
  }
  // route music/sfx into dest as well by re-pointing audio engine destination
  const origStart = audio.start.bind(audio);
  audio.start = async (p, t) => {
    // patched start connecting to dest
    audio.stop();
    const actx = audio.ensureCtx();
    const muted = new Set(p.tracks.filter(tr => tr.muted).map(tr => tr.id));
    const clips = p.clips.filter(c => (c.trackId === 'music' || c.trackId === 'sfx') && c.assetId && !c.muted && !muted.has(c.trackId) && c.start + c.duration > t);
    for (const clip of clips) {
      const buf = await audio.getBuffer(clip.assetId);
      if (!buf) continue;
      const s = actx.createBufferSource(); s.buffer = buf; s.loop = !!clip.loop;
      const g = actx.createGain();
      const gv = Math.pow(10, (clip.volume ?? 0) / 20);
      let node = s;
      if (typeof clip.treble === 'number' && clip.treble !== 0) {
        const sh = actx.createBiquadFilter(); sh.type = 'highshelf'; sh.frequency.value = 4000; sh.gain.value = clip.treble;
        node.connect(sh); node = sh;
      }
      node.connect(g); g.connect(dest);
      const now = actx.currentTime;
      const when = now + Math.max(0, clip.start - t);
      const offset = Math.max(0, t - clip.start) + (clip.inPoint || 0);
      const remain = clip.duration - Math.max(0, t - clip.start);
      if (remain <= 0) continue;
      g.gain.setValueAtTime(clip.fadeIn > 0 && offset < clip.fadeIn ? 0.0001 : gv, when);
      if (clip.fadeIn > 0 && offset < clip.fadeIn) g.gain.linearRampToValueAtTime(gv, when + clip.fadeIn - offset);
      if (clip.fadeOut > 0) { g.gain.setValueAtTime(gv, when + Math.max(0, remain - clip.fadeOut)); g.gain.linearRampToValueAtTime(0.0001, when + remain); }
      try { s.start(when, s.loop ? offset % buf.duration : Math.min(offset, buf.duration - 0.01), s.loop ? undefined : remain); audio.playing.push(s); } catch {}
    }
  };

  const stream = canvas.captureStream(VIDEO.fps);
  for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => { rec.onstop = r; });

  const dur = project.duration;
  rec.start(250);
  await audio.start(project, 0);
  if (vtEl) { vtEl.currentTime = vtClip.inPoint || 0; vtEl.muted = false; await vtEl.play().catch(() => {}); }

  const t0 = performance.now();
  let aborted = false;
  await new Promise((resolve) => {
    const tick = async () => {
      if (signal?.aborted) { aborted = true; return resolve(); }
      const t = (performance.now() - t0) / 1000;
      if (t >= dur) return resolve();
      await renderer.render(project, t, true);
      onProgress?.(t / dur);
      requestAnimationFrame(tick);
    };
    tick();
  });

  audio.stop();
  audio.start = origStart;
  if (vtEl) vtEl.pause();
  renderer.pauseAll();
  rec.stop();
  await stopped;
  if (aborted) throw new DOMException('aborted', 'AbortError');
  onProgress?.(1);
  return new Blob(chunks, { type: 'video/webm' });
}

/* ================= FCPXML (Premiere compatible) ================= */
const FPS = VIDEO.fps;
const tc = (sec) => `${Math.round(sec * FPS)}/${FPS}s`;

export async function exportFcpXml(project) {
  const assets = new Map();
  let assetIdx = 1;
  const getAssetRef = async (assetId) => {
    if (!assetId) return null;
    if (assets.has(assetId)) return assets.get(assetId);
    const a = await db.getAsset(assetId);
    const ref = {
      refId: 'r' + (++assetIdx),
      name: a?.fileName || 'asset',
      duration: a?.duration || project.duration,
      kind: a?.kind || 'video',
    };
    assets.set(assetId, ref);
    return ref;
  };

  const videoTracks = ['background', 'vtuber', 'broll_vid', 'broll_img', 'memes', 'overlays'];
  const audioTracks = ['music', 'sfx'];

  let spineClips = '';
  let laneNum = 0;
  const lanes = { background: 0, vtuber: 1, broll_vid: 2, broll_img: 3, memes: 4, overlays: 5, music: -1, sfx: -2 };

  // primary storyline = background (or gap)
  const bg = project.clips.find(c => c.trackId === 'background');
  const gapDur = project.duration;

  let connected = '';
  for (const clip of project.clips) {
    if (clip.trackId === 'captions' || clip.trackId === 'transitions') continue;
    if (clip === bg) continue;
    const ref = await getAssetRef(clip.assetId);
    if (!ref) continue;
    const lane = lanes[clip.trackId] ?? ++laneNum;
    const isAudio = audioTracks.includes(clip.trackId);
    connected += `
        <${isAudio ? 'asset-clip' : 'asset-clip'} ref="${ref.refId}" lane="${lane}" offset="${tc(clip.start)}" name="${escapeHtml(clip.name || ref.name)}" start="${tc(clip.inPoint || 0)}" duration="${tc(clip.duration)}"${isAudio ? ` audioRole="${clip.trackId === 'music' ? 'music' : 'effects'}"` : ''}>
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

  let bgClip;
  if (bg) {
    const ref = await getAssetRef(bg.assetId);
    bgClip = ref
      ? `<asset-clip ref="${ref.refId}" offset="0s" name="${escapeHtml(bg.name || 'Background')}" start="${tc(bg.inPoint || 0)}" duration="${tc(bg.duration)}">${connected}${titles}
      </asset-clip>`
      : null;
  }
  if (!bgClip) {
    bgClip = `<gap name="Gap" offset="0s" duration="${tc(gapDur)}">${connected}${titles}
      </gap>`;
  }

  let resources = `
    <format id="r1" name="FFVideoFormat1080x1920p30" frameDuration="1/${FPS}s" width="${VIDEO.width}" height="${VIDEO.height}"/>
    <effect id="rTitle" name="Basic Title" uid=".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"/>`;
  for (const [assetId, ref] of assets) {
    const a = await db.getAsset(assetId);
    resources += `
    <asset id="${ref.refId}" name="${escapeHtml(ref.name)}" start="0s" duration="${tc(ref.duration || project.duration)}" hasVideo="${a?.kind === 'video' || a?.kind === 'image' || a?.kind === 'gif' ? 1 : 0}" hasAudio="${a?.kind === 'audio' || a?.kind === 'video' ? 1 : 0}">
      <media-rep kind="original-media" src="file://./${encodeURIComponent(ref.name)}"/>
    </asset>`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
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
  return new Blob([xml], { type: 'application/xml' });
}

/* ================= .vtproject export/import ================= */
export async function exportVtProject(project, includeAssets = true) {
  const payload = { format: 'vtproject', version: 1, project };
  if (includeAssets) {
    payload.assets = [];
    const ids = new Set();
    for (const c of project.clips) if (c.assetId) ids.add(c.assetId);
    if (project.vtuber.assetId) ids.add(project.vtuber.assetId);
    if (project.background.assetId) ids.add(project.background.assetId);
    for (const m of project.materials || []) if (m.assetId) ids.add(m.assetId);
    for (const id of ids) {
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
  // restore embedded assets
  for (const a of payload.assets || []) {
    if (!a.data) continue;
    const res = await fetch(a.data);
    const blob = await res.blob();
    await db.saveAsset({ ...a, data: undefined, blob });
  }
  await db.saveProject(p);
  return p;
}
