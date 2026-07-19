/**
 * settings.js — Gemini API key (encrypted local), model selector, language, fonts.
 */
import { el } from '../../utils.js';
import { t, getLang, setLang } from '../../i18n.js';
import { GEMINI_MODELS } from '../../config.js';
import { settings } from '../../store.js';
import { testApi } from '../../services/gemini.js';
import { toast, pickFiles } from '../components.js';
import { detectSystemFonts, importFont, getCustomFonts } from '../../services/fonts.js';

export async function renderSettings(host) {
  /* ---- API key ---- */
  const keyInput = el('input', { class: 'input', type: 'password', placeholder: t('enterKey'), value: settings.apiKey });
  const saveBtn = el('button', { class: 'btn btn-primary' }, el('i', { class: 'fa-solid fa-key' }), t('saveKey'));
  saveBtn.onclick = () => { settings.apiKey = keyInput.value.trim(); toast(t('keySaved'), 'success'); };

  const testBtn = el('button', { class: 'btn' }, el('i', { class: 'fa-solid fa-plug' }), t('testApi'));
  testBtn.onclick = async () => {
    settings.apiKey = keyInput.value.trim();
    if (!settings.apiKey) return toast(t('needApiKey'), 'warn');
    testBtn.disabled = true;
    testBtn.innerHTML = `<i class="fa-solid fa-spinner spin"></i> ${t('testApi')}`;
    try { await testApi(); toast(t('apiOk'), 'success'); }
    catch (e) { toast(`${t('apiFail')}: ${e.message.slice(0, 120)}`, 'error'); }
    finally { testBtn.disabled = false; testBtn.innerHTML = `<i class="fa-solid fa-plug"></i> ${t('testApi')}`; }
  };

  /* ---- model ---- */
  const modelSel = el('select', { class: 'input' },
    ...GEMINI_MODELS.map(m => el('option', { value: m, selected: settings.model === m }, m)));
  modelSel.onchange = () => { settings.model = modelSel.value; toast(t('saved'), 'success'); };

  /* ---- language ---- */
  const langSel = el('select', { class: 'input' },
    el('option', { value: 'ar', selected: getLang() === 'ar' }, 'العربية'),
    el('option', { value: 'en', selected: getLang() === 'en' }, 'English'));
  langSel.onchange = () => setLang(langSel.value);

  /* ---- fonts ---- */
  const fontList = el('div', { style: { maxHeight: '160px', overflow: 'auto', fontSize: '12px', color: 'var(--text-1)', lineHeight: '1.9' } });
  const refreshFonts = async () => {
    const fonts = await detectSystemFonts();
    const custom = getCustomFonts();
    fontList.innerHTML = '';
    fontList.append(...fonts.map(f => el('div', { style: { fontFamily: `"${f}"` } },
      f, custom.includes(f) ? el('span', { class: 'badge', style: { marginInlineStart: '8px' } }, 'custom') : '')));
  };
  const detectBtn = el('button', { class: 'btn' }, el('i', { class: 'fa-solid fa-font' }), t('detectFonts'));
  detectBtn.onclick = refreshFonts;
  const importFontBtn = el('button', { class: 'btn' }, el('i', { class: 'fa-solid fa-file-arrow-up' }), t('importFont'));
  importFontBtn.onclick = async () => {
    const files = await pickFiles('.ttf,.otf');
    for (const f of files) {
      try { const name = await importFont(f); toast(`Font "${name}" ✓`, 'success'); }
      catch (e) { toast(e.message, 'error'); }
    }
    refreshFonts();
  };

  host.append(el('section', { class: 'page', style: { maxWidth: '760px' } },
    el('h1', { class: 'page-title' }, t('settings')),
    el('p', { class: 'page-sub' }, ''),
    el('div', { class: 'grid', style: { gap: '18px' } },
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, el('i', { class: 'fa-solid fa-robot' }), 'Google Gemini'),
        el('div', { class: 'field' }, el('label', {}, t('apiKey')), keyInput),
        el('div', { class: 'row', style: { marginBottom: '14px' } }, saveBtn, testBtn),
        el('div', { class: 'field' }, el('label', {}, t('model')), modelSel),
        el('p', { style: { fontSize: '11px', color: 'var(--text-2)' } }, '🔒 ', t('keySaved')),
      ),
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, el('i', { class: 'fa-solid fa-globe' }), t('language')),
        el('div', { class: 'field' }, el('label', {}, t('language')), langSel),
      ),
      el('div', { class: 'card' },
        el('div', { class: 'card-title' }, el('i', { class: 'fa-solid fa-font' }), t('font')),
        el('div', { class: 'row', style: { marginBottom: '12px' } }, detectBtn, importFontBtn),
        fontList,
      ),
    ),
  ));
}
