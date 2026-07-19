/**
 * audio.js — playback audio engine.
 * Voice comes from the VTuber video element (unmuted during playback).
 * Music & SFX are scheduled via WebAudio with per-clip gain (dB), treble shelf, fades.
 */
import { assetUrl } from '../services/db.js';

const dbToGain = (db) => Math.pow(10, db / 20);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();   // assetId -> AudioBuffer
    this.playing = [];          // active source nodes
  }

  ensureCtx() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  async getBuffer(assetId) {
    if (this.buffers.has(assetId)) return this.buffers.get(assetId);
    const url = await assetUrl(assetId);
    if (!url) return null;
    try {
      const res = await fetch(url);
      const buf = await this.ensureCtx().decodeAudioData(await res.arrayBuffer());
      this.buffers.set(assetId, buf);
      return buf;
    } catch { return null; }
  }

  /**
   * Start audio playback for all audio clips (music, sfx) from time t.
   * Muted tracks and clips are skipped.
   */
  async start(project, t) {
    this.stop();
    const ctx = this.ensureCtx();
    const mutedTracks = new Set(project.tracks.filter(tr => tr.muted).map(tr => tr.id));
    const audioClips = project.clips.filter(c =>
      (c.trackId === 'music' || c.trackId === 'sfx') && c.assetId && !c.muted && !mutedTracks.has(c.trackId)
      && c.start + c.duration > t
    );
    for (const clip of audioClips) {
      const buf = await this.getBuffer(clip.assetId);
      if (!buf) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = !!clip.loop;

      const gain = ctx.createGain();
      const g = dbToGain(clip.volume ?? 0);
      let node = src;

      // treble shelf (music mastering)
      if (typeof clip.treble === 'number' && clip.treble !== 0) {
        const shelf = ctx.createBiquadFilter();
        shelf.type = 'highshelf';
        shelf.frequency.value = 4000;
        shelf.gain.value = clip.treble;
        node.connect(shelf); node = shelf;
      }
      node.connect(gain); gain.connect(ctx.destination);

      const now = ctx.currentTime;
      const clipStartsIn = clip.start - t; // may be negative (already inside)
      const offset = Math.max(0, t - clip.start) + (clip.inPoint || 0);
      const when = now + Math.max(0, clipStartsIn);
      const remain = clip.duration - Math.max(0, t - clip.start);
      if (remain <= 0) continue;

      // fades
      gain.gain.setValueAtTime(clip.fadeIn > 0 && offset < clip.fadeIn ? 0.0001 : g, when);
      if (clip.fadeIn > 0 && offset < clip.fadeIn) gain.gain.linearRampToValueAtTime(g, when + (clip.fadeIn - offset));
      if (clip.fadeOut > 0) {
        gain.gain.setValueAtTime(g, when + Math.max(0, remain - clip.fadeOut));
        gain.gain.linearRampToValueAtTime(0.0001, when + remain);
      }

      try {
        src.start(when, src.loop ? offset % buf.duration : Math.min(offset, buf.duration - 0.01), src.loop ? undefined : remain);
        if (src.loop) src.stop(when + remain);
        this.playing.push(src);
      } catch { /* ignore scheduling errors */ }
    }
  }

  stop() {
    for (const s of this.playing) { try { s.stop(); } catch {} }
    this.playing = [];
  }
}
