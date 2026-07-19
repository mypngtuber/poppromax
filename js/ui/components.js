/**
 * components.js — reusable UI primitives: toast, modal, confirm, file picker, drop zone.
 */
import { el } from '../utils.js';
import { t } from '../i18n.js';

export function toast(msg, type = 'info', icon = null) {
  let host = document.getElementById('toasts');
  if (!host) { host = el('div', { id: 'toasts' }); document.body.append(host); }
  const icons = { info: 'fa-circle-info', success: 'fa-circle-check', error: 'fa-circle-xmark', warn: 'fa-triangle-exclamation' };
  const node = el('div', { class: `toast ${type}` },
    el('i', { class: `fa-solid ${icon || icons[type]}` }), el('span', {}, msg));
  host.append(node);
  setTimeout(() => { node.style.opacity = '0'; node.style.transition = 'opacity .3s'; setTimeout(() => node.remove(), 320); }, 3200);
}

export function modal({ title, body, footer, onClose, wide }) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const box = el('div', { class: 'modal', style: wide ? { maxWidth: '860px', minWidth: '640px' } : {} });
  const close = () => { backdrop.remove(); onClose?.(); };
  box.append(
    el('div', { class: 'modal-head' }, el('span', {}, title),
      el('button', { class: 'btn btn-ghost btn-icon', onclick: close }, el('i', { class: 'fa-solid fa-xmark' }))),
    el('div', { class: 'modal-body' }, body),
  );
  if (footer) box.append(el('div', { class: 'modal-foot' }, footer));
  backdrop.append(box);
  backdrop.addEventListener('pointerdown', e => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  return { close, box };
}

export function confirmDialog(message) {
  return new Promise(resolve => {
    const okBtn = el('button', { class: 'btn btn-danger' }, t('delete'));
    const cancelBtn = el('button', { class: 'btn' }, t('cancel'));
    const m = modal({ title: '⚠️', body: el('p', { style: { fontSize: '13px' } }, message), footer: [cancelBtn, okBtn], onClose: () => resolve(false) });
    okBtn.onclick = () => { resolve(true); m.close(); };
    cancelBtn.onclick = () => { resolve(false); m.close(); };
  });
}

export function promptDialog(title, defaultVal = '') {
  return new Promise(resolve => {
    const input = el('input', { class: 'input', value: defaultVal });
    const okBtn = el('button', { class: 'btn btn-primary' }, t('save'));
    const m = modal({
      title,
      body: input,
      footer: [el('button', { class: 'btn', onclick: () => { resolve(null); m.close(); } }, t('cancel')), okBtn],
      onClose: () => resolve(null),
    });
    const submit = () => { const v = input.value.trim(); if (v) { resolve(v); m.close(); } };
    okBtn.onclick = submit;
    input.addEventListener('keydown', e => e.key === 'Enter' && submit());
    setTimeout(() => input.focus(), 50);
  });
}

export function pickFiles(accept, multiple = true) {
  return new Promise(resolve => {
    const inp = el('input', { type: 'file', accept, style: { display: 'none' } });
    if (multiple) inp.multiple = true;
    inp.onchange = () => resolve([...inp.files]);
    document.body.append(inp);
    inp.click();
    setTimeout(() => inp.remove(), 60_000);
  });
}

export function dropZone({ accept, label, onFiles }) {
  const zone = el('div', { class: 'drop-zone' },
    el('i', { class: 'fa-solid fa-cloud-arrow-up', style: { fontSize: '22px', display: 'block', marginBottom: '8px' } }),
    el('div', {}, label || t('uploadFiles')));
  zone.onclick = async () => { const files = await pickFiles(accept); if (files.length) onFiles(files); };
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = e => {
    e.preventDefault(); zone.classList.remove('over');
    const files = [...e.dataTransfer.files];
    if (files.length) onFiles(files);
  };
  return zone;
}

export function stars(n) {
  const s = el('span', { class: 'stars' });
  for (let i = 1; i <= 5; i++) s.append(el('span', { class: i <= n ? '' : 'off' }, '★'));
  return s;
}

export function sliderRow(label, value, min, max, step, onChange, fmt = v => v) {
  const num = el('input', { class: 'prop-num', value: fmt(value) });
  const range = el('input', { type: 'range', min, max, step, value });
  range.oninput = () => { num.value = fmt(+range.value); onChange(+range.value, false); };
  range.onchange = () => onChange(+range.value, true);
  num.onchange = () => {
    const v = Math.min(max, Math.max(min, parseFloat(num.value) || 0));
    range.value = v; num.value = fmt(v); onChange(v, true);
  };
  return el('div', { class: 'prop-row' }, el('label', {}, label), range, num);
}
