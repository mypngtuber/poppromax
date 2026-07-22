/**
 * config.js — Central application configuration.
 * NOTHING is hardcoded elsewhere; every default lives here.
 */
export const APP = {
  name: 'AI VTuber Shorts Editor',
  version: '1.0.0',
  projectExt: '.vtproject',
  autosaveIntervalMs: 60_000,
};

/** Target output video format */
export const VIDEO = {
  width: 1080,
  height: 1920,
  fps: 30,
  aspect: '9:16',
  codec: 'h264',
};

/** VTuber import defaults — plain video, centered, normal size.
 * No auto chroma, no preset position: the user adjusts everything manually. */
export const VTUBER_DEFAULTS = {
  x: 540,              // frame center X
  y: 960,              // frame center Y
  scale: 100,          // percent (fit width)
  rotation: 0,
  opacity: 100,
};

/** Default chroma key parameters — OFF until the user enables it manually */
export const CHROMA_DEFAULTS = {
  enabled: false,
  keyColor: '#00ff00',
  tolerance: 0.30,
  softness: 0.10,
  spill: 0.50,
  feather: 0.0,
  blur: 0.0,
  preview: true,
};

/** Default TikTok-style caption template */
export const CAPTION_DEFAULTS = {
  templateId: 'tiktok',
  x: 540,
  y: 960,
  scale: 100,
  maxCharsPerLine: 18,
  font: 'Cairo',
  fontSize: 64,
  activeColor: '#FFD400',   // current spoken word — bright yellow
  inactiveColor: '#B8960C', // other words — dark yellow
  activeScale: 1.15,        // current word slightly larger
  outlineColor: '#000000',
  outlineWidth: 8,
  align: 'center',
};

/** Built-in caption templates (unlimited user templates supported) */
export const CAPTION_TEMPLATES = [
  { id: 'tiktok',  name: 'TikTok Style',   activeColor: '#FFD400', inactiveColor: '#B8960C', font: 'Cairo',  fontSize: 64, outlineWidth: 8 },
  { id: 'shorts',  name: 'YouTube Shorts', activeColor: '#FFFFFF', inactiveColor: '#BBBBBB', font: 'Inter',  fontSize: 60, outlineWidth: 7 },
  { id: 'minimal', name: 'Minimal',        activeColor: '#FFFFFF', inactiveColor: '#888888', font: 'Inter',  fontSize: 52, outlineWidth: 0 },
  { id: 'gaming',  name: 'Gaming',         activeColor: '#2DD4BF', inactiveColor: '#0E7C6B', font: 'Cairo',  fontSize: 66, outlineWidth: 9 },
  { id: 'neon',    name: 'Neon',           activeColor: '#F368E0', inactiveColor: '#8A3B7F', font: 'Inter',  fontSize: 62, outlineWidth: 6 },
];

/** Default music mastering settings */
export const MUSIC_DEFAULTS = {
  trebleDb: -24,
  volumeDbMin: -30,
  volumeDbMax: -25,
  volumeDb: -27,
  fadeIn: 0.5,
  fadeOut: 1.0,
};

/** Supported Gemini models (older models not supported) */
export const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Timeline track definitions — dynamic, extendable */
export const TRACKS = [
  { id: 'background', name: { en: 'Background',  ar: 'الخلفية' },        color: '#4aa3ff', kind: 'video',   height: 34 },
  { id: 'vtuber',     name: { en: 'VTuber',      ar: 'الشخصية' },        color: '#7c5cff', kind: 'video',   height: 40 },
  { id: 'broll_img',  name: { en: 'B-Roll Img',  ar: 'صور B-Roll' },     color: '#2dd4bf', kind: 'image',   height: 32 },
  { id: 'broll_vid',  name: { en: 'B-Roll Vid',  ar: 'فيديو B-Roll' },   color: '#3ecf8e', kind: 'video',   height: 32 },
  { id: 'memes',      name: { en: 'Memes',       ar: 'ميمز' },           color: '#f368e0', kind: 'image',   height: 32 },
  { id: 'overlays',   name: { en: 'Overlays',    ar: 'طبقات علوية' },    color: '#ff9f43', kind: 'image',   height: 30 },
  { id: 'captions',   name: { en: 'Captions',    ar: 'الترجمة' },        color: '#ffd400', kind: 'caption', height: 30 },
  { id: 'transitions',name: { en: 'Transitions', ar: 'الانتقالات' },     color: '#b9b9c3', kind: 'fx',      height: 26 },
  { id: 'music',      name: { en: 'Music',       ar: 'الموسيقى' },       color: '#9d7bff', kind: 'audio',   height: 32 },
  { id: 'sfx',        name: { en: 'SFX',         ar: 'مؤثرات صوتية' },   color: '#f0475c', kind: 'audio',   height: 30 },
];

export const TRANSITIONS = ['cut','fade','crossDissolve','zoom','blur','whip','flash','glitch','slide','pop'];
export const ANIMATIONS = ['none','fade','zoom','pop','slideLeft','slideRight','slideUp','slideDown','scale','rotate','bounce','flash','rgbPop'];
export const MATERIAL_TYPES = ['image','png','meme','gif','video','sticker','sfx','music','logo','screenshot'];
export const MATERIAL_STATUS = ['waiting','uploaded','skipped','missing','ready'];
export const ASSET_CATEGORIES = ['vtuber','background','broll','meme','music','sfx','other'];
export const BG_CATEGORIES = ['gaming','anime','dark','funny','minimal','custom'];

export const ACCEPTED = {
  image: '.png,.jpg,.jpeg,.webp,.gif',
  video: '.mp4,.mov,.webm',
  audio: '.mp3,.wav,.ogg',
  font: '.ttf,.otf',
  any: '.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,.mp3,.wav,.ogg',
};

/** Timeline UI constants */
export const TL = {
  headerWidth: 128,
  rulerHeight: 26,
  minPxPerSec: 6,
  maxPxPerSec: 480,
  defaultPxPerSec: 60,
  snapThresholdPx: 8,
  minClipDur: 0.05,
};
