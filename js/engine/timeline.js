/**
 * timeline.js — professional canvas-based timeline (NLE style).
 * Canvas rendering (no DOM elements per clip) → smooth with hundreds of clips.
 * Features: zoom, scroll, ruler, snap, drag/move, trim edges, playhead scrub,
 * multi-selection, marquee, track headers (lock/hide/mute), markers.
 */
import { TL } from '../config.js';
import { state, getClip, setSelection, setPlayhead, updateClip, pushHistory, markDirty, emit, on, recalcDuration } from '../store.js';
import { trackName, getLang } from '../i18n.js';
import { clamp, throttle } from '../utils.js';

export class TimelineView {
  constructor(canvas, wrap) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext('2d');
    this.pxPerSec = TL.defaultPxPerSec;
    this.scrollX = 0;   // seconds*px offset
    this.scrollY = 0;
    this.snap = true;
    this.drag = null;   // {mode:'move'|'trimL'|'trimR'|'scrub'|'marquee', ...}
    this.hover = null;
    this.dpr = window.devicePixelRatio || 1;
    this.needsDraw = true;

    this.bindEvents();
    on('timeline', () => this.invalidate());
    on('selection', () => this.invalidate());
    on('playback', () => this.invalidate());
    const loop = () => { if (this.needsDraw) { this.needsDraw = false; this.draw(); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    new ResizeObserver(() => { this.resize(); }).observe(wrap);
    this.resize();
  }

  invalidate() { this.needsDraw = true; }

  resize() {
    const r = this.wrap.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    this.canvas.width = r.width * this.dpr;
    this.canvas.height = r.height * this.dpr;
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.W = r.width; this.H = r.height;
    this.invalidate();
  }

  /* ---------- coordinate helpers ---------- */
  timeToX(t) { return TL.headerWidth + t * this.pxPerSec - this.scrollX; }
  xToTime(x) { return (x - TL.headerWidth + this.scrollX) / this.pxPerSec; }

  trackLayout() {
    const p = state.project;
    if (!p) return [];
    let y = TL.rulerHeight - this.scrollY;
    return p.tracks.map(tr => {
      const row = { track: tr, y, h: tr.height + 8 };
      y += tr.height + 8;
      return row;
    });
  }

  clipRect(clip, rows) {
    const row = rows.find(r => r.track.id === clip.trackId);
    if (!row) return null;
    return {
      x: this.timeToX(clip.start),
      y: row.y + 3,
      w: clip.duration * this.pxPerSec,
      h: row.h - 6,
    };
  }

  snapTime(t, excludeIds = []) {
    if (!this.snap) return Math.max(0, t);
    const p = state.project;
    const thr = TL.snapThresholdPx / this.pxPerSec;
    let best = null, bestD = thr;
    const candidates = [0, state.playhead];
    for (const c of p.clips) {
      if (excludeIds.includes(c.id)) continue;
      candidates.push(c.start, c.start + c.duration);
    }
    for (const m of p.markers || []) candidates.push(m.time);
    // second snap
    candidates.push(Math.round(t));
    for (const c of candidates) {
      const d = Math.abs(t - c);
      if (d < bestD) { bestD = d; best = c; }
    }
    return Math.max(0, best ?? t);
  }

  /* ---------- drawing ---------- */
  draw() {
    const ctx = this.ctx;
    const p = state.project;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.fillStyle = '#131316';
    ctx.fillRect(0, 0, this.W, this.H);
    if (!p) { ctx.restore(); return; }

    const rows = this.trackLayout();

    // track rows background
    for (const r of rows) {
      ctx.fillStyle = '#18181c';
      ctx.fillRect(TL.headerWidth, r.y, this.W - TL.headerWidth, r.h - 2);
    }

    // grid (seconds)
    const step = this.gridStep();
    const t0 = Math.floor(this.xToTime(TL.headerWidth) / step) * step;
    const t1 = this.xToTime(this.W);
    ctx.strokeStyle = 'rgba(255,255,255,.045)';
    ctx.beginPath();
    for (let t = Math.max(0, t0); t <= t1; t += step) {
      const x = this.timeToX(t);
      ctx.moveTo(x, TL.rulerHeight); ctx.lineTo(x, this.H);
    }
    ctx.stroke();

    // clips
    const rtl = getLang() === 'ar';
    for (const clip of p.clips) {
      const r = this.clipRect(clip, rows);
      if (!r || r.x + r.w < TL.headerWidth || r.x > this.W) continue;
      const row = rows.find(rr => rr.track.id === clip.trackId);
      const selected = state.selection.includes(clip.id);
      const color = row.track.color;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(Math.max(r.x, TL.headerWidth), r.y, Math.max(2, Math.min(r.w, this.W - r.x)), r.h, 4);
      ctx.clip();
      ctx.fillStyle = selected ? color : color + '55';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = selected ? '#fff' : color;
      ctx.lineWidth = selected ? 1.6 : 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      // label
      if (r.w > 34) {
        ctx.fillStyle = selected ? '#0b0b0d' : '#e9e9ef';
        ctx.font = '600 10px Inter, Cairo, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText((clip.name || clip.text || '').slice(0, Math.floor(r.w / 6)), Math.max(r.x, TL.headerWidth) + 6, r.y + r.h / 2);
      }
      // aiGen badge
      if (clip.aiGen && r.w > 20) {
        ctx.fillStyle = selected ? '#0b0b0d' : color;
        ctx.font = '800 8px Inter';
        ctx.textAlign = 'right';
        ctx.fillText('AI', r.x + r.w - 5, r.y + 9);
      }
      ctx.restore();
      // trim handles on hover/selected
      if (selected && r.w > 18) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(r.x, r.y + r.h / 2 - 6, 3, 12);
        ctx.fillRect(r.x + r.w - 3, r.y + r.h / 2 - 6, 3, 12);
      }
    }

    // marquee
    if (this.drag?.mode === 'marquee') {
      const d = this.drag;
      ctx.fillStyle = 'rgba(124,92,255,.12)';
      ctx.strokeStyle = 'rgba(124,92,255,.7)';
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
      const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    }

    // ruler
    ctx.fillStyle = '#101013';
    ctx.fillRect(TL.headerWidth, 0, this.W - TL.headerWidth, TL.rulerHeight);
    ctx.strokeStyle = '#2b2b31';
    ctx.beginPath(); ctx.moveTo(0, TL.rulerHeight - 0.5); ctx.lineTo(this.W, TL.rulerHeight - 0.5); ctx.stroke();
    ctx.fillStyle = '#7d7d89';
    ctx.font = '9.5px JetBrains Mono, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let t = Math.max(0, t0); t <= t1; t += step) {
      const x = this.timeToX(t);
      ctx.fillText(fmtRuler(t), x, TL.rulerHeight / 2);
    }
    // markers
    for (const m of p.markers || []) {
      const x = this.timeToX(m.time);
      if (x < TL.headerWidth) continue;
      ctx.fillStyle = m.color || '#7c5cff';
      ctx.beginPath();
      ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 7);
      ctx.closePath(); ctx.fill();
    }

    // track headers
    for (const r of rows) {
      ctx.fillStyle = '#1a1a1f';
      ctx.fillRect(0, r.y, TL.headerWidth, r.h - 2);
      ctx.fillStyle = r.track.color;
      rtl ? ctx.fillRect(TL.headerWidth - 3, r.y, 3, r.h - 2) : ctx.fillRect(0, r.y, 3, r.h - 2);
      ctx.fillStyle = r.track.hidden ? '#55555f' : '#c9c9d4';
      ctx.font = '700 10.5px Inter, Cairo, sans-serif';
      ctx.textAlign = rtl ? 'right' : 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(trackName(r.track), rtl ? TL.headerWidth - 10 : 10, r.y + r.h / 2 - 6);
      // toggles: lock / hide / mute
      ctx.font = '9px Inter';
      const icons = [
        { k: 'locked', on: '🔒', off: '🔓' },
        { k: 'hidden', on: '🙈', off: '👁' },
        { k: 'muted', on: '🔇', off: '🔊' },
      ];
      icons.forEach((ic, i) => {
        const ix = rtl ? TL.headerWidth - 16 - i * 18 : 8 + i * 18;
        ctx.globalAlpha = r.track[ic.k] ? 1 : 0.4;
        ctx.textAlign = 'left';
        ctx.fillText(r.track[ic.k] ? ic.on : ic.off, ix, r.y + r.h / 2 + 9);
        ctx.globalAlpha = 1;
      });
    }
    // header top-left corner
    ctx.fillStyle = '#101013';
    ctx.fillRect(0, 0, TL.headerWidth, TL.rulerHeight);
    ctx.strokeStyle = '#2b2b31';
    ctx.beginPath(); ctx.moveTo(TL.headerWidth - 0.5, 0); ctx.lineTo(TL.headerWidth - 0.5, this.H); ctx.stroke();

    // playhead
    const px = this.timeToX(state.playhead);
    if (px >= TL.headerWidth) {
      ctx.strokeStyle = '#f0475c';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, this.H); ctx.stroke();
      ctx.fillStyle = '#f0475c';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 8);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  gridStep() {
    const target = 80 / this.pxPerSec;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    return steps.find(s => s >= target) ?? 60;
  }

  /* ---------- interaction ---------- */
  hitTest(x, y) {
    const p = state.project;
    if (!p) return null;
    const rows = this.trackLayout();
    // headers
    if (x < TL.headerWidth && y > TL.rulerHeight) {
      const row = rows.find(r => y >= r.y && y < r.y + r.h);
      if (row) {
        const rtl = getLang() === 'ar';
        const idx = rtl ? Math.floor((TL.headerWidth - 16 - (x - 2)) / 18) : Math.floor((x - 8) / 18);
        if (y > row.y + row.h / 2) {
          const keys = ['locked', 'hidden', 'muted'];
          if (idx >= 0 && idx < 3) return { type: 'trackToggle', track: row.track, key: keys[idx] };
        }
        return { type: 'trackHeader', track: row.track };
      }
      return null;
    }
    if (y < TL.rulerHeight) return { type: 'ruler' };
    // clips (topmost = later in render order → iterate reversed)
    for (let i = p.clips.length - 1; i >= 0; i--) {
      const clip = p.clips[i];
      const r = this.clipRect(clip, rows);
      if (!r) continue;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        const track = p.tracks.find(t => t.id === clip.trackId);
        if (track?.locked) return { type: 'lockedClip', clip };
        const edge = 7;
        if (x - r.x < edge && r.w > 20) return { type: 'trimL', clip };
        if (r.x + r.w - x < edge && r.w > 20) return { type: 'trimR', clip };
        return { type: 'clip', clip };
      }
    }
    return { type: 'empty' };
  }

  bindEvents() {
    const c = this.canvas;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      const { x, y } = pos(e);
      const hit = this.hitTest(x, y);
      if (!hit) return;
      if (hit.type === 'trackToggle') {
        pushHistory('Track toggle');
        hit.track[hit.key] = !hit.track[hit.key];
        markDirty(); emit('timeline');
        return;
      }
      if (hit.type === 'ruler' || hit.type === 'empty' && e.shiftKey === false && y < TL.rulerHeight) {
        this.drag = { mode: 'scrub' };
        setPlayhead(clamp(this.xToTime(x), 0, state.project.duration));
        return;
      }
      if (hit.type === 'ruler') { this.drag = { mode: 'scrub' }; return; }
      if (hit.type === 'clip') {
        const already = state.selection.includes(hit.clip.id);
        if (e.shiftKey) setSelection(already ? state.selection.filter(i => i !== hit.clip.id) : [...state.selection, hit.clip.id]);
        else if (!already) setSelection([hit.clip.id]);
        // prepare move
        const sel = state.selection.length ? state.selection : [hit.clip.id];
        this.drag = {
          mode: 'move', t0: this.xToTime(x), moved: false,
          clips: sel.map(id => ({ id, start: getClip(id)?.start ?? 0, trackId: getClip(id)?.trackId })),
          primary: hit.clip.id, y0: y,
        };
        return;
      }
      if (hit.type === 'trimL' || hit.type === 'trimR') {
        setSelection([hit.clip.id]);
        this.drag = {
          mode: hit.type, id: hit.clip.id, t0: this.xToTime(x), moved: false,
          orig: { start: hit.clip.start, duration: hit.clip.duration, inPoint: hit.clip.inPoint || 0 },
        };
        return;
      }
      if (hit.type === 'empty') {
        if (!e.shiftKey) setSelection([]);
        this.drag = { mode: 'marquee', x0: x, y0: y, x1: x, y1: y };
      }
    });

    c.addEventListener('pointermove', throttle((e) => {
      const { x, y } = pos(e);
      if (!this.drag) {
        const hit = this.hitTest(x, y);
        c.style.cursor = hit?.type === 'trimL' || hit?.type === 'trimR' ? 'ew-resize'
          : hit?.type === 'clip' ? 'grab' : hit?.type === 'ruler' ? 'col-resize' : 'default';
        return;
      }
      const d = this.drag;
      if (d.mode === 'scrub') {
        setPlayhead(clamp(this.xToTime(x), 0, state.project.duration));
      } else if (d.mode === 'move') {
        const dt = this.xToTime(x) - d.t0;
        if (!d.moved && Math.abs(dt * this.pxPerSec) > 3) { d.moved = true; pushHistory('Move'); }
        if (!d.moved) return;
        // vertical track change for single selection
        let newTrack = null;
        if (d.clips.length === 1) {
          const rows = this.trackLayout();
          const row = rows.find(r => y >= r.y && y < r.y + r.h);
          const clip = getClip(d.primary);
          const curTrack = state.project.tracks.find(t => t.id === d.clips[0].trackId);
          if (row && clip && row.track.kind === curTrack?.kind && !row.track.locked) newTrack = row.track.id;
        }
        const primary = d.clips.find(cl => cl.id === d.primary) || d.clips[0];
        const snapped = this.snapTime(primary.start + dt, d.clips.map(cl => cl.id));
        const actualDt = snapped - primary.start;
        for (const cl of d.clips) {
          const clip = getClip(cl.id); if (!clip) continue;
          clip.start = Math.max(0, cl.start + actualDt);
          if (newTrack && cl.id === d.primary) clip.trackId = newTrack;
        }
        recalcDuration(); markDirty(); emit('timeline');
      } else if (d.mode === 'trimL') {
        const clip = getClip(d.id); if (!clip) return;
        if (!d.moved) { d.moved = true; pushHistory('Trim'); }
        const dt = this.xToTime(x) - d.t0;
        const ns = this.snapTime(d.orig.start + dt, [d.id]);
        const delta = clamp(ns - d.orig.start, -d.orig.inPoint, d.orig.duration - TL.minClipDur);
        clip.start = d.orig.start + delta;
        clip.duration = d.orig.duration - delta;
        clip.inPoint = d.orig.inPoint + delta;
        markDirty(); emit('timeline');
      } else if (d.mode === 'trimR') {
        const clip = getClip(d.id); if (!clip) return;
        if (!d.moved) { d.moved = true; pushHistory('Trim'); }
        const dt = this.xToTime(x) - d.t0;
        const ne = this.snapTime(d.orig.start + d.orig.duration + dt, [d.id]);
        clip.duration = Math.max(TL.minClipDur, ne - d.orig.start);
        recalcDuration(); markDirty(); emit('timeline');
      } else if (d.mode === 'marquee') {
        d.x1 = x; d.y1 = y;
        // live selection
        const rows = this.trackLayout();
        const rx = Math.min(d.x0, d.x1), ry = Math.min(d.y0, d.y1);
        const rw = Math.abs(d.x1 - d.x0), rh = Math.abs(d.y1 - d.y0);
        const ids = [];
        for (const clip of state.project.clips) {
          const r = this.clipRect(clip, rows); if (!r) continue;
          if (r.x < rx + rw && r.x + r.w > rx && r.y < ry + rh && r.y + r.h > ry) ids.push(clip.id);
        }
        setSelection(ids);
        this.invalidate();
      }
    }, 16));

    c.addEventListener('pointerup', () => { this.drag = null; this.invalidate(); });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // zoom around cursor
        const r = c.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const tAt = this.xToTime(mx);
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        this.pxPerSec = clamp(this.pxPerSec * factor, TL.minPxPerSec, TL.maxPxPerSec);
        this.scrollX = tAt * this.pxPerSec - (mx - TL.headerWidth);
        this.scrollX = Math.max(0, this.scrollX);
      } else if (e.shiftKey) {
        this.scrollX = Math.max(0, this.scrollX + e.deltaY);
      } else {
        this.scrollY = Math.max(0, this.scrollY + e.deltaY * 0.6);
        this.scrollX = Math.max(0, this.scrollX + e.deltaX);
      }
      this.invalidate();
    }, { passive: false });

    // double-click ruler adds marker
    c.addEventListener('dblclick', (e) => {
      const { x, y } = pos(e);
      if (y < TL.rulerHeight && x > TL.headerWidth && state.project) {
        pushHistory('Add marker');
        state.project.markers.push({ id: 'm' + Date.now(), time: this.xToTime(x), label: '', color: '#2dd4bf' });
        markDirty(); this.invalidate();
      }
    });
  }

  zoom(factor) {
    this.pxPerSec = clamp(this.pxPerSec * factor, TL.minPxPerSec, TL.maxPxPerSec);
    this.invalidate();
  }
  zoomFit() {
    const p = state.project; if (!p) return;
    this.pxPerSec = clamp((this.W - TL.headerWidth - 30) / Math.max(p.duration, 1), TL.minPxPerSec, TL.maxPxPerSec);
    this.scrollX = 0;
    this.invalidate();
  }
}

function fmtRuler(t) {
  const m = Math.floor(t / 60), s = t % 60;
  return s % 1 === 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s.toFixed(1)}s`;
}
