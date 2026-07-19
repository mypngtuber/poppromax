/**
 * propertiesPanel.js — Inspector: transform, chroma key, transitions, audio, captions.
 * Live editing — every change updates the preview instantly.
 */
import { el } from '../../utils.js';
import { t } from '../../i18n.js';
import { TRANSITIONS, ANIMATIONS, CAPTION_TEMPLATES, CHROMA_DEFAULTS } from '../../config.js';
import { state, getClip, updateClip, pushHistory, markDirty, emit } from '../../store.js';
import { sliderRow } from '../components.js';
import { detectSystemFonts } from '../../services/fonts.js';
import { buildCaptionClips } from '../../services/timelineGenerator.js';

export function renderPropertiesPanel(host, { renderFrame }) {
  host.innerHTML = '';
  const clip = state.selection.length ? getClip(state.selection[0]) : null;
  if (!clip) {
    host.append(el('div', { class: 'empty-state' },
      el('i', { class: 'fa-solid fa-sliders' }), t('noClipSelected')));
    return;
  }
  const p = state.project;
  const isAudio = clip.trackId === 'music' || clip.trackId === 'sfx';
  const isCaption = clip.trackId === 'captions';
  const isVtuber = clip.trackId === 'vtuber';

  // helper: patch clip with history once per slider commit
  let pendingHistory = null;
  const patch = (key, val, commit = true, label = 'Edit') => {
    if (commit && pendingHistory !== label) { pushHistory(label); pendingHistory = label; }
    clip[key] = val;
    if (isVtuber && ['x', 'y', 'scale'].includes(key)) p.vtuber[key] = val;
    // caption position/scale is unified — apply to ALL caption clips + global style
    if (isCaption && ['x', 'y', 'scale'].includes(key)) {
      p.captionStyle[key] = val;
      for (const c of p.clips) if (c.trackId === 'captions') c[key] = val;
    }
    markDirty(); emit('timeline');
    renderFrame();
    if (commit) setTimeout(() => { pendingHistory = null; }, 400);
  };

  const group = (title, icon, ...children) =>
    el('div', { class: 'prop-group' }, el('h4', {}, el('i', { class: `fa-solid ${icon}` }), title), ...children);

  /* ---- info ---- */
  const timeRow = (label, key) => {
    const inp = el('input', { class: 'prop-num', value: (clip[key] ?? 0).toFixed(2) });
    inp.onchange = () => patch(key, Math.max(key === 'duration' ? 0.05 : 0, parseFloat(inp.value) || 0), true, 'Timing');
    return el('div', { class: 'prop-row' }, el('label', {}, label), el('span', {}), inp);
  };
  host.append(group(clip.name || clip.text || clip.trackId, 'fa-clapperboard',
    timeRow(t('startL'), 'start'),
    timeRow(t('duration'), 'duration'),
  ));

  /* ---- transform (visual clips) ---- */
  if (!isAudio) {
    host.append(group(t('transform'), 'fa-up-down-left-right',
      sliderRow('X', clip.x ?? 540, -540, 1620, 0.5, (v, c) => patch('x', v, c, 'Transform'), v => v.toFixed(1)),
      sliderRow('Y', clip.y ?? 960, -960, 2880, 0.5, (v, c) => patch('y', v, c, 'Transform'), v => v.toFixed(1)),
      sliderRow(t('scale'), clip.scale ?? 100, 2, 500, 0.1, (v, c) => patch('scale', v, c, 'Transform'), v => v.toFixed(1)),
      sliderRow(t('rotation'), clip.rotation ?? 0, -180, 180, 1, (v, c) => patch('rotation', v, c, 'Transform')),
      sliderRow(t('opacity'), clip.opacity ?? 100, 0, 100, 1, (v, c) => patch('opacity', v, c, 'Transform')),
      el('div', { class: 'row', style: { marginTop: '6px' } },
        flipBtn('fa-left-right', clip.flipH, v => patch('flipH', v)),
        flipBtn('fa-up-down', clip.flipV, v => patch('flipV', v))),
    ));
  }

  /* ---- chroma key (vtuber) ---- */
  if (isVtuber) {
    const ck = p.vtuber.chroma || (p.vtuber.chroma = { ...CHROMA_DEFAULTS });
    const patchCk = (key, val, commit = true) => {
      if (commit) { pushHistory('Chroma'); }
      ck[key] = val; markDirty(); renderFrame();
    };
    const enableChk = el('input', { type: 'checkbox' });
    enableChk.checked = ck.enabled;
    enableChk.onchange = () => patchCk('enabled', enableChk.checked);
    const colorInp = el('input', { type: 'color', value: ck.keyColor || '#00ff00' });
    colorInp.onchange = () => patchCk('keyColor', colorInp.value);
    host.append(group(t('chromaKey'), 'fa-wand-magic-sparkles',
      el('div', { class: 'prop-row' }, el('label', {}, t('enabled')), el('span', {}), enableChk),
      el('div', { class: 'prop-row' }, el('label', {}, t('keyColor')), el('span', {}), colorInp),
      sliderRow(t('tolerance'), ck.tolerance, 0, 1, 0.01, (v, c) => patchCk('tolerance', v, c), v => v.toFixed(2)),
      sliderRow(t('softness'), ck.softness, 0, 1, 0.01, (v, c) => patchCk('softness', v, c), v => v.toFixed(2)),
      sliderRow(t('spill'), ck.spill, 0, 1, 0.01, (v, c) => patchCk('spill', v, c), v => v.toFixed(2)),
      sliderRow(t('feather'), ck.feather, 0, 1, 0.01, (v, c) => patchCk('feather', v, c), v => v.toFixed(2)),
      sliderRow(t('blur'), ck.blur, 0, 1, 0.01, (v, c) => patchCk('blur', v, c), v => v.toFixed(2)),
    ));
  }

  /* ---- transitions + animation (visual, non-caption) ---- */
  if (!isAudio && !isCaption) {
    const sel = (value, list, onCh) => {
      const s = el('select', { class: 'input', style: { fontSize: '11px', padding: '4px 6px' } },
        ...list.map(x => el('option', { value: x, selected: value === x }, x)));
      s.onchange = () => onCh(s.value);
      return s;
    };
    host.append(group(t('transitionIn'), 'fa-arrow-right-to-bracket',
      el('div', { class: 'prop-row' }, el('label', {}, t('transitionIn')), sel(clip.transitionIn, TRANSITIONS, v => patch('transitionIn', v, true, 'Transition')), el('span')),
      el('div', { class: 'prop-row' }, el('label', {}, t('transitionOut')), sel(clip.transitionOut, TRANSITIONS, v => patch('transitionOut', v, true, 'Transition')), el('span')),
      el('div', { class: 'prop-row' }, el('label', {}, t('animation')), sel(clip.animation || 'none', ANIMATIONS, v => patch('animation', v, true, 'Animation')), el('span')),
    ));
  }

  /* ---- audio ---- */
  if (isAudio || isVtuber) {
    const muteChk = el('input', { type: 'checkbox' });
    muteChk.checked = !!clip.muted;
    muteChk.onchange = () => patch('muted', muteChk.checked, true, 'Audio');
    host.append(group(t('volume'), 'fa-volume-high',
      sliderRow(t('volume') + ' dB', clip.volume ?? 0, -48, 12, 0.5, (v, c) => patch('volume', v, c, 'Audio'), v => v.toFixed(1)),
      ...(clip.trackId === 'music' ? [sliderRow(t('treble') + ' dB', clip.treble ?? -24, -40, 12, 1, (v, c) => patch('treble', v, c, 'Audio'))] : []),
      sliderRow(t('fadeInL'), clip.fadeIn ?? 0, 0, 5, 0.1, (v, c) => patch('fadeIn', v, c, 'Audio'), v => v.toFixed(1)),
      sliderRow(t('fadeOutL'), clip.fadeOut ?? 0, 0, 5, 0.1, (v, c) => patch('fadeOut', v, c, 'Audio'), v => v.toFixed(1)),
      el('div', { class: 'prop-row' }, el('label', {}, t('muteL')), el('span', {}), muteChk),
    ));
  }

  /* ---- caption editor ---- */
  if (isCaption) {
    const st = p.captionStyle;
    const patchStyle = (key, val, commit = true) => {
      if (commit) pushHistory('Caption style');
      st[key] = val; markDirty(); emit('timeline'); renderFrame();
    };
    const textArea = el('textarea', { class: 'input', rows: 2 }, clip.text || '');
    textArea.onchange = () => {
      pushHistory('Caption text');
      const words = textArea.value.trim().split(/\s+/);
      const span = clip.duration / Math.max(words.length, 1);
      clip.text = textArea.value.trim();
      clip.name = clip.text.slice(0, 22);
      clip.words = words.map((w, i) => ({ w, s: clip.start + i * span, e: clip.start + (i + 1) * span }));
      markDirty(); emit('timeline'); renderFrame();
    };

    const tmplSel = el('select', { class: 'input' },
      ...CAPTION_TEMPLATES.map(tp => el('option', { value: tp.id, selected: st.templateId === tp.id }, tp.name)));
    tmplSel.onchange = () => {
      const tp = CAPTION_TEMPLATES.find(x => x.id === tmplSel.value);
      pushHistory('Caption template');
      Object.assign(st, { templateId: tp.id, activeColor: tp.activeColor, inactiveColor: tp.inactiveColor, font: tp.font, fontSize: tp.fontSize, outlineWidth: tp.outlineWidth });
      markDirty(); emit('timeline'); renderFrame();
      renderPropertiesPanel(host, { renderFrame });
    };

    const fontSel = el('select', { class: 'input' }, el('option', { value: st.font }, st.font));
    detectSystemFonts().then(fonts => {
      fontSel.innerHTML = '';
      fontSel.append(...fonts.map(f => el('option', { value: f, selected: st.font === f }, f)));
    });
    fontSel.onchange = () => patchStyle('font', fontSel.value);

    const colorRow = (label, key) => {
      const c = el('input', { type: 'color', value: st[key] });
      c.onchange = () => patchStyle(key, c.value);
      return el('div', { class: 'prop-row' }, el('label', {}, label), el('span', {}), c);
    };

    host.append(group(t('captions'), 'fa-closed-captioning',
      el('p', { style: { fontSize: '10.5px', color: 'var(--cyan)', marginBottom: '10px' } },
        el('i', { class: 'fa-solid fa-circle-info' }), ' ', t('applyAllCaptions')),
      el('div', { class: 'field' }, el('label', {}, t('text')), textArea),
      el('div', { class: 'field' }, el('label', {}, t('template')), tmplSel),
      el('div', { class: 'field' }, el('label', {}, t('font')), fontSel),
      sliderRow(t('fontSize'), st.fontSize, 20, 140, 1, (v, c) => patchStyle('fontSize', v, c)),
      colorRow(t('activeColor'), 'activeColor'),
      colorRow(t('inactiveColor'), 'inactiveColor'),
      colorRow(t('outline'), 'outlineColor'),
      sliderRow(t('outline'), st.outlineWidth, 0, 20, 1, (v, c) => patchStyle('outlineWidth', v, c)),
    ));
  }
}

function flipBtn(icon, active, onCh) {
  const b = el('button', { class: 'btn btn-sm', style: active ? { color: 'var(--accent-2)', borderColor: 'var(--accent)' } : {} },
    el('i', { class: `fa-solid ${icon}` }));
  b.onclick = () => onCh(!active) || true;
  b.addEventListener('click', () => {
    b.style.color = !active ? 'var(--accent-2)' : '';
    active = !active;
  });
  return b;
}
