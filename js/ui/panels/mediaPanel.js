/**
 * mediaPanel.js — in-editor media browser (left panel).
 * Upload VTuber video, pick background, add any library asset to the timeline.
 */
import { el, fmtDur } from '../../utils.js';
import { t } from '../../i18n.js';
import { ACCEPTED, VIDEO, VTUBER_DEFAULTS, CHROMA_DEFAULTS, MUSIC_DEFAULTS } from '../../config.js';
import { state, createClip, addClip, pushHistory, markDirty, emit, on, recalcDuration } from '../../store.js';
import { listAssets, importFile, assetUrl, markUsed, removeAsset } from '../../services/assets.js';
import { toast, pickFiles, confirmDialog } from '../components.js';

const CATS = [
  { id: 'vtuber', icon: 'fa-user-astronaut' },
  { id: 'background', icon: 'fa-image' },
  { id: 'broll', icon: 'fa-photo-film' },
  { id: 'meme', icon: 'fa-face-laugh-squint' },
  { id: 'music', icon: 'fa-music' },
  { id: 'sfx', icon: 'fa-volume-high' },
];

let activeCat = 'vtuber';

export function renderMediaPanel(host, { renderFrame }) {
  host.innerHTML = '';
  const tabBar = el('div', { class: 'panel-tabs' });
  const body = el('div', { class: 'panel-body' });

  const rebuild = async () => {
    body.innerHTML = '';
    const p = state.project;

    // quick setup actions for vtuber tab
    if (activeCat === 'vtuber') {
      const upBtn = el('button', { class: 'btn btn-primary btn-block', style: { marginBottom: '10px' } },
        el('i', { class: 'fa-solid fa-upload' }), t('uploadVtuber'));
      upBtn.onclick = async () => {
        const files = await pickFiles(ACCEPTED.video, false);
        if (!files.length) return;
        try {
          const a = await importFile(files[0], 'vtuber');
          assignVtuber(a);
          toast(`${a.name} ✓`, 'success');
          rebuild(); renderFrame();
        } catch (e) { toast(e.message, 'error'); }
      };
      body.append(upBtn);
    }
    if (activeCat !== 'vtuber') {
      const isAudioCat = activeCat === 'music' || activeCat === 'sfx';
      const upBtn = el('button', { class: 'btn btn-block', style: { marginBottom: '10px' } },
        el('i', { class: 'fa-solid fa-upload' }), t('upload'));
      upBtn.onclick = async () => {
        // audio categories also accept video files — audio track is extracted automatically
        const accept = isAudioCat ? ACCEPTED.audio + ',' + ACCEPTED.video : ACCEPTED.any;
        const files = await pickFiles(accept);
        for (const f of files) {
          try {
            if (isAudioCat && f.type.startsWith('video/')) {
              toast(t('extracting'), 'info');
              const { extractAudioAsset } = await import('../../services/mediaExtract.js');
              await extractAudioAsset(f, activeCat, f.name.replace(/\.[^.]+$/, ''));
              toast(t('audioExtracted'), 'success');
            } else {
              await importFile(f, activeCat);
            }
          } catch (e) { toast(e.message, 'error'); }
        }
        rebuild();
      };
      body.append(upBtn);
    }

    const assets = await listAssets({ category: activeCat });
    if (!assets.length) {
      body.append(el('div', { class: 'empty-state', style: { padding: '24px 8px' } },
        el('i', { class: `fa-solid ${CATS.find(c => c.id === activeCat).icon}` })));
      return;
    }
    for (const a of assets) {
      const thumb = el('div', { class: 'asset-thumb', style: { aspectRatio: '16/9' } });
      if (a.kind === 'image' || a.kind === 'gif') assetUrl(a.id).then(u => u && thumb.append(el('img', { src: u })));
      else if (a.kind === 'video') assetUrl(a.id).then(u => u && thumb.append(el('video', { src: u, muted: true })));
      else thumb.append(el('i', { class: 'fa-solid fa-music' }));

      // delete button (hover)
      const delBtn = el('button', { class: 'btn btn-sm btn-danger', title: t('delete') }, el('i', { class: 'fa-solid fa-trash' }));
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog(t('deleteConfirm')))) return;
        // clean references: clips using this asset + project pointers
        const p2 = state.project;
        pushHistory('Delete asset');
        p2.clips = p2.clips.filter(c => c.assetId !== a.id);
        if (p2.vtuber.assetId === a.id) p2.vtuber.assetId = null;
        if (p2.background.assetId === a.id) { p2.background.assetId = null; p2.background.type = 'color'; }
        for (const mt of p2.materials || []) if (mt.assetId === a.id) { mt.assetId = null; mt.status = 'waiting'; }
        await removeAsset(a.id);
        markDirty(); emit('timeline'); emit('project');
        renderFrame();
        toast('✓', 'success');
      };

      const card = el('div', { class: 'asset-card', style: { marginBottom: '8px' } },
        thumb,
        el('div', { class: 'asset-actions' }, delBtn),
        el('div', { class: 'asset-name' }, a.name, a.duration ? ` · ${fmtDur(a.duration)}` : ''));

      const actions = el('div', { class: 'row', style: { padding: '0 8px 8px', gap: '5px' } });
      // context actions
      if (activeCat === 'vtuber') {
        actions.append(el('button', {
          class: 'btn btn-sm btn-primary grow',
          onclick: () => { assignVtuber(a); rebuild(); renderFrame(); },
        }, t('useAsVtuber')));
      } else if (activeCat === 'background') {
        actions.append(el('button', {
          class: 'btn btn-sm btn-primary grow',
          onclick: () => { assignBackground(a); renderFrame(); },
        }, t('setAsBackground')));
      } else {
        actions.append(el('button', {
          class: 'btn btn-sm grow',
          onclick: () => { addAssetToTimeline(a); renderFrame(); },
        }, el('i', { class: 'fa-solid fa-plus' }), ' ', t('addToTimeline')));
      }
      card.append(actions);
      body.append(card);
    }
  };

  for (const c of CATS) {
    const b = el('button', { class: `panel-tab ${c.id === activeCat ? 'active' : ''}`, title: t(c.id === 'broll' ? 'images' : c.id === 'meme' ? 'memes' : c.id === 'background' ? 'backgrounds' : c.id) },
      el('i', { class: `fa-solid ${c.icon}` }));
    b.onclick = () => {
      activeCat = c.id;
      [...tabBar.children].forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      rebuild();
    };
    tabBar.append(b);
  }
  host.append(tabBar, body);
  rebuild();
  on('assets', rebuild);
}

/**
 * Assign VTuber video — REWRITTEN FROM SCRATCH.
 *
 * The VTuber enters the project as a COMPLETELY PLAIN video:
 *   • any previous vtuber clips are deleted (no stale state survives)
 *   • project.vtuber is rebuilt fresh: centered (540/960), scale 100%,
 *     chroma key hard-reset to enabled:false
 *   • NO effect, NO chroma, NO preset transform is applied
 * The user later enables the chroma key tool and adjusts size/position
 * manually (properties panel or dragging in the preview).
 */
export function assignVtuber(asset) {
  const p = state.project;
  pushHistory('Set VTuber');

  // 1) wipe EVERYTHING related to any previous vtuber — old clips AND old
  //    persisted settings (stale chroma.enabled=true from older projects was
  //    keying out the whole frame → "black screen")
  p.clips = p.clips.filter(c => c.trackId !== 'vtuber');
  p.vtuber = {
    assetId: asset.id,
    x: VTUBER_DEFAULTS.x,        // 540  — frame center
    y: VTUBER_DEFAULTS.y,        // 960  — frame center
    scale: VTUBER_DEFAULTS.scale, // 100% — natural size (fit width)
    rotation: 0, opacity: 100,
    chroma: { ...CHROMA_DEFAULTS, enabled: false }, // OFF until user turns it on
  };

  // 2) one plain clip — exactly like any ordinary video on the timeline
  const dur = (isFinite(asset.duration) && asset.duration > 0) ? asset.duration : 30;
  const clip = createClip('vtuber', {
    name: 'VTuber', assetId: asset.id, start: 0, duration: dur,
    x: VTUBER_DEFAULTS.x, y: VTUBER_DEFAULTS.y, scale: VTUBER_DEFAULTS.scale,
    rotation: 0, opacity: 100,
    transitionIn: 'cut', transitionOut: 'cut', animation: 'none', hasAudio: true,
  });
  p.clips.push(clip);
  // late duration recovery for assets stored with duration=0
  if (!asset.duration || !isFinite(asset.duration)) {
    assetUrl(asset.id).then(url => {
      if (!url) return;
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true;
      v.onloadedmetadata = () => {
        const fix = () => {
          if (isFinite(v.duration) && v.duration > 0) {
            clip.duration = v.duration;
            recalcDuration(); markDirty(); emit('timeline');
          }
        };
        if (isFinite(v.duration) && v.duration > 0) fix();
        else { v.ondurationchange = fix; v.currentTime = 1e7; }
      };
      v.src = url;
    });
  }
  markUsed(asset.id);
  recalcDuration(); markDirty(); emit('timeline'); emit('project');
}

export function assignBackground(asset) {
  const p = state.project;
  pushHistory('Set Background');
  p.background.assetId = asset.id;
  p.background.type = asset.kind === 'video' ? 'video' : 'image';
  let clip = p.clips.find(c => c.trackId === 'background');
  if (!clip) {
    clip = createClip('background', {
      name: 'Background', assetId: asset.id, start: 0, duration: p.duration,
      isBackground: true, loop: true, transitionIn: 'cut', transitionOut: 'cut',
    });
    p.clips.push(clip);
  } else {
    clip.assetId = asset.id;
    clip.duration = p.duration;
  }
  markUsed(asset.id);
  markDirty(); emit('timeline'); emit('project');
}

/** Add generic asset at playhead on the matching track */
export function addAssetToTimeline(asset) {
  const trackMap = { broll: asset.kind === 'video' ? 'broll_vid' : 'broll_img', meme: 'memes', music: 'music', sfx: 'sfx', background: 'background', vtuber: 'vtuber', other: 'overlays' };
  const trackId = trackMap[asset.category] || 'overlays';
  const isAudio = trackId === 'music' || trackId === 'sfx';
  const clip = createClip(trackId, {
    name: asset.name, assetId: asset.id,
    start: state.playhead,
    duration: asset.duration ? Math.min(asset.duration, trackId === 'music' ? state.project.duration : asset.duration) : 3,
    x: VIDEO.width / 2, y: VIDEO.height * 0.36, scale: 88,
    ...(trackId === 'music' ? { volume: MUSIC_DEFAULTS.volumeDb, treble: MUSIC_DEFAULTS.trebleDb, fadeIn: MUSIC_DEFAULTS.fadeIn, fadeOut: MUSIC_DEFAULTS.fadeOut, loop: true } : {}),
    ...(trackId === 'sfx' ? { volume: -6 } : {}),
    ...(isAudio ? {} : { transitionIn: 'pop', transitionOut: 'fade', animation: 'pop' }),
  });
  addClip(clip, 'Add ' + asset.name);
  markUsed(asset.id);
}
