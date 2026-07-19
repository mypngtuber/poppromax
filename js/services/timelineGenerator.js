/**
 * timelineGenerator.js — converts AI Director JSON into a full timeline.
 * The frontend (not Gemini) executes everything.
 */
import { createClip, state, pushHistory, markDirty, emit, recalcDuration } from '../store.js';
import { VTUBER_DEFAULTS, VIDEO, CAPTION_DEFAULTS, MUSIC_DEFAULTS } from '../config.js';
import { uid } from '../utils.js';

/**
 * Build the entire timeline from analysis + resolved materials.
 * Only materials with status uploaded/ready are placed; skipped/missing are omitted.
 */
export function generateTimeline({ scope } = {}) {
  const p = state.project;
  const a = p.aiAnalysis;
  if (!p || !a) return;

  pushHistory('AI Generate Timeline');

  const inScope = (t) => !scope || (t >= scope.start - 0.001 && t <= scope.end + 0.001);
  // Remove previously AI-generated clips (in scope) — user manual clips (aiGen flag false) preserved
  p.clips = p.clips.filter(c => !(c.aiGen && (!scope || inScope(c.start))));

  const dur = a.totalDuration || p.duration;

  if (!scope) {
    // -------- Track: background (full length) --------
    if (p.background.assetId || p.background.type === 'color') {
      p.clips.push(createClip('background', {
        aiGen: true, name: 'Background', assetId: p.background.assetId,
        start: 0, duration: dur, x: VIDEO.width / 2, y: VIDEO.height / 2, scale: 100,
        transitionIn: 'cut', transitionOut: 'cut', isBackground: true, loop: true,
      }));
    }
    // -------- Track: VTuber (plain video — no auto chroma, user's own transform) --------
    if (p.vtuber.assetId) {
      const existing = p.clips.find(c => c.trackId === 'vtuber');
      if (existing) {
        // Reuse the clip the user already placed/adjusted — never duplicate,
        // never touch its position/scale; just make sure it covers the video.
        if (existing.duration < dur) existing.duration = dur;
      } else {
        p.clips.push(createClip('vtuber', {
          aiGen: true, name: 'VTuber', assetId: p.vtuber.assetId,
          start: 0, duration: dur,
          x: p.vtuber.x ?? VTUBER_DEFAULTS.x,
          y: p.vtuber.y ?? VTUBER_DEFAULTS.y,
          scale: p.vtuber.scale ?? VTUBER_DEFAULTS.scale,
          transitionIn: 'cut', transitionOut: 'cut', hasAudio: true,
        }));
      }
    }
  }

  // -------- B-roll plan --------
  const matById = Object.fromEntries((p.materials || []).map(m => [m.id, m]));
  for (const b of a.brollPlan || []) {
    if (scope && !inScope(b.startTime)) continue;
    const mat = matById[b.materialId];
    if (!mat || !mat.assetId) continue; // user didn't upload → skip gracefully
    const track = ['broll_img', 'broll_vid', 'memes', 'overlays'].includes(b.layer) ? b.layer : (mat.type === 'video' ? 'broll_vid' : mat.type === 'meme' || mat.type === 'gif' ? 'memes' : 'broll_img');
    p.clips.push(createClip(track, {
      aiGen: true, name: mat.description?.slice(0, 34) || b.materialId, assetId: mat.assetId,
      start: +b.startTime || 0, duration: Math.max(0.4, (+b.endTime || 0) - (+b.startTime || 0)),
      x: VIDEO.width / 2, y: VIDEO.height * 0.36, scale: 88,
      transitionIn: b.transitionIn || 'pop', transitionOut: b.transitionOut || 'fade',
      animation: b.animation || 'pop',
    }));
  }

  // -------- Sound effects --------
  for (const s of a.soundEffects || []) {
    if (scope && !inScope(s.time)) continue;
    const mat = s.materialId ? matById[s.materialId] : null;
    p.clips.push(createClip('sfx', {
      aiGen: true, name: s.type || 'SFX', assetId: mat?.assetId ?? null,
      start: +s.time || 0, duration: Math.max(0.2, +s.duration || 0.6),
      volume: -6, meta: { reason: s.reason },
    }));
  }

  if (!scope) {
    // -------- Music (auto-selected, default mastering) --------
    const musicMat = (p.materials || []).find(m => m.type === 'music' && m.assetId);
    if (musicMat) {
      p.clips.push(createClip('music', {
        aiGen: true, name: `Music (${a.musicRecommendation?.mood || 'auto'})`, assetId: musicMat.assetId,
        start: 0, duration: dur,
        volume: MUSIC_DEFAULTS.volumeDb, treble: MUSIC_DEFAULTS.trebleDb,
        fadeIn: MUSIC_DEFAULTS.fadeIn, fadeOut: MUSIC_DEFAULTS.fadeOut, loop: true,
      }));
    }
    // -------- Captions: word-level → caption line clips --------
    p.captions = (a.words || []).map(w => ({ id: uid(), text: w.w, start: +w.s, end: +w.e }));
    buildCaptionClips(p, a.words || []);
    // -------- Scene transitions --------
    for (const t of a.sceneTransitions || []) {
      const scene = a.scenes.find(s => s.sceneNumber === t.afterScene);
      if (!scene) continue;
      p.clips.push(createClip('transitions', {
        aiGen: true, name: t.type || 'fade', start: Math.max(0, scene.endTime - (t.duration || 0.3) / 2),
        duration: t.duration || 0.3, transitionType: t.type || 'fade',
      }));
    }
    // -------- Markers from scenes --------
    p.markers = a.scenes.map(s => ({ id: uid(), time: s.startTime, label: s.title, color: '#7c5cff' }));
  }

  recalcDuration();
  markDirty();
  emit('timeline'); emit('project');
}

/**
 * Group word timings into caption lines with max 18 chars (never split a word),
 * one clip per line on the captions track. Karaoke highlight handled in renderer.
 */
export function buildCaptionClips(project, words) {
  const maxChars = project.captionStyle.maxCharsPerLine || CAPTION_DEFAULTS.maxCharsPerLine;
  project.clips = project.clips.filter(c => c.trackId !== 'captions');
  let line = [], lineLen = 0;
  const flush = () => {
    if (!line.length) return;
    project.clips.push(createClip('captions', {
      aiGen: true,
      name: line.map(w => w.w).join(' ').slice(0, 22),
      text: line.map(w => w.w).join(' '),
      words: line.map(w => ({ w: w.w, s: +w.s, e: +w.e })),
      start: +line[0].s,
      duration: Math.max(0.15, +line[line.length - 1].e - +line[0].s),
      x: project.captionStyle.x, y: project.captionStyle.y, scale: project.captionStyle.scale,
      transitionIn: 'cut', transitionOut: 'cut',
    }));
    line = []; lineLen = 0;
  };
  for (const w of words) {
    const wLen = String(w.w).length;
    const nextLen = lineLen === 0 ? wLen : lineLen + 1 + wLen;
    if (line.length && nextLen > maxChars) flush();
    line.push(w);
    lineLen = lineLen === 0 ? wLen : lineLen + 1 + wLen;
    // also break on big time gap (silence)
    if (line.length && words.indexOf(w) < words.length - 1) {
      const nxt = words[words.indexOf(w) + 1];
      if (nxt && nxt.s - w.e > 0.8) flush();
    }
  }
  flush();
}
