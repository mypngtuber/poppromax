/**
 * export.js — Export view: MP4 (H.264), Premiere package (ZIP with media),
 * FCPXML only, .vtproject.
 */
import { el, downloadBlob, fmtDur } from '../../utils.js';
import { t } from '../../i18n.js';
import { VIDEO } from '../../config.js';
import { state, saveProject, navigate } from '../../store.js';
import { exportVideo, exportFcpXml, exportPremierePackage, exportVtProject } from '../../engine/exporter.js';
import { toast } from '../components.js';

let exporting = false;
let abortCtrl = null;

export function renderExport(host) {
  const p = state.project;
  if (!p) {
    host.append(el('div', { class: 'empty-state', style: { paddingTop: '120px' } },
      el('i', { class: 'fa-solid fa-file-export' }),
      el('p', {}, t('noProjects')),
      el('button', { class: 'btn btn-primary', style: { marginTop: '14px' }, onclick: () => navigate('dashboard') }, t('dashboard'))));
    return;
  }

  const safeName = p.name.replace(/\s+/g, '_');

  /* ---------- shared progress helpers ---------- */
  const makeProgress = () => {
    const bar = el('div', { class: 'progress-bar', style: { marginTop: '14px', display: 'none' } }, el('div', { style: { width: '0%' } }));
    const label = el('p', { style: { fontSize: '11.5px', color: 'var(--text-2)', marginTop: '8px' } });
    const set = (r, phase) => {
      bar.style.display = '';
      bar.firstChild.style.width = (r * 100).toFixed(1) + '%';
      const phaseTxt = phase === 'audio' ? t('phaseAudio')
        : phase === 'video' ? t('phaseVideo')
        : phase === 'media' ? t('phaseMedia')
        : phase === 'zip' ? t('phaseZip')
        : phase === 'finalize' ? t('phaseFinalize') : '';
      label.textContent = `${t('exporting')} ${(r * 100).toFixed(0)}% ${phaseTxt ? '— ' + phaseTxt : ''}`;
    };
    const reset = () => { bar.style.display = 'none'; bar.firstChild.style.width = '0%'; label.textContent = ''; };
    return { bar, label, set, reset };
  };

  /* ---------- 1) MP4 H.264 export ---------- */
  const vidProg = makeProgress();
  const mp4Btn = el('button', { class: 'btn btn-primary', style: { padding: '11px 22px' } },
    el('i', { class: 'fa-solid fa-film' }), t('exportMp4'));
  const cancelBtn = el('button', { class: 'btn btn-danger', style: { display: 'none' } }, t('cancel'));

  mp4Btn.onclick = async () => {
    if (exporting) return;
    exporting = true;
    abortCtrl = new AbortController();
    mp4Btn.disabled = true;
    cancelBtn.style.display = '';
    await saveProject(true);
    try {
      const { blob, ext } = await exportVideo(p, vidProg.set, abortCtrl.signal);
      downloadBlob(blob, `${safeName}.${ext}`);
      toast(ext === 'mp4' ? t('exportDone') + ' — MP4 H.264 ✓' : t('exportDoneWebm'), ext === 'mp4' ? 'success' : 'warn');
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message, 'error');
    } finally {
      exporting = false;
      mp4Btn.disabled = false;
      cancelBtn.style.display = 'none';
      vidProg.reset();
    }
  };
  cancelBtn.onclick = () => abortCtrl?.abort();

  /* ---------- 2) Premiere package (ZIP: XML + Media/) ---------- */
  const pkgProg = makeProgress();
  const pkgBtn = el('button', { class: 'btn btn-primary', style: { padding: '11px 22px' } },
    el('i', { class: 'fa-solid fa-box-open' }), t('exportPremierePkg'));
  pkgBtn.onclick = async () => {
    if (exporting) return;
    exporting = true;
    pkgBtn.disabled = true;
    await saveProject(true);
    try {
      const blob = await exportPremierePackage(p, pkgProg.set);
      downloadBlob(blob, `${safeName}_PremierePackage.zip`);
      toast(t('exportDone'), 'success');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      exporting = false;
      pkgBtn.disabled = false;
      pkgProg.reset();
    }
  };

  /* ---------- 3) FCPXML only ---------- */
  const xmlBtn = el('button', { class: 'btn', style: { padding: '11px 22px' } },
    el('i', { class: 'fa-brands fa-adobe' }), t('exportXml'));
  xmlBtn.onclick = async () => {
    await saveProject(true);
    const blob = await exportFcpXml(p);
    downloadBlob(blob, `${safeName}.fcpxml`);
    toast(t('exportDone'), 'success');
  };

  /* ---------- 4) .vtproject ---------- */
  const projBtn = el('button', { class: 'btn', style: { padding: '11px 22px' } },
    el('i', { class: 'fa-solid fa-box-archive' }), t('exportProject'));
  projBtn.onclick = async () => {
    await saveProject(true);
    toast(t('exporting'), 'info');
    const blob = await exportVtProject(p);
    downloadBlob(blob, `${safeName}.vtproject`);
    toast(t('exportDone'), 'success');
  };

  host.append(el('section', { class: 'page', style: { maxWidth: '720px' } },
    el('h1', { class: 'page-title' }, t('export')),
    el('p', { class: 'page-sub' }, `${p.name} · ${fmtDur(p.duration)} · ${VIDEO.width}×${VIDEO.height} · ${VIDEO.fps}fps · 9:16`),
    el('div', { class: 'grid', style: { gap: '16px' } },
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, el('i', { class: 'fa-solid fa-film' }), t('exportMp4')),
        el('p', { style: { fontSize: '11.5px', color: 'var(--text-2)', marginBottom: '14px', lineHeight: '1.6' } }, t('exportNote')),
        el('div', { class: 'row' }, mp4Btn, cancelBtn),
        vidProg.bar, vidProg.label),
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, el('i', { class: 'fa-solid fa-box-open' }), t('exportPremierePkg')),
        el('p', { style: { fontSize: '11.5px', color: 'var(--text-2)', marginBottom: '14px', lineHeight: '1.6' } }, t('premierePkgNote')),
        pkgBtn,
        pkgProg.bar, pkgProg.label),
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, el('i', { class: 'fa-brands fa-adobe' }), 'FCPXML'),
        el('p', { style: { fontSize: '11.5px', color: 'var(--text-2)', marginBottom: '14px' } },
          'FCPXML 1.10 — timing, tracks, transforms, captions, audio placement.'),
        xmlBtn),
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, el('i', { class: 'fa-solid fa-box-archive' }), '.vtproject'),
        el('p', { style: { fontSize: '11.5px', color: 'var(--text-2)', marginBottom: '14px' } },
          'Timeline + Assets + AI Analysis + Captions + Settings — full restore.'),
        projBtn),
    ),
  ));
}
