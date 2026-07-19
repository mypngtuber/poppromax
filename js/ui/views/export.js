/**
 * export.js — Export view: video render (WebM), Premiere FCPXML, .vtproject.
 */
import { el, downloadBlob, fmtDur } from '../../utils.js';
import { t } from '../../i18n.js';
import { VIDEO } from '../../config.js';
import { state, saveProject, navigate } from '../../store.js';
import { exportVideo, exportFcpXml, exportVtProject } from '../../engine/exporter.js';
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

  const progWrap = el('div', { class: 'progress-bar', style: { marginTop: '14px', display: 'none' } }, el('div', { style: { width: '0%' } }));
  const progLabel = el('p', { style: { fontSize: '11.5px', color: 'var(--text-2)', marginTop: '8px' } });

  const mp4Btn = el('button', { class: 'btn btn-primary', style: { padding: '11px 22px' } },
    el('i', { class: 'fa-solid fa-film' }), t('exportMp4'));
  const cancelBtn = el('button', { class: 'btn btn-danger', style: { display: 'none' } }, t('cancel'));

  mp4Btn.onclick = async () => {
    if (exporting) return;
    exporting = true;
    abortCtrl = new AbortController();
    mp4Btn.disabled = true;
    cancelBtn.style.display = '';
    progWrap.style.display = '';
    await saveProject(true); // save before export
    try {
      const blob = await exportVideo(p, (r) => {
        progWrap.firstChild.style.width = (r * 100).toFixed(1) + '%';
        progLabel.textContent = `${t('exporting')} ${(r * 100).toFixed(0)}%`;
      }, abortCtrl.signal);
      downloadBlob(blob, p.name.replace(/\s+/g, '_') + '.webm');
      toast(t('exportDone'), 'success');
    } catch (e) {
      if (e.name !== 'AbortError') toast(e.message, 'error');
    } finally {
      exporting = false;
      mp4Btn.disabled = false;
      cancelBtn.style.display = 'none';
      progWrap.style.display = 'none';
      progLabel.textContent = '';
    }
  };
  cancelBtn.onclick = () => abortCtrl?.abort();

  const xmlBtn = el('button', { class: 'btn', style: { padding: '11px 22px' } },
    el('i', { class: 'fa-brands fa-adobe' }), t('exportXml'));
  xmlBtn.onclick = async () => {
    await saveProject(true);
    const blob = await exportFcpXml(p);
    downloadBlob(blob, p.name.replace(/\s+/g, '_') + '.fcpxml');
    toast(t('exportDone'), 'success');
  };

  const projBtn = el('button', { class: 'btn', style: { padding: '11px 22px' } },
    el('i', { class: 'fa-solid fa-box-archive' }), t('exportProject'));
  projBtn.onclick = async () => {
    await saveProject(true);
    toast(t('exporting'), 'info');
    const blob = await exportVtProject(p);
    downloadBlob(blob, p.name.replace(/\s+/g, '_') + '.vtproject');
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
        progWrap, progLabel),
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, el('i', { class: 'fa-brands fa-adobe' }), 'Adobe Premiere / Final Cut'),
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
