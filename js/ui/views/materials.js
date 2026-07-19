/**
 * materials.js — Materials view: background / music / SFX / meme / b-roll libraries.
 * Upload once, reuse forever. Search, favorites, categories, delete.
 */
import { el, fmtSize, fmtDur, debounce } from '../../utils.js';
import { t } from '../../i18n.js';
import { ACCEPTED, BG_CATEGORIES } from '../../config.js';
import { listAssets, importFile, removeAsset, toggleFavorite, assetUrl } from '../../services/assets.js';
import { extractAudioAsset } from '../../services/mediaExtract.js';
import { toast, confirmDialog, dropZone } from '../components.js';

const TABS = [
  { id: 'background', label: 'backgrounds', icon: 'fa-image', accept: ACCEPTED.image + ',' + ACCEPTED.video },
  { id: 'music', label: 'music', icon: 'fa-music', accept: ACCEPTED.audio + ',' + ACCEPTED.video, audioExtract: true },
  { id: 'sfx', label: 'sfx', icon: 'fa-volume-high', accept: ACCEPTED.audio + ',' + ACCEPTED.video, audioExtract: true },
  { id: 'meme', label: 'memes', icon: 'fa-face-laugh-squint', accept: ACCEPTED.image + ',' + ACCEPTED.video },
  { id: 'broll', label: 'images', icon: 'fa-photo-film', accept: ACCEPTED.any },
  { id: 'vtuber', label: 'videos', icon: 'fa-user-astronaut', accept: ACCEPTED.video },
];

let activeTab = 'background';
let searchQ = '';

export async function renderMaterials(host) {
  const page = el('section', { class: 'page' });
  const tabsBar = el('div', { class: 'tabs' });
  const content = el('div', {});

  const rebuildContent = async () => {
    content.innerHTML = '';
    const tab = TABS.find(tb => tb.id === activeTab);

    const searchInput = el('input', { class: 'input', placeholder: t('search') + '…', value: searchQ, style: { maxWidth: '260px' } });
    searchInput.oninput = debounce(() => { searchQ = searchInput.value; rebuildGrid(); }, 250);

    const zone = dropZone({
      accept: tab.accept,
      onFiles: async (files) => {
        for (const f of files) {
          try {
            // SFX/Music tab: dropping a VIDEO auto-extracts its audio track
            if (tab.audioExtract && f.type.startsWith('video/')) {
              toast(t('extracting'), 'info');
              await extractAudioAsset(f, tab.id, f.name.replace(/\.[^.]+$/, ''));
              toast(t('audioExtracted'), 'success');
            } else {
              await importFile(f, tab.id);
              toast(`${f.name} ✓`, 'success');
            }
          } catch (e) { toast(e.message, 'error'); }
        }
        rebuildGrid();
      },
    });

    const grid = el('div', { class: 'grid grid-4', style: { marginTop: '16px' } });

    const rebuildGrid = async () => {
      grid.innerHTML = '';
      const assets = await listAssets({ category: activeTab, search: searchQ });
      if (!assets.length) {
        grid.append(el('div', { class: 'empty-state', style: { gridColumn: '1 / -1' } },
          el('i', { class: `fa-solid ${tab.icon}` }), t('uploadFiles')));
      }
      for (const a of assets) {
        const thumb = el('div', { class: 'asset-thumb' });
        if (a.kind === 'image' || a.kind === 'gif') {
          assetUrl(a.id).then(u => u && thumb.append(el('img', { src: u, alt: a.name })));
        } else if (a.kind === 'video') {
          assetUrl(a.id).then(u => u && thumb.append(el('video', { src: u, muted: true, playsinline: true })));
        } else {
          thumb.append(el('i', { class: 'fa-solid fa-music' }));
          if (a.kind === 'audio') {
            thumb.style.cursor = 'pointer';
            thumb.onclick = async () => {
              const u = await assetUrl(a.id);
              const audio = new Audio(u); audio.volume = 0.6; audio.play();
              setTimeout(() => audio.pause(), 6000);
            };
          }
        }
        const favBtn = el('button', { class: 'btn btn-sm', title: t('favorites') },
          el('i', { class: a.favorite ? 'fa-solid fa-star' : 'fa-regular fa-star', style: a.favorite ? { color: 'var(--yellow)' } : {} }));
        favBtn.onclick = async (e) => { e.stopPropagation(); await toggleFavorite(a.id); rebuildGrid(); };
        const delBtn = el('button', { class: 'btn btn-sm btn-danger' }, el('i', { class: 'fa-solid fa-trash' }));
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          if (await confirmDialog(t('deleteConfirm'))) { await removeAsset(a.id); rebuildGrid(); }
        };
        grid.append(el('div', { class: 'asset-card' },
          thumb,
          el('span', { class: 'asset-tag' }, a.kind),
          el('div', { class: 'asset-actions' }, favBtn, delBtn),
          el('div', { class: 'asset-name', title: a.fileName },
            a.name, ' ',
            el('span', { style: { color: 'var(--text-2)', fontWeight: '400' } },
              a.duration ? `· ${fmtDur(a.duration)}` : `· ${fmtSize(a.size)}`))));
      }
    };

    content.append(el('div', { class: 'row', style: { marginBottom: '14px' } }, searchInput), zone, grid);
    await rebuildGrid();
  };

  for (const tab of TABS) {
    const b = el('button', { class: `tab ${tab.id === activeTab ? 'active' : ''}` },
      el('i', { class: `fa-solid ${tab.icon}`, style: { marginInlineEnd: '6px' } }), t(tab.label));
    b.onclick = () => {
      activeTab = tab.id; searchQ = '';
      [...tabsBar.children].forEach(c => c.classList.remove('active'));
      b.classList.add('active');
      rebuildContent();
    };
    tabsBar.append(b);
  }

  page.append(
    el('h1', { class: 'page-title' }, t('materials')),
    el('p', { class: 'page-sub' }, t('library')),
    tabsBar, content);
  host.append(page);
  await rebuildContent();
}
