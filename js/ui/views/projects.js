/**
 * projects.js — full projects manager: open/rename/duplicate/archive/delete/export.
 */
import { el, fmtDate, fmtDur, uid, downloadBlob } from '../../utils.js';
import { t } from '../../i18n.js';
import { db } from '../../services/db.js';
import { openProject, navigate } from '../../store.js';
import { toast, confirmDialog, promptDialog } from '../components.js';
import { exportVtProject } from '../../engine/exporter.js';

export async function renderProjects(host) {
  const projects = await db.listProjects();
  const grid = el('div', { class: 'grid grid-4' });

  const rebuild = () => { host.innerHTML = ''; renderProjects(host); };

  if (!projects.length) {
    grid.append(el('div', { class: 'empty-state', style: { gridColumn: '1 / -1' } },
      el('i', { class: 'fa-solid fa-folder-open' }), t('noProjects')));
  }

  for (const p of projects) {
    const menuBtn = (icon, title, fn, danger = false) =>
      el('button', { class: `btn btn-sm ${danger ? 'btn-danger' : ''}`, title, onclick: (e) => { e.stopPropagation(); fn(); } },
        el('i', { class: `fa-solid ${icon}` }));

    const actions = el('div', { class: 'row', style: { gap: '5px', marginTop: '8px', flexWrap: 'wrap' } },
      menuBtn('fa-pen', t('rename'), async () => {
        const name = await promptDialog(t('rename'), p.name);
        if (name) { p.name = name; p.updatedAt = Date.now(); await db.saveProject(p); rebuild(); }
      }),
      menuBtn('fa-copy', t('duplicate'), async () => {
        const copy = JSON.parse(JSON.stringify(p));
        copy.id = uid(); copy.name = p.name + ' (copy)'; copy.updatedAt = Date.now();
        await db.saveProject(copy); rebuild();
      }),
      menuBtn('fa-file-export', t('exportProject'), async () => {
        toast(t('exporting'), 'info');
        const blob = await exportVtProject(p);
        downloadBlob(blob, p.name.replace(/\s+/g, '_') + '.vtproject');
        toast(t('exportDone'), 'success');
      }),
      menuBtn('fa-box-archive', t('archive'), async () => {
        p.archived = !p.archived; await db.saveProject(p); rebuild();
      }),
      menuBtn('fa-trash', t('delete'), async () => {
        if (await confirmDialog(t('deleteConfirm'))) { await db.deleteProject(p.id); rebuild(); }
      }, true),
    );

    const card = el('div', { class: 'project-card', style: p.archived ? { opacity: '.55' } : {} },
      el('div', { class: 'project-thumb' },
        el('i', { class: 'fa-solid fa-mobile-screen' }),
        el('span', { class: 'ratio-badge' }, p.archived ? t('archived') : '9:16')),
      el('div', { class: 'project-info' },
        el('div', { class: 'project-name' }, p.name),
        el('div', { class: 'project-meta' },
          el('span', {}, fmtDate(p.updatedAt)), el('span', {}, fmtDur(p.duration || 0))),
        actions));
    card.onclick = async () => { await openProject(p.id); navigate('editor'); };
    grid.append(card);
  }

  host.append(el('section', { class: 'page' },
    el('h1', { class: 'page-title' }, t('projects')),
    el('p', { class: 'page-sub' }, `${projects.length} ${t('projects')}`),
    grid,
  ));
}
