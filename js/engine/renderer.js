/**
 * renderer.js — frame compositor.
 * Renders the full 1080x1920 frame for any time t onto a canvas.
 * Handles: background, chroma-keyed VTuber, B-roll layers, animations,
 * transitions, karaoke captions.
 */
import { VIDEO, TRACKS } from '../config.js';
import { ChromaKeyer, CpuChromaKeyer } from './chromaKey.js';
import { assetUrl, db } from '../services/db.js';

const RENDER_ORDER = ['background', 'vtuber', 'broll_vid', 'broll_img', 'memes', 'overlays', 'captions'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    canvas.width = VIDEO.width; canvas.height = VIDEO.height;
    this.ctx = canvas.getContext('2d');
    // chroma keyer: WebGL first, CPU fallback — keying must NEVER silently disappear
    this.keyer = null;
    try { this.keyer = new ChromaKeyer(); }
    catch (e) { console.warn('WebGL chroma unavailable → CPU fallback', e); this.keyer = new CpuChromaKeyer(); }
    this.mediaCache = new Map(); // assetId -> {el, kind, ready}
    this.onFrameReady = null;    // callback: redraw needed (e.g. video seek finished)
  }

  /**
   * Get (and lazily create) a media element for an asset.
   * The REAL kind is read from the asset record in DB (never guessed from track),
   * so an image background / gif meme / video b-roll all load correctly.
   */
  async getMedia(assetId, fallbackKind = 'image') {
    if (this.mediaCache.has(assetId)) return this.mediaCache.get(assetId);
    const entry = { el: null, kind: fallbackKind, ready: false };
    this.mediaCache.set(assetId, entry);
    const rec = await db.getAsset(assetId).catch(() => null);
    const url = await assetUrl(assetId);
    if (!url) return entry;
    const kind = rec?.kind === 'video' ? 'video' : rec?.kind === 'audio' ? 'audio' : 'image';
    entry.kind = kind;
    if (kind === 'video') {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.src = url;
      entry.el = v;
      // redraw preview when a paused seek completes (otherwise frame stays stale/black)
      v.addEventListener('seeked', () => { if (v.paused) this.onFrameReady?.(); });
      // late-ready recovery: whenever more data arrives, mark ready + redraw
      const markReady = () => {
        if (v.readyState >= 2 && !entry.ready) { entry.ready = true; this.onFrameReady?.(); }
      };
      v.addEventListener('canplay', markReady);
      v.addEventListener('loadeddata', markReady);
      await new Promise(res => {
        if (v.readyState >= 2) return res();
        v.addEventListener('loadeddata', res, { once: true });
        v.addEventListener('error', res, { once: true });
        setTimeout(res, 2500); // don't hang the render loop
      });
      entry.el = v; entry.ready = v.readyState >= 2;
    } else if (kind === 'audio') {
      entry.ready = false; // audio assets have no visual representation
    } else {
      const img = new Image();
      img.src = url;
      await new Promise(res => { img.onload = res; img.onerror = res; });
      entry.el = img; entry.ready = !!img.naturalWidth;
    }
    return entry;
  }

  /** Seek media elements of video clips to the correct local time. */
  syncVideoTime(clip, media, t, playing) {
    if (media.kind !== 'video' || !media.el) return;
    const local = (t - clip.start) + (clip.inPoint || 0);
    const dur = media.el.duration || 0;
    const target = clip.loop && dur > 0 ? local % dur : Math.min(local, Math.max(0, dur - 0.01));
    if (playing) {
      if (media.el.paused) { media.el.currentTime = target; media.el.play().catch(() => {}); }
      else if (Math.abs(media.el.currentTime - target) > 0.35) media.el.currentTime = target;
    } else {
      if (!media.el.paused) media.el.pause();
      if (Math.abs(media.el.currentTime - target) > 0.05) media.el.currentTime = target;
    }
  }

  pauseAll() {
    for (const m of this.mediaCache.values()) if (m.kind === 'video' && m.el && !m.el.paused) m.el.pause();
  }

  /** Animation transform at time t for a clip */
  animState(clip, t) {
    const rel = t - clip.start;
    const dur = clip.duration;
    const td = Math.min(clip.transDur || 0.3, dur / 2);
    let alpha = 1, scaleMul = 1, dx = 0, dy = 0, rgbShift = 0;
    // transition in
    if (rel < td && clip.transitionIn !== 'cut') {
      const k = rel / td;
      switch (clip.transitionIn) {
        case 'fade': case 'crossDissolve': alpha = k; break;
        case 'zoom': alpha = k; scaleMul = 0.6 + 0.4 * ease(k); break;
        case 'pop': scaleMul = popEase(k); break;
        case 'blur': case 'flash': alpha = k; break;
        case 'whip': case 'slide': dx = (1 - ease(k)) * VIDEO.width * 0.6; break;
        case 'glitch': rgbShift = (1 - k) * 14; break;
      }
    }
    // transition out
    const relOut = dur - rel;
    if (relOut < td && clip.transitionOut !== 'cut') {
      const k = relOut / td;
      switch (clip.transitionOut) {
        case 'fade': case 'crossDissolve': alpha = Math.min(alpha, k); break;
        case 'zoom': alpha = Math.min(alpha, k); scaleMul *= 0.6 + 0.4 * k; break;
        case 'pop': scaleMul *= Math.max(0.01, k); break;
        default: alpha = Math.min(alpha, k);
      }
    }
    // clip animation (continuous)
    switch (clip.animation) {
      case 'fade': break;
      case 'zoom': scaleMul *= 1 + Math.min(rel / Math.max(dur, 0.01), 1) * 0.08; break;
      case 'pop': if (rel < 0.35) scaleMul *= popEase(rel / 0.35); break;
      case 'bounce': dy = -Math.abs(Math.sin(rel * Math.PI * 2)) * 18 * Math.max(0, 1 - rel / 1.2); break;
      case 'slideLeft': if (rel < 0.4) dx = (1 - ease(rel / 0.4)) * 300; break;
      case 'slideRight': if (rel < 0.4) dx = -(1 - ease(rel / 0.4)) * 300; break;
      case 'slideUp': if (rel < 0.4) dy = (1 - ease(rel / 0.4)) * 300; break;
      case 'slideDown': if (rel < 0.4) dy = -(1 - ease(rel / 0.4)) * 300; break;
      case 'rotate': break;
      case 'flash': alpha *= rel % 0.5 < 0.25 && rel < 1 ? 1 : (rel < 1 ? 0.55 : 1); break;
      case 'scale': if (rel < 0.4) scaleMul *= ease(rel / 0.4); break;
      case 'rgbPop': if (rel < 0.4) { scaleMul *= popEase(rel / 0.4); rgbShift = (1 - rel / 0.4) * 10; } break;
    }
    return { alpha, scaleMul, dx, dy, rgbShift };
  }

  /**
   * Render frame at time t.
   * @param {object} project
   * @param {number} t seconds
   * @param {boolean} playing
   */
  async render(project, t, playing = false) {
    const ctx = this.ctx;
    const W = VIDEO.width, H = VIDEO.height;
    ctx.clearRect(0, 0, W, H);
    // base background color
    ctx.fillStyle = project.background?.color || '#000';
    ctx.fillRect(0, 0, W, H);

    const hiddenTracks = new Set(project.tracks.filter(tr => tr.hidden).map(tr => tr.id));
    const active = project.clips
      .filter(c => t >= c.start && t < c.start + c.duration && !hiddenTracks.has(c.trackId))
      .sort((a, b) => RENDER_ORDER.indexOf(a.trackId) - RENDER_ORDER.indexOf(b.trackId));

    for (const clip of active) {
      if (clip.trackId === 'captions') { this.drawCaption(project, clip, t); continue; }
      if (clip.trackId === 'transitions') { this.drawTransitionFx(clip, t); continue; }
      if (!clip.assetId) continue;
      const media = await this.getMedia(clip.assetId);
      if (!media.el || !media.ready || media.kind === 'audio') continue;
      if (media.kind === 'video') this.syncVideoTime(clip, media, t, playing);

      let source = media.el;
      // chroma key: applied ONLY when the user enables it (single switch: vtuber.chroma.enabled).
      // Layer order stays fixed: background → VTUBER → all other layers on top.
      if (clip.trackId === 'vtuber' && project.vtuber.chroma?.enabled === true) {
        if (this.keyer) {
          try {
            const keyed = this.keyer.process(media.el, project.vtuber.chroma || {});
            if (keyed) source = keyed;
          } catch (e) {
            // WebGL context lost mid-session → switch to CPU permanently
            console.warn('Chroma keyer failed → switching to CPU', e);
            this.keyer = new CpuChromaKeyer();
            const keyed = this.keyer.process(media.el, project.vtuber.chroma || {});
            if (keyed) source = keyed;
          }
        }
      }
      this.drawClip(clip, source, t);
    }
  }

  drawClip(clip, source, t) {
    const ctx = this.ctx;
    const W = VIDEO.width, H = VIDEO.height;
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return;
    const a = this.animState(clip, t);
    const scale = (clip.scale / 100) * a.scaleMul;

    ctx.save();
    ctx.globalAlpha = (clip.opacity ?? 100) / 100 * a.alpha;

    if (clip.isBackground) {
      // cover entire frame
      const s = Math.max(W / sw, H / sh);
      const dw = sw * s, dh = sh * s;
      ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
      return;
    }

    // fit width baseline then user scale
    const base = W / sw;
    const dw = sw * base * scale, dh = sh * base * scale;
    ctx.translate(clip.x + a.dx, clip.y + a.dy);
    if (clip.rotation) ctx.rotate(clip.rotation * Math.PI / 180);
    ctx.scale(clip.flipH ? -1 : 1, clip.flipV ? -1 : 1);
    if (a.rgbShift > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha *= 0.5;
      ctx.drawImage(source, -dw / 2 - a.rgbShift, -dh / 2, dw, dh);
      ctx.drawImage(source, -dw / 2 + a.rgbShift, -dh / 2, dw, dh);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha *= 2;
    }
    ctx.drawImage(source, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  /** TikTok-style karaoke caption — RTL aware (Arabic words laid out right-to-left) */
  drawCaption(project, clip, t) {
    const ctx = this.ctx;
    const st = project.captionStyle;
    const words = clip.words || [];
    if (!words.length && !clip.text) return;
    const scale = (clip.scale ?? st.scale ?? 100) / 100;
    const fontSize = (st.fontSize || 64) * scale;
    const x = clip.x ?? st.x, y = clip.y ?? st.y;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.direction = 'ltr'; // we position words manually

    const list = words.length ? words : [{ w: clip.text, s: clip.start, e: clip.start + clip.duration }];
    // measure with per-word fonts (active word slightly larger)
    const measures = list.map(w => {
      const activeW = t >= w.s && t < w.e;
      const fs = activeW ? fontSize * (st.activeScale || 1.15) : fontSize;
      ctx.font = `800 ${fs}px "${st.font}", "Cairo", sans-serif`;
      return { ...w, fs, activeW, width: ctx.measureText(w.w + ' ').width };
    });
    // RTL: layout order reversed so first spoken word appears on the RIGHT
    const isRTL = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(list.map(w => w.w).join(''));
    const ordered = isRTL ? [...measures].reverse() : measures;
    const total = ordered.reduce((s, m) => s + m.width, 0);
    let cx = x - total / 2;
    for (const m of ordered) {
      ctx.font = `800 ${m.fs}px "${st.font}", "Cairo", sans-serif`;
      const wx = cx + m.width / 2;
      if (st.outlineWidth > 0) {
        ctx.strokeStyle = st.outlineColor || '#000';
        ctx.lineWidth = st.outlineWidth * scale;
        ctx.strokeText(m.w, wx, y);
      }
      ctx.fillStyle = m.activeW ? (st.activeColor || '#FFD400') : (st.inactiveColor || '#B8960C');
      ctx.fillText(m.w, wx, y);
      cx += m.width;
    }
    ctx.restore();
  }

  drawTransitionFx(clip, t) {
    const ctx = this.ctx;
    const rel = (t - clip.start) / Math.max(clip.duration, 0.01);
    const type = clip.transitionType || 'fade';
    ctx.save();
    if (type === 'flash') {
      ctx.globalAlpha = 1 - Math.abs(rel - 0.5) * 2;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, VIDEO.width, VIDEO.height);
    } else if (type === 'fade' || type === 'crossDissolve') {
      ctx.globalAlpha = (1 - Math.abs(rel - 0.5) * 2) * 0.85;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, VIDEO.width, VIDEO.height);
    } else if (type === 'glitch') {
      ctx.globalAlpha = 0.35 * (1 - Math.abs(rel - 0.5) * 2);
      for (let i = 0; i < 7; i++) {
        ctx.fillStyle = ['#f0f', '#0ff', '#ff0'][i % 3];
        ctx.fillRect(Math.random() * VIDEO.width, Math.random() * VIDEO.height, Math.random() * 300, 5 + Math.random() * 14);
      }
    }
    ctx.restore();
  }
}

function ease(k) { return 1 - Math.pow(1 - k, 3); }
function popEase(k) { // overshoot
  const c = 1.70158 * 1.3;
  return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
}
