/**
 * editor.js — main editor shell: preview + transport + timeline + side panels.
 */
import { el, fmtTime, clamp } from '../../utils.js';
import { t } from '../../i18n.js';
import { VIDEO, TL } from '../../config.js';
import {
  state, on, emit, navigate, setPlayhead, setPlaying, saveProject,
  undo, redo, deleteClips, duplicateClips, splitClip, getClip, setSelection,
  updateClip, pushHistory, markDirty,
} from '../../store.js';
import { Renderer } from '../../engine/renderer.js';
import { AudioEngine } from '../../engine/audio.js';
import { TimelineView } from '../../engine/timeline.js';
import { assetUrl } from '../../services/db.js';
import { toast } from '../components.js';
import { renderMediaPanel } from '../panels/mediaPanel.js';
import { renderAiPanel } from '../panels/aiPanel.js';
import { renderPropertiesPanel } from '../panels/propertiesPanel.js';
import { renderHistoryPanel } from '../panels/historyPanel.js';

let disposers = [];
function track(off) { disposers.push(off); return off; }
export function disposeEditor() { disposers.forEach(d => d()); disposers = []; }

export async function renderEditor(host) {
  disposeEditor();
  host.classList.add('no-scroll');

  if (!state.project) {
    host.append(el('div', { class: 'empty-state', style: { paddingTop: '120px' } },
      el('i', { class: 'fa-solid fa-clapperboard' }),
      el('p', {}, t('noProjects')),
      el('button', { class: 'btn btn-primary', style: { marginTop: '14px' }, onclick: () => navigate('dashboard') }, t('dashboard'))));
    return;
  }

  /* ================= layout ================= */
  const previewCanvas = el('canvas', { id: 'preview-canvas' });
  const previewWrap = el('div', { id: 'preview-wrap' }, previewCanvas);

  const tcLabel = el('span', { class: 'tc' }, fmtTime(0));
  const playBtn = el('button', { class: 'btn btn-icon btn-ghost', title: `${t('play')} (Space)` }, el('i', { class: 'fa-solid fa-play' }));
  const stopBtn = el('button', { class: 'btn btn-icon btn-ghost', title: t('stop') }, el('i', { class: 'fa-solid fa-stop' }));
  const backFrameBtn = el('button', { class: 'btn btn-icon btn-ghost', title: '←' }, el('i', { class: 'fa-solid fa-backward-step' }));
  const fwdFrameBtn = el('button', { class: 'btn btn-icon btn-ghost', title: '→' }, el('i', { class: 'fa-solid fa-forward-step' }));
  const safeBtn = el('button', { class: 'btn btn-icon btn-ghost', title: t('safeArea') }, el('i', { class: 'fa-solid fa-border-none' }));
  const fullBtn = el('button', { class: 'btn btn-icon btn-ghost', title: 'Fullscreen' }, el('i', { class: 'fa-solid fa-expand' }));
  const durLabel = el('span', { class: 'tc', style: { color: 'var(--text-2)' } }, fmtTime(state.project.duration));

  const transport = el('div', { id: 'transport' },
    tcLabel, backFrameBtn, playBtn, stopBtn, fwdFrameBtn, durLabel,
    el('span', { style: { width: '18px' } }), safeBtn, fullBtn);

  const panelCenter = el('div', { id: 'panel-center' }, previewWrap, transport);

  // left panel — media browser
  const panelMedia = el('div', { id: 'panel-media' });
  // right panel — AI / properties / history tabs
  const panelRight = el('div', { id: 'panel-right' });

  const editorTop = el('div', { id: 'editor-top' }, panelMedia, panelCenter, panelRight);

  // timeline toolbar
  const tlCanvas = el('canvas', { id: 'tl-canvas' });
  const tlWrap = el('div', { id: 'tl-canvas-wrap' }, tlCanvas);
  const mkTb = (icon, title, fn) => el('button', { class: 'btn btn-sm btn-ghost', title, onclick: fn }, el('i', { class: `fa-solid ${icon}` }));

  let tl; // TimelineView
  const snapBtn = el('button', { class: 'btn btn-sm', title: t('snap'), style: { color: 'var(--accent-2)' } }, el('i', { class: 'fa-solid fa-magnet' }));
  snapBtn.onclick = () => {
    tl.snap = !tl.snap;
    snapBtn.style.color = tl.snap ? 'var(--accent-2)' : 'var(--text-2)';
  };

  const tlToolbar = el('div', { id: 'tl-toolbar' },
    mkTb('fa-rotate-left', `${t('undo')} (Ctrl+Z)`, undo),
    mkTb('fa-rotate-right', `${t('redo')} (Ctrl+Shift+Z)`, redo),
    el('span', { style: { width: '10px' } }),
    mkTb('fa-scissors', `${t('split')} (S)`, () => splitAtPlayhead()),
    mkTb('fa-copy', `${t('duplicate')} (Ctrl+D)`, () => duplicateClips(state.selection)),
    mkTb('fa-trash', `${t('delete')} (Del)`, () => deleteClips(state.selection)),
    el('span', { class: 'grow' }),
    snapBtn,
    mkTb('fa-magnifying-glass-minus', t('zoomOut'), () => tl.zoom(1 / 1.3)),
    mkTb('fa-magnifying-glass-plus', t('zoomIn'), () => tl.zoom(1.3)),
    mkTb('fa-arrows-left-right-to-line', t('fit'), () => tl.zoomFit()),
    mkTb('fa-floppy-disk', `${t('save')} (Ctrl+S)`, async () => { await saveProject(); toast(t('saved'), 'success'); }),
  );

  const editorBottom = el('div', { id: 'editor-bottom' },
    el('div', { id: 'tl-resizer' }), tlToolbar, tlWrap);

  const root = el('div', { id: 'editor-root' }, editorTop, editorBottom);
  host.append(root);

  /* ================= engines ================= */
  const renderer = new Renderer(previewCanvas);
  const audio = new AudioEngine();
  tl = new TimelineView(tlCanvas, tlWrap);
  // redraw when a paused video finishes seeking / media loads late (prevents black frames)
  renderer.onFrameReady = () => { if (!state.playing) renderFrame(); };

  // fit preview canvas into wrap
  const fitPreview = () => {
    const r = previewWrap.getBoundingClientRect();
    const s = Math.min((r.width - 24) / VIDEO.width, (r.height - 24) / VIDEO.height);
    previewCanvas.style.width = VIDEO.width * s + 'px';
    previewCanvas.style.height = VIDEO.height * s + 'px';
  };
  new ResizeObserver(fitPreview).observe(previewWrap);
  fitPreview();

  /* ---------- playback loop ---------- */
  let rafId = 0, playStartWall = 0, playStartT = 0, safeArea = false;
  let vtVoiceEl = null; // vtuber video element for voice

  async function getVtVoice() {
    const vt = state.project.clips.find(c => c.trackId === 'vtuber' && c.assetId);
    if (!vt) return null;
    const media = await renderer.getMedia(vt.assetId, 'video');
    return media?.el ? { clip: vt, el: media.el } : null;
  }

  const drawSafeArea = () => {
    if (!safeArea) return;
    const ctx = previewCanvas.getContext('2d');
    ctx.save();
    ctx.strokeStyle = 'rgba(45,212,191,.6)'; ctx.lineWidth = 3; ctx.setLineDash([14, 10]);
    ctx.strokeRect(VIDEO.width * .05, VIDEO.height * .05, VIDEO.width * .9, VIDEO.height * .9);
    ctx.restore();
  };

  let renderPending = false;
  async function renderFrame() {
    if (renderPending) return;
    renderPending = true;
    await renderer.render(state.project, state.playhead, state.playing);
    drawSafeArea();
    drawSelectionOverlay();
    renderPending = false;
  }

  async function play() {
    if (state.playing) return;
    setPlaying(true);
    playStartWall = performance.now();
    playStartT = state.playhead >= state.project.duration - 0.05 ? 0 : state.playhead;
    await audio.start(state.project, playStartT);
    const vt = await getVtVoice();
    if (vt) {
      const trackMuted = state.project.tracks.find(tr => tr.id === 'vtuber')?.muted;
      vt.el.muted = !!trackMuted || !!vt.clip.muted;
      vt.el.volume = clamp(Math.pow(10, (vt.clip.volume || 0) / 20), 0, 1);
      vtVoiceEl = vt.el;
    }
    playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    const loop = () => {
      if (!state.playing) return;
      const t2 = playStartT + (performance.now() - playStartWall) / 1000;
      if (t2 >= state.project.duration) { pause(); setPlayhead(state.project.duration); return; }
      state.playhead = t2;
      emit('playback');
      renderFrame();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  function pause() {
    setPlaying(false);
    cancelAnimationFrame(rafId);
    audio.stop();
    renderer.pauseAll();
    if (vtVoiceEl) vtVoiceEl.muted = true;
    playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
    renderFrame();
  }

  playBtn.onclick = () => state.playing ? pause() : play();
  stopBtn.onclick = () => { pause(); setPlayhead(0); };
  backFrameBtn.onclick = () => { pause(); setPlayhead(state.playhead - 1 / VIDEO.fps); };
  fwdFrameBtn.onclick = () => { pause(); setPlayhead(state.playhead + 1 / VIDEO.fps); };
  safeBtn.onclick = () => { safeArea = !safeArea; renderFrame(); };
  fullBtn.onclick = () => previewCanvas.requestFullscreen?.();

  /* ---------- direct manipulation in preview ---------- */
  const canvasPoint = (e) => {
    const r = previewCanvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width * VIDEO.width, y: (e.clientY - r.top) / r.height * VIDEO.height };
  };
  function visualClipsAt(pt) {
    const order = ['captions', 'overlays', 'memes', 'broll_img', 'broll_vid', 'vtuber', 'background'];
    const active = state.project.clips.filter(c =>
      state.playhead >= c.start && state.playhead < c.start + c.duration &&
      order.includes(c.trackId) && !state.project.tracks.find(tr => tr.id === c.trackId)?.locked);
    active.sort((a, b) => order.indexOf(a.trackId) - order.indexOf(b.trackId));
    for (const c of active) {
      if (c.isBackground) continue;
      const half = hitHalf(c);
      if (Math.abs(pt.x - c.x) <= half.w && Math.abs(pt.y - c.y) <= half.h) return c;
    }
    return null;
  }
  function hitHalf(c) {
    // approximate box: base fit-width × scale
    const media = renderer.mediaCache.get(c.assetId);
    const sw = media?.el?.videoWidth || media?.el?.naturalWidth || 400;
    const sh = media?.el?.videoHeight || media?.el?.naturalHeight || 300;
    const base = VIDEO.width / sw;
    const s = (c.scale / 100) * base;
    if (c.trackId === 'captions') return { w: 400, h: 70 };
    return { w: sw * s / 2, h: sh * s / 2 };
  }
  function drawSelectionOverlay() {
    const sel = state.selection.map(getClip).filter(Boolean).filter(c => !c.isBackground &&
      state.playhead >= c.start && state.playhead < c.start + c.duration && c.trackId !== 'music' && c.trackId !== 'sfx');
    if (!sel.length) return;
    const ctx = previewCanvas.getContext('2d');
    ctx.save();
    for (const c of sel) {
      const half = hitHalf(c);
      ctx.strokeStyle = '#7c5cff'; ctx.lineWidth = 4; ctx.setLineDash([]);
      ctx.strokeRect(c.x - half.w, c.y - half.h, half.w * 2, half.h * 2);
      // corner handles
      ctx.fillStyle = '#fff';
      for (const [hx, hy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        ctx.fillRect(c.x + hx * half.w - 10, c.y + hy * half.h - 10, 20, 20);
      }
    }
    ctx.restore();
  }

  let dragObj = null;
  previewCanvas.addEventListener('pointerdown', (e) => {
    const pt = canvasPoint(e);
    // check scale handle on already-selected clip
    const selClip = state.selection.map(getClip).filter(Boolean).find(c => !c.isBackground);
    if (selClip && state.playhead >= selClip.start && state.playhead < selClip.start + selClip.duration) {
      const half = hitHalf(selClip);
      for (const [hx, hy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (Math.abs(pt.x - (selClip.x + hx * half.w)) < 26 && Math.abs(pt.y - (selClip.y + hy * half.h)) < 26) {
          pushHistory('Scale');
          dragObj = { mode: 'scale', clip: selClip, startDist: Math.hypot(pt.x - selClip.x, pt.y - selClip.y), startScale: selClip.scale };
          previewCanvas.setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    const hit = visualClipsAt(pt);
    if (hit) {
      setSelection([hit.id]);
      pushHistory('Move');
      dragObj = { mode: 'move', clip: hit, dx: pt.x - hit.x, dy: pt.y - hit.y };
      previewCanvas.setPointerCapture(e.pointerId);
    } else {
      setSelection([]);
    }
    renderFrame();
  });
  previewCanvas.addEventListener('pointermove', (e) => {
    if (!dragObj) return;
    const pt = canvasPoint(e);
    const c = dragObj.clip;
    if (dragObj.mode === 'move') {
      c.x = Math.round((pt.x - dragObj.dx) * 10) / 10;
      c.y = Math.round((pt.y - dragObj.dy) * 10) / 10;
      if (c.trackId === 'vtuber') { state.project.vtuber.x = c.x; state.project.vtuber.y = c.y; }
      // captions move as one unified block (position shared by all caption clips)
      if (c.trackId === 'captions') {
        state.project.captionStyle.x = c.x; state.project.captionStyle.y = c.y;
        for (const cc of state.project.clips) if (cc.trackId === 'captions') { cc.x = c.x; cc.y = c.y; }
      }
    } else if (dragObj.mode === 'scale') {
      const d = Math.hypot(pt.x - c.x, pt.y - c.y);
      c.scale = Math.max(2, Math.round(dragObj.startScale * (d / Math.max(dragObj.startDist, 1)) * 10) / 10);
      if (c.trackId === 'vtuber') state.project.vtuber.scale = c.scale;
      if (c.trackId === 'captions') {
        state.project.captionStyle.scale = c.scale;
        for (const cc of state.project.clips) if (cc.trackId === 'captions') cc.scale = c.scale;
      }
    }
    markDirty(); emit('timeline'); emit('selection');
    renderFrame();
  });
  previewCanvas.addEventListener('pointerup', () => { dragObj = null; });

  /* ---------- split at playhead ---------- */
  function splitAtPlayhead() {
    for (const id of state.selection) splitClip(id, state.playhead);
    if (!state.selection.length) {
      // split any clip under playhead on unlocked tracks
      const c = state.project.clips.find(cl => state.playhead > cl.start && state.playhead < cl.start + cl.duration);
      if (c) splitClip(c.id, state.playhead);
    }
  }

  /* ---------- timeline resizer ---------- */
  const resizer = root.querySelector('#tl-resizer');
  resizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = editorBottom.getBoundingClientRect().height;
    const move = (ev) => { editorBottom.style.height = clamp(startH + (startY - ev.clientY), 160, window.innerHeight - 220) + 'px'; };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });

  /* ---------- keyboard shortcuts ---------- */
  const keyHandler = (e) => {
    if (state.route !== 'editor') return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
    else if (ctrl && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (ctrl && (e.key === 'Z' || (e.shiftKey && e.key === 'z') || e.key === 'y')) { e.preventDefault(); redo(); }
    else if (ctrl && e.key === 's') { e.preventDefault(); saveProject().then(() => toast(t('saved'), 'success')); }
    else if (ctrl && e.key === 'd') { e.preventDefault(); duplicateClips(state.selection); }
    else if (ctrl && e.key === 'c') { window._clipboard = state.selection.map(getClip).filter(Boolean).map(c => JSON.parse(JSON.stringify(c))); }
    else if (ctrl && e.key === 'v' && window._clipboard?.length) {
      pushHistory('Paste');
      const ids = [];
      for (const c of window._clipboard) {
        const copy = { ...c, id: crypto.randomUUID(), start: state.playhead };
        state.project.clips.push(copy); ids.push(copy.id);
      }
      setSelection(ids); markDirty(); emit('timeline');
    }
    else if (e.key === 'Delete' || e.key === 'Backspace') { deleteClips(state.selection); }
    else if (e.key === 's' && !ctrl) { splitAtPlayhead(); }
    else if (e.key === 'ArrowLeft') { pause(); setPlayhead(state.playhead - (e.shiftKey ? 1 : 1 / VIDEO.fps)); }
    else if (e.key === 'ArrowRight') { pause(); setPlayhead(state.playhead + (e.shiftKey ? 1 : 1 / VIDEO.fps)); }
    else if (e.key === 'Home') { pause(); setPlayhead(0); }
    else if (e.key === 'End') { pause(); setPlayhead(state.project.duration); }
  };
  window.addEventListener('keydown', keyHandler);
  track(() => window.removeEventListener('keydown', keyHandler));

  /* ---------- panels ---------- */
  renderMediaPanel(panelMedia, { renderer, renderFrame });
  buildRightPanel(panelRight, { renderer, renderFrame });

  /* ---------- subscriptions ---------- */
  track(on('playback', () => { tcLabel.textContent = fmtTime(state.playhead); if (!state.playing) renderFrame(); }));
  track(on('timeline', () => { durLabel.textContent = fmtTime(state.project?.duration ?? 0); if (!state.playing) renderFrame(); }));
  track(on('project', () => { if (!state.playing) renderFrame(); }));
  track(on('selection', () => { if (!state.playing) renderFrame(); }));

  renderFrame();
}

/* right panel with tabs: AI / Properties / History */
function buildRightPanel(panelRight, ctx2) {
  const tabs = [
    { id: 'ai', label: t('ai'), render: renderAiPanel },
    { id: 'props', label: t('properties'), render: renderPropertiesPanel },
    { id: 'history', label: t('history'), render: renderHistoryPanel },
  ];
  let active = 'ai';
  const tabBar = el('div', { class: 'panel-tabs' });
  const body = el('div', { class: 'panel-body' });
  const rebuild = () => {
    body.innerHTML = '';
    tabs.find(tb => tb.id === active).render(body, ctx2);
  };
  for (const tb of tabs) {
    const b = el('button', { class: `panel-tab ${tb.id === active ? 'active' : ''}` }, tb.label);
    b.onclick = () => {
      active = tb.id;
      [...tabBar.children].forEach(c => c.classList.remove('active'));
      b.classList.add('active');
      rebuild();
    };
    tabBar.append(b);
  }
  panelRight.append(tabBar, body);
  rebuild();
  // auto-switch to properties when a clip is selected
  track(on('selection', () => {
    if (state.selection.length && active === 'ai') {
      active = 'props';
      [...tabBar.children].forEach((c, i) => c.classList.toggle('active', tabs[i].id === 'props'));
      rebuild();
    } else if (active === 'props') rebuild();
  }));
  track(on('history', () => { if (active === 'history') rebuild(); }));
}
