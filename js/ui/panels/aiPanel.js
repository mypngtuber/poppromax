/**
 * aiPanel.js — AI Director panel:
 * 1) Analyze audio via Gemini  2) Scene list with scores + Improve Scene
 * 3) Materials Needed queue (Search / Upload / Skip)  4) Generate Timeline
 */
import { el, fmtDur } from '../../utils.js';
import { t } from '../../i18n.js';
import { ACCEPTED } from '../../config.js';
import { state, settings, saveProject, pushHistory, markDirty, emit } from '../../store.js';
import { analyzeAudio, extractAudio, improveScene } from '../../services/gemini.js';
import { generateTimeline } from '../../services/timelineGenerator.js';
import { importFile } from '../../services/assets.js';
import { aiPickSegment, extractAudioAsset, captureFrameAsset, saveVideoSegmentAsset } from '../../services/mediaExtract.js';
import { db, assetUrl } from '../../services/db.js';
import { toast, pickFiles, stars } from '../components.js';

let busy = false;

export function renderAiPanel(host, ctx2) {
  host.innerHTML = '';
  const p = state.project;
  const a = p?.aiAnalysis;

  /* ---------- analyze button ---------- */
  const analyzeBtn = el('button', { class: 'btn btn-primary btn-block', disabled: busy },
    el('i', { class: `fa-solid ${busy ? 'fa-spinner spin' : 'fa-wand-magic-sparkles'}` }),
    busy ? t('analyzing') : t('analyzeAudio'));
  analyzeBtn.onclick = () => runAnalysis(host, ctx2);
  host.append(analyzeBtn);

  if (!a) {
    host.append(el('div', { class: 'empty-state' },
      el('i', { class: 'fa-solid fa-robot' }), t('noAnalysis')));
    return;
  }

  /* ---------- summary + hook ---------- */
  host.append(el('div', { class: 'scene-card', style: { marginTop: '12px' } },
    el('div', { class: 'scene-head' },
      el('span', { class: 'scene-title' }, '🎬 ', a.summary || ''),
    ),
    el('div', { class: 'scene-meta' },
      el('span', { class: 'chip' }, `${fmtDur(a.totalDuration || 0)}`),
      el('span', { class: 'chip' }, `${(a.words || []).length} ${t('wordsL')}`),
      el('span', { class: 'chip purpose' }, `${t('musicMood')}: ${a.musicRecommendation?.mood || '—'}`)),
  ));
  if (a.hook) {
    host.append(el('div', { class: 'scene-card' },
      el('div', { class: 'scene-head' },
        el('span', { class: 'scene-title' }, '🪝 ', t('hook')), stars(a.hook.strength || 3)),
      a.hook.suggestion && (a.hook.strength || 3) < 4
        ? el('p', { style: { fontSize: '11px', color: 'var(--orange)' } }, '💡 ', a.hook.suggestion) : ''));
  }

  /* ---------- materials queue ---------- */
  const materials = p.materials || [];
  const required = materials.filter(m => m.priority === 'required');
  const requiredReady = required.every(m => ['uploaded', 'ready', 'skipped'].includes(m.status));

  if (materials.length) {
    host.append(el('h4', { style: { margin: '14px 0 8px', fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-2)', letterSpacing: '.06em' } },
      `📦 ${t('materialsNeeded')} (${materials.filter(m => ['uploaded', 'ready'].includes(m.status)).length}/${materials.length})`));

    for (const m of materials) {
      const statusChip = el('span', { class: `material-status st-${m.status}` }, t(m.status));

      const searchBtn = el('button', { class: 'btn btn-sm' }, el('i', { class: 'fa-solid fa-magnifying-glass' }), ' ', t('search'));
      searchBtn.onclick = () => {
        const q = m.searchQueries?.image || m.searchQueries?.google || m.description;
        const engine = m.type === 'gif' ? `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(m.searchQueries?.gif || q)}`
          : m.type === 'video' ? `https://www.youtube.com/results?search_query=${encodeURIComponent(m.searchQueries?.youtube || q)}`
          : `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q)}`;
        window.open(engine, '_blank');
      };

      const matCategory = m.type === 'music' ? 'music' : m.type === 'sfx' ? 'sfx' : m.type === 'meme' || m.type === 'gif' ? 'meme' : 'broll';
      const assignAsset = async (asset) => {
        pushHistory('Assign material');
        m.assetId = asset.id; m.status = 'uploaded';
        markDirty(); await saveProject(true);
        toast(`${asset.name} ✓`, 'success');
        renderAiPanel(host, ctx2);
      };

      const uploadBtn = el('button', { class: 'btn btn-sm btn-primary' }, el('i', { class: 'fa-solid fa-upload' }), ' ', t('upload'));
      uploadBtn.onclick = async () => {
        // audio materials also accept a VIDEO — the audio track gets extracted automatically
        const accept = m.type === 'sfx' || m.type === 'music' ? ACCEPTED.audio + ',' + ACCEPTED.video : m.type === 'video' ? ACCEPTED.video : ACCEPTED.image;
        const files = await pickFiles(accept, false);
        if (!files.length) return;
        try {
          const f = files[0];
          let asset;
          if ((m.type === 'sfx' || m.type === 'music') && f.type.startsWith('video/')) {
            toast(t('extracting'), 'info');
            asset = await extractAudioAsset(f, matCategory, f.name.replace(/\.[^.]+$/, ''));
            toast(t('audioExtracted'), 'success');
          } else {
            asset = await importFile(f, matCategory);
          }
          await assignAsset(asset);
        } catch (e) { toast(e.message, 'error'); }
      };

      /* "Extract from Video" — donor video → Gemini analyzes audio+frames → best segment auto-cut */
      const extractBtn = el('button', { class: 'btn btn-sm', title: t('extractFromVideo') },
        el('i', { class: 'fa-solid fa-scissors' }), ' ', t('extractFromVideo'));
      extractBtn.onclick = async () => {
        const files = await pickFiles(ACCEPTED.video, false);
        if (!files.length) return;
        const f = files[0];
        extractBtn.disabled = true;
        extractBtn.innerHTML = `<i class="fa-solid fa-spinner spin"></i> ${t('extracting')}`;
        try {
          const pick = await aiPickSegment(f, m.description || m.type, () => {});
          const baseName = (pick.suggestedName || m.id).replace(/[^\w\u0600-\u06FF-]+/g, '-').slice(0, 40);
          let asset;
          if (!pick.found) {
            // AI found no match — fall back sensibly (full audio / middle frame)
            toast(pick.reason || 'No exact match — using fallback', 'warn');
            pick.start = 0; pick.end = Math.min(8, 999);
          } else {
            toast(`✓ ${t('segmentFound')}: ${pick.start.toFixed(1)}s → ${pick.end.toFixed(1)}s`, 'success');
          }
          if (m.type === 'sfx' || m.type === 'music') {
            asset = await extractAudioAsset(f, matCategory, baseName, { start: pick.start, end: pick.end });
          } else if (m.type === 'video' || m.type === 'gif') {
            asset = await saveVideoSegmentAsset(f, pick.start, pick.end, matCategory, baseName, (r) => {
              extractBtn.innerHTML = `<i class="fa-solid fa-spinner spin"></i> ${(Math.min(r, 1) * 100).toFixed(0)}%`;
            });
          } else {
            // image / png / meme / screenshot / sticker / logo → capture best frame (middle of segment)
            asset = await captureFrameAsset(f, (pick.start + pick.end) / 2, matCategory, baseName);
            toast(t('captureFrame'), 'success');
          }
          await assignAsset(asset);
        } catch (e) {
          toast(e.message === 'NO_API_KEY' ? t('needApiKey') : String(e.message).slice(0, 140), 'error');
        } finally {
          extractBtn.disabled = false;
          extractBtn.innerHTML = `<i class="fa-solid fa-scissors"></i> ${t('extractFromVideo')}`;
        }
      };

      const skipBtn = el('button', { class: 'btn btn-sm btn-ghost' }, t('skip'));
      skipBtn.onclick = async () => {
        pushHistory('Skip material');
        m.status = 'skipped'; m.assetId = null;
        markDirty(); await saveProject(true);
        renderAiPanel(host, ctx2);
      };

      const thumb = el('div', { style: { width: '44px', height: '44px', borderRadius: '6px', background: 'var(--bg-3)', display: 'grid', placeItems: 'center', overflow: 'hidden', flex: 'none' } },
        el('i', { class: `fa-solid ${iconForType(m.type)}`, style: { color: 'var(--text-2)' } }));
      if (m.assetId) assetUrl(m.assetId).then(u => {
        if (u) { thumb.innerHTML = ''; thumb.append(el('img', { src: u, style: { width: '100%', height: '100%', objectFit: 'cover' } })); }
      });

      host.append(el('div', { class: 'material-card' },
        el('div', { class: 'row', style: { alignItems: 'flex-start' } },
          thumb,
          el('div', { class: 'grow' },
            el('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '4px' } },
              el('span', { class: 'chip purpose' }, m.type), statusChip),
            el('p', { style: { fontSize: '11px', color: 'var(--text-1)', lineHeight: '1.5', userSelect: 'text' } }, m.description || ''))),
        el('div', { class: 'row', style: { marginTop: '8px', gap: '5px', flexWrap: 'wrap' } }, searchBtn, uploadBtn, extractBtn, skipBtn),
      ));
    }

    /* ---------- generate timeline ---------- */
    const genBtn = el('button', {
      class: 'btn btn-primary btn-block', disabled: !requiredReady,
      style: { marginTop: '6px', marginBottom: '12px' },
    }, el('i', { class: 'fa-solid fa-bolt' }), t('generateTimeline'));
    genBtn.onclick = async () => {
      await saveProject(true); // save before generation
      generateTimeline();
      await saveProject(true);
      toast(t('timelineGenerated'), 'success');
      ctx2?.renderFrame?.();
    };
    host.append(genBtn);
  }

  /* ---------- scenes ---------- */
  if (a.scenes?.length) {
    host.append(el('h4', { style: { margin: '10px 0 8px', fontSize: '11px', textTransform: 'uppercase', color: 'var(--text-2)', letterSpacing: '.06em' } },
      `🎞 ${t('scenes')} (${a.scenes.length})`));
    for (const s of a.scenes) {
      const card = el('div', { class: 'scene-card' },
        el('div', { class: 'scene-head' },
          el('span', { class: 'scene-title' }, `${s.sceneNumber}. ${s.title || ''}`),
          stars(s.score)),
        el('div', { class: 'scene-meta' },
          el('span', { class: 'chip' }, `${fmtDur(s.startTime)} → ${fmtDur(s.endTime)}`),
          el('span', { class: 'chip purpose' }, s.purpose || ''),
          el('span', { class: 'chip emotion' }, s.emotion || ''),
          el('span', { class: 'chip energy' }, `${s.energy || ''} · ${s.editingSpeed || ''}`)),
      );
      if (s.suggestion && s.score < 4) {
        card.append(el('p', { style: { fontSize: '11px', color: 'var(--orange)', marginTop: '6px' } }, '💡 ', s.suggestion));
      }
      if (s.score < 4) {
        const impBtn = el('button', { class: 'btn btn-sm', style: { marginTop: '7px' } },
          el('i', { class: 'fa-solid fa-arrows-rotate' }), ' ', t('improveScene'));
        impBtn.onclick = () => runImproveScene(s.sceneNumber, host, ctx2, impBtn);
        card.append(impBtn);
      }
      // click scene → jump playhead
      card.style.cursor = 'pointer';
      card.onclick = (e) => {
        if (e.target.closest('button')) return;
        import('../../store.js').then(({ setPlayhead }) => setPlayhead(s.startTime));
      };
      host.append(card);
    }
  }
}

function iconForType(type) {
  return {
    image: 'fa-image', png: 'fa-image', meme: 'fa-face-laugh-squint', gif: 'fa-film',
    video: 'fa-video', sticker: 'fa-note-sticky', sfx: 'fa-volume-high',
    music: 'fa-music', logo: 'fa-certificate', screenshot: 'fa-camera',
  }[type] || 'fa-file';
}

/* ---------------- analysis flow ---------------- */
async function runAnalysis(host, ctx2) {
  const p = state.project;
  if (!settings.apiKey) return toast(t('needApiKey'), 'warn');
  if (!p.vtuber.assetId) return toast(t('needVtuber'), 'warn');
  if (busy) return;
  busy = true;
  renderAiPanel(host, ctx2);
  try {
    const asset = await db.getAsset(p.vtuber.assetId);
    toast(t('analyzing'), 'info');
    // cache: reuse previous extraction if same asset
    const cacheKey = `audio_${p.vtuber.assetId}`;
    let audio = await db.kvGet(cacheKey);
    if (!audio) {
      audio = await extractAudio(asset.blob);
      await db.kvSet(cacheKey, audio);
    }
    toast(t('aiWorking'), 'info', 'fa-robot');
    const analysis = await analyzeAudio(audio.blob, audio.mime);
    if (!analysis.totalDuration) analysis.totalDuration = audio.duration;
    pushHistory('AI Analysis');
    p.aiAnalysis = analysis;
    p.materials = analysis.materials || [];
    markDirty();
    await saveProject(true);
    // cache analysis
    await db.kvSet(`analysis_${p.id}`, { time: Date.now(), analysis });
    toast('✓ AI Director', 'success');
  } catch (e) {
    console.error(e);
    toast(e.message === 'NO_API_KEY' ? t('needApiKey') : `${t('apiFail')}: ${String(e.message).slice(0, 140)}`, 'error');
  } finally {
    busy = false;
    renderAiPanel(host, ctx2);
    emit('project');
  }
}

/* ---------------- improve ONE scene ---------------- */
async function runImproveScene(sceneNumber, host, ctx2, btn) {
  const p = state.project;
  if (!settings.apiKey) return toast(t('needApiKey'), 'warn');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner spin"></i> ${t('improveScene')}`;
  try {
    const cacheKey = `audio_${p.vtuber.assetId}`;
    const audio = await db.kvGet(cacheKey);
    const result = await improveScene(p.aiAnalysis, sceneNumber, audio?.blob, audio?.mime);
    pushHistory('Improve scene');
    const scene = p.aiAnalysis.scenes.find(s => s.sceneNumber === sceneNumber);
    if (result.scene) Object.assign(scene, result.scene, { sceneNumber });
    // merge scene-scoped materials/plans: replace items inside the scene range only
    const inRange = (x) => x >= scene.startTime - 0.01 && x <= scene.endTime + 0.01;
    if (Array.isArray(result.materials) && result.materials.length) {
      p.materials = p.materials.filter(m => !(m.sceneNumber === sceneNumber));
      result.materials.forEach((m, i) => { m.id = m.id || `mat_s${sceneNumber}_${i}`; m.status = 'waiting'; m.assetId = null; m.sceneNumber = sceneNumber; });
      p.materials.push(...result.materials);
    }
    if (Array.isArray(result.brollPlan) && result.brollPlan.length) {
      p.aiAnalysis.brollPlan = p.aiAnalysis.brollPlan.filter(b => !inRange(b.startTime));
      p.aiAnalysis.brollPlan.push(...result.brollPlan);
    }
    if (Array.isArray(result.soundEffects) && result.soundEffects.length) {
      p.aiAnalysis.soundEffects = p.aiAnalysis.soundEffects.filter(s => !inRange(s.time));
      p.aiAnalysis.soundEffects.push(...result.soundEffects);
    }
    markDirty();
    await saveProject(true);
    // regenerate timeline ONLY inside that scene
    generateTimeline({ scope: { start: scene.startTime, end: scene.endTime } });
    toast('✓ ' + t('regenScene'), 'success');
  } catch (e) {
    toast(`${t('apiFail')}: ${String(e.message).slice(0, 120)}`, 'error');
  } finally {
    renderAiPanel(host, ctx2);
    ctx2?.renderFrame?.();
  }
}
