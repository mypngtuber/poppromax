/**
 * historyPanel.js — undo/redo history list.
 */
import { el } from '../../utils.js';
import { t } from '../../i18n.js';
import { historyInfo, undo, redo } from '../../store.js';

export function renderHistoryPanel(host) {
  host.innerHTML = '';
  const { undo: undoList, redo: redoList } = historyInfo();

  host.append(el('div', { class: 'row', style: { marginBottom: '12px' } },
    el('button', { class: 'btn btn-sm grow', onclick: undo, disabled: !undoList.length },
      el('i', { class: 'fa-solid fa-rotate-left' }), ' ', t('undo')),
    el('button', { class: 'btn btn-sm grow', onclick: redo, disabled: !redoList.length },
      el('i', { class: 'fa-solid fa-rotate-right' }), ' ', t('redo'))));

  if (!undoList.length && !redoList.length) {
    host.append(el('div', { class: 'empty-state' }, el('i', { class: 'fa-solid fa-clock-rotate-left' }), t('noHistory')));
    return;
  }
  const list = el('div', {});
  undoList.forEach((label) => {
    list.append(el('div', { class: 'history-item' }, el('i', { class: 'fa-solid fa-circle', style: { fontSize: '5px', color: 'var(--text-2)' } }), label));
  });
  list.append(el('div', { class: 'history-item current' }, el('i', { class: 'fa-solid fa-caret-right' }), t('current')));
  [...redoList].reverse().forEach((label) => {
    list.append(el('div', { class: 'history-item', style: { opacity: '.45' } }, el('i', { class: 'fa-solid fa-circle', style: { fontSize: '5px' } }), label));
  });
  host.append(list);
}
