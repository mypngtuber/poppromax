/**
 * gemini.js — AI Director engine.
 * Sends audio to Gemini, receives strict machine-readable JSON,
 * from which the frontend builds the entire timeline.
 */
import { GEMINI_API_BASE } from '../config.js';
import { settings } from '../store.js';
import { blobToBase64 } from '../utils.js';

const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

/** Director system prompt — Gemini is a video DIRECTOR, not a chatbot. */
const DIRECTOR_PROMPT = `
You are a professional YouTube Shorts / TikTok video DIRECTOR and EDITOR, not a chatbot.
You receive the full voice recording of a VTuber creator. Analyze the ENTIRE audio before deciding anything.

Understand: context, story, emotion, humor, sarcasm, speed, excitement, pauses, silence, topic changes, punchlines, dramatic moments, laughing, shouting, whispering, questions, keywords, unexpected moments, story progression.

TASKS:
1. TRANSCRIBE with word-level timing (seconds, decimals). Use the spoken language as-is.
2. SCENE DETECTION: split by MEANING, never per sentence. Scenes: sceneNumber, startTime, endTime, title (short, same language as speech), purpose (one of: introduction,hook,explanation,story,comparison,tutorial,joke,reaction,warning,question,answer,ending,callToAction), energy (low|medium|high|extreme), emotion (happy,funny,serious,shocking,sad,confused,angry,calm,excited,motivational,epic,fear,suspense), importance (1-5), editingSpeed (slow|medium|fast|veryFast), score (1-5 stars as integer), scoreReason (short), suggestion (only if score<4, how to improve).
3. HOOK: evaluate first seconds. hookStrength (1-5), hookSuggestion if weak.
4. SILENCE DETECTION: silences[] with start, end, severity (small|medium|long), action (none|broll|pop|zoom|meme|reaction|funnyImage|quickAnimation).
5. MATERIAL REQUESTS: assets needed. Each: id (mat1,mat2..), type (image|png|meme|gif|video|sticker|sfx|music|logo|screenshot), description (VERY detailed, e.g. "High quality official Genshin Impact Bennett artwork. Surprised facial expression. Front facing. Transparent PNG preferred. No watermark. Bright colors."), searchQueries {google, image, youtube, gif}, sceneNumber, startTime, endTime, priority (required|recommended|optional), reason.
6. B-ROLL PLAN: brollPlan[]: materialId, startTime, endTime, layer (broll_img|broll_vid|memes|overlays), transitionIn, transitionOut (cut|fade|crossDissolve|zoom|blur|whip|flash|glitch|slide|pop), animation (none|fade|zoom|pop|slideLeft|slideRight|slideUp|slideDown|scale|rotate|bounce|flash|rgbPop), priority. RULES: never overload the screen, ONE important visual at a time, breathing space, match speech.
7. MEMES: only for funny/unexpected/sarcasm/fail/shock/irony/reaction moments. Never spam.
8. SOUND EFFECTS: soundEffects[]: type (pop|rgbPop|boom|whoosh|click|hit|notification|glitch|magic|explosion), time, duration, reason, materialId (link to a material request of type sfx).
9. MUSIC: musicRecommendation { mood (funny|epic|happy|calm|suspense|action|motivational), reason, changePoints[] }.
10. TRANSITIONS between scenes: sceneTransitions[]: afterScene, type, duration.

Output STRICT JSON ONLY. No markdown, no prose, no comments. Schema:
{
 "language": "ar|en|...",
 "totalDuration": number,
 "summary": "one line",
 "hook": {"strength":1-5,"suggestion":"..."},
 "words": [{"w":"text","s":0.0,"e":0.4}],
 "scenes": [{...}],
 "silences": [{...}],
 "materials": [{...}],
 "brollPlan": [{...}],
 "soundEffects": [{...}],
 "musicRecommendation": {...},
 "sceneTransitions": [{...}]
}
All times in seconds. Everything machine-readable.`;

export async function callGemini(parts, { signal } = {}) {
  const key = settings.apiKey;
  if (!key) throw new Error('NO_API_KEY');
  const url = `${GEMINI_API_BASE}/${settings.model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.4, responseMimeType: 'application/json', maxOutputTokens: 65536 },
  };
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    signal?.addEventListener('abort', () => ctrl.abort());
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        if (res.status === 429 || res.status >= 500) { lastErr = new Error(`Gemini ${res.status}`); await sleep(1500 * (attempt + 1)); continue; }
        throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
      }
      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ?? '';
      if (!text) throw new Error('Empty Gemini response');
      return text;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e.name === 'AbortError' && signal?.aborted) throw e;
      if (attempt === MAX_RETRIES) break;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error('Gemini request failed');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Robust JSON extraction with validation */
function parseDirectorJson(text) {
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1];
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) raw = raw.slice(first, last + 1);
  const data = JSON.parse(raw);
  // validation + normalization
  data.words = Array.isArray(data.words) ? data.words.filter(w => w && typeof w.w === 'string' && isFinite(w.s) && isFinite(w.e)) : [];
  data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
  data.materials = Array.isArray(data.materials) ? data.materials : [];
  data.brollPlan = Array.isArray(data.brollPlan) ? data.brollPlan : [];
  data.soundEffects = Array.isArray(data.soundEffects) ? data.soundEffects : [];
  data.silences = Array.isArray(data.silences) ? data.silences : [];
  data.sceneTransitions = Array.isArray(data.sceneTransitions) ? data.sceneTransitions : [];
  data.scenes.forEach((s, i) => {
    s.sceneNumber = s.sceneNumber ?? i + 1;
    s.score = Math.max(1, Math.min(5, Math.round(s.score ?? 3)));
    s.startTime = +s.startTime || 0; s.endTime = +s.endTime || 0;
  });
  data.materials.forEach((m, i) => { m.id = m.id || `mat${i + 1}`; m.status = 'waiting'; m.assetId = null; });
  return data;
}

/** Test API key + model connectivity */
export async function testApi() {
  const text = await callGemini([{ text: 'Reply with JSON: {"ok":true}' }]);
  const j = JSON.parse(text.replace(/```(json)?/g, '').trim());
  if (!j.ok) throw new Error('Unexpected response');
  return true;
}

/**
 * Full analysis: sends audio blob to Gemini as the Video Director.
 * Returns validated structured analysis JSON.
 */
export async function analyzeAudio(audioBlob, mimeType, { signal } = {}) {
  const b64 = await blobToBase64(audioBlob);
  const text = await callGemini([
    { text: DIRECTOR_PROMPT },
    { inlineData: { mimeType, data: b64 } },
    { text: 'Analyze this recording now. Return the strict JSON only.' },
  ], { signal });
  return parseDirectorJson(text);
}

/**
 * Regenerate / improve ONE scene only. Everything else untouched.
 */
export async function improveScene(analysis, sceneNumber, audioBlob, mimeType) {
  const scene = analysis.scenes.find(s => s.sceneNumber === sceneNumber);
  if (!scene) throw new Error('Scene not found');
  const parts = [
    { text: DIRECTOR_PROMPT },
    { text: `You already produced this analysis: ${JSON.stringify({ scenes: analysis.scenes, summary: analysis.summary })}\n\nNow IMPROVE ONLY scene ${sceneNumber} (${scene.startTime}s → ${scene.endTime}s). Reconsider its title, purpose, emotion, energy, editing style, score, b-roll ideas, memes, sound effects, and material requests for this time range ONLY.\nReturn STRICT JSON: {"scene": {...same scene schema...}, "materials": [...], "brollPlan": [...], "soundEffects": [...]} — all restricted to this scene's time range.` },
  ];
  if (audioBlob) {
    const b64 = await blobToBase64(audioBlob);
    parts.splice(1, 0, { inlineData: { mimeType, data: b64 } });
  }
  const text = await callGemini(parts);
  let raw = text.trim();
  const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
  if (first >= 0) raw = raw.slice(first, last + 1);
  return JSON.parse(raw);
}

/** Extract mono audio track from a video blob → WAV blob (16 kHz) for Gemini. */
export async function extractAudio(videoBlob) {
  const arrayBuf = await videoBlob.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await ac.decodeAudioData(arrayBuf.slice(0));
    const targetRate = 16000;
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
    const src = off.createBufferSource();
    src.buffer = decoded; src.connect(off.destination); src.start();
    const rendered = await off.startRendering();
    return { blob: audioBufferToWav(rendered), mime: 'audio/wav', duration: decoded.duration };
  } finally { ac.close(); }
}

export function audioBufferToWav(buffer) {
  const n = buffer.length, rate = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const out = new ArrayBuffer(44 + n * 2);
  const v = new DataView(out);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}
