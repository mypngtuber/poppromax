/**
 * dashboard.js — Dashboard view: recent projects, create/continue/import.
 */
import { el, fmtDate, fmtDur } from '../../utils.js';
import { t } from '../../i18n.js';
import { db } from '../../services/db.js';
import { newProject, openProject, navigate } from '../../store.js';
import { toast, promptDialog, pickFiles } from '../components.js';
import { importVtProject } from '../../engine/exporter.js';

export async function renderDashboard(host) {
  const projects = (await db.listProjects()).filter(p => !p.archived).slice(0, 8);
  const lastId = await db.kvGet('lastProjectId');

  const createBtn = el('button', { class: 'btn btn-primary', style: { padding: '10px 20px' } },
    el('i', { class: 'fa-solid fa-plus' }), t('newProject'));
  createBtn.onclick = async () => {
    const name = await promptDialog(t('projectName'), 'Short ' + new Date().toLocaleDateString());
    if (!name) return;
    await newProject(name);
    navigate('editor');
  };

  const importBtn = el('button', { class: 'btn', style: { padding: '10px 20px' } },
    el('i', { class: 'fa-solid fa-file-import' }), t('importProject'));
  importBtn.onclick = async () => {
    const files = await pickFiles('.vtproject,.json', false);
    if (!files.length) return;
    try {
      const p = await importVtProject(files[0]);
      toast(t('saved'), 'success');
      await openProject(p.id);
      navigate('editor');
    } catch (e) { toast(e.message, 'error'); }
  };

  const continueBtn = el('button', { class: 'btn', style: { padding: '10px 20px' }, disabled: !lastId },
    el('i', { class: 'fa-solid fa-play' }), t('continueProject'));
  if (lastId) continueBtn.onclick = async () => {
    try { await openProject(lastId); navigate('editor'); }
    catch { toast('Project not found', 'error'); }
  };

  const grid = el('div', { class: 'grid grid-4' });
  if (!projects.length) {
    grid.append(el('div', { class: 'empty-state', style: { gridColumn: '1 / -1' } },
      el('i', { class: 'fa-solid fa-clapperboard' }), t('noProjects')));
  }
  for (const p of projects) {
    const card = el('div', { class: 'project-card' },
      el('div', { class: 'project-thumb' },
        el('i', { class: 'fa-solid fa-mobile-screen' }),
        el('span', { class: 'ratio-badge' }, '9:16')),
      el('div', { class: 'project-info' },
        el('div', { class: 'project-name' }, p.name),
        el('div', { class: 'project-meta' },
          el('span', {}, fmtDate(p.updatedAt)),
          el('span', {}, fmtDur(p.duration || 0)))));
    card.onclick = async () => { await openProject(p.id); navigate('editor'); };
    grid.append(card);
  }

  host.append(el('section', { class: 'page' },
    el('h1', { class: 'page-title' }, t('dashboard')),
    el('p', { class: 'page-sub' }, 'AI VTuber Shorts Editor — 1080×1920 • 30fps • 9:16'),
    el('div', { class: 'row', style: { marginBottom: '26px', gap: '12px' } }, createBtn, continueBtn, importBtn),
    el('h2', { class: 'card-title', style: { fontSize: '15px' } }, el('i', { class: 'fa-solid fa-clock-rotate-left' }), t('recentProjects')),
    grid,
  ));
}
