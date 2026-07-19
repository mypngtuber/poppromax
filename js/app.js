/**
 * app.js — application entry: shell, navigation, routing, autosave, recovery.
 */
import { el } from './utils.js';
import { t, getLang, setLang, initLang } from './i18n.js';
import { state, on, navigate, startAutosave, openProject, saveProject } from './store.js';
import { db } from './services/db.js';
import { restoreCustomFonts } from './services/fonts.js';
import { toast } from './ui/components.js';
import { renderDashboard } from './ui/views/dashboard.js';
import { renderProjects } from './ui/views/projects.js';
import { renderEditor, disposeEditor } from './ui/views/editor.js';
import { renderMaterials } from './ui/views/materials.js';
import { renderExport } from './ui/views/export.js';
import { renderSettings } from './ui/views/settings.js';

const ROUTES = {
  dashboard: { icon: 'fa-house', render: renderDashboard },
  projects: { icon: 'fa-folder-open', render: renderProjects },
  editor: { icon: 'fa-clapperboard', render: renderEditor },
  materials: { icon: 'fa-photo-film', render: renderMaterials },
  export: { icon: 'fa-file-export', render: renderExport },
  settings: { icon: 'fa-gear', render: renderSettings },
};

function buildShell() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  // ---------- sidebar ----------
  const nav = el('nav', { class: 'nav', id: 'main-nav' });
  for (const [route, cfg] of Object.entries(ROUTES)) {
    const item = el('button', { class: 'nav-item', 'data-route': route },
      el('i', { class: `fa-solid ${cfg.icon}` }), el('span', {}, t(route)));
    item.onclick = () => navigate(route);
    nav.append(item);
  }

  const langBtn = el('button', { class: 'btn btn-sm btn-block' },
    el('i', { class: 'fa-solid fa-globe' }), getLang() === 'ar' ? 'English' : 'العربية');
  langBtn.onclick = () => setLang(getLang() === 'ar' ? 'en' : 'ar');

  const projectBadge = el('div', { id: 'active-project-badge', style: { fontSize: '10.5px', color: 'var(--text-2)', padding: '4px 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } });

  const sidebar = el('aside', { id: 'sidebar' },
    el('div', { class: 'brand' },
      el('div', { class: 'brand-logo' }, el('i', { class: 'fa-solid fa-wand-magic-sparkles' })),
      el('div', {},
        el('div', { class: 'brand-name' }, 'VTuber Shorts'),
        el('div', { class: 'brand-sub' }, 'AI Editor · 9:16'))),
    nav,
    el('div', { class: 'sidebar-foot' }, projectBadge, langBtn));

  // ---------- main ----------
  const topbar = el('header', { id: 'topbar' },
    el('span', { id: 'topbar-title', style: { fontWeight: 700, fontSize: '13.5px' } }),
    el('span', { class: 'grow' }),
    el('span', { id: 'save-indicator', style: { fontSize: '11px', color: 'var(--text-2)' } }));
  const view = el('div', { id: 'view' });
  const main = el('main', { id: 'main' }, topbar, view);

  app.append(sidebar, main);
  return { view, topbar };
}

let shell;
async function renderRoute() {
  disposeEditor();
  shell.view.classList.remove('no-scroll');
  shell.view.innerHTML = '';
  document.querySelectorAll('.nav-item').forEach(n =>
    n.classList.toggle('active', n.dataset.route === state.route));
  document.getElementById('topbar-title').textContent =
    state.route === 'editor' && state.project ? state.project.name : t(state.route);
  const badge = document.getElementById('active-project-badge');
  badge.textContent = state.project ? `📁 ${state.project.name}` : '';
  await ROUTES[state.route].render(shell.view);
}

async function boot() {
  initLang();
  shell = buildShell();

  on('route', renderRoute);
  window.addEventListener('langchange', () => { shell = buildShell(); renderRoute(); });
  on('saved', () => flashSave(t('saved')));
  on('autosaved', () => flashSave(t('autosaved')));
  on('project', () => {
    const badge = document.getElementById('active-project-badge');
    if (badge) badge.textContent = state.project ? `📁 ${state.project.name}` : '';
  });

  restoreCustomFonts();
  startAutosave();

  // crash recovery: compare autosave snapshot vs stored project
  try {
    const lastId = await db.kvGet('lastProjectId');
    if (lastId) {
      const auto = await db.kvGet('autosave_' + lastId);
      const stored = await db.getProject(lastId);
      if (auto && stored && auto.time > stored.updatedAt + 3000) {
        const recovered = JSON.parse(auto.data);
        recovered.updatedAt = auto.time;
        await db.saveProject(recovered);
        toast(t('recovered'), 'success');
      }
    }
  } catch { /* non-fatal */ }

  await renderRoute();
}

function flashSave(msg) {
  const ind = document.getElementById('save-indicator');
  if (!ind) return;
  ind.textContent = '✓ ' + msg;
  ind.style.color = 'var(--green)';
  setTimeout(() => { ind.textContent = ''; }, 2500);
}

boot();
