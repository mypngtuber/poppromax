# 🎬 AI VTuber Shorts Editor

An AI-powered, production-grade web editor built for **one workflow only**: turning a VTuber green-screen recording into a finished 9:16 YouTube Short / TikTok video — with Gemini acting as the **Video Director**, automating 80–100% of the edit.

**Target output:** 1080×1920 · 30 fps · 9:16 · H.264-ready

---

## ✅ Currently Completed Features

### Core Application
- **Professional dark UI** inspired by Premiere Pro / DaVinci Resolve / CapCut Desktop
- **Full Arabic / English** instant language switching (RTL/LTR aware)
- **Main navigation**: Dashboard · Projects · Editor · Materials · Export · Settings
- **Modular ES-module architecture** — config, store, services, engines, views, panels all separated; nothing hardcoded (everything in `js/config.js`)

### Projects
- Create / open / continue / import / duplicate / rename / archive / delete
- **`.vtproject` custom format** — stores timeline, assets (embedded base64), captions, AI analysis, chroma settings, music settings; full restore on import
- **Autosave every 60s** + save before export/regenerate + **crash recovery** from autosave snapshot
- **Unlimited Undo/Redo** with history panel

### Settings
- **Gemini API key** — stored encrypted locally (never sent anywhere except Google), Save + **Test API** button
- **Model selector**: gemini-3.5-flash, gemini-3-flash-preview, gemini-3.1-flash-lite, gemini-3.1-flash-lite-preview, gemini-2.5-flash, gemini-2.5-flash-lite
- **Font system**: system font detection (Local Font Access API + canvas fallback), TTF/OTF import (instantly available + persisted)

### AI Director Engine (Gemini)
- Extracts audio from the VTuber video (WebAudio → 16 kHz WAV) and sends to Gemini
- Gemini returns **strict machine-readable JSON only**: word-level transcript, meaning-based scene detection (purpose/emotion/energy/importance/editing speed), **scene scores (★1–5)** with improvement suggestions, **hook evaluation**, silence detection with actions (b-roll/pop/zoom/meme…), **detailed material requests** with generated search queries, B-roll plan, meme placement rules, sound-effect plan, music mood recommendation, scene transitions
- **Improve Scene** — re-sends ONLY that scene; timeline regenerated only inside that scene's range
- **Materials Needed queue** — cards with type, rich description, status (Waiting/Uploaded/Skipped/Missing/Ready), **Search** (opens browser with the generated query — never auto-downloads copyrighted media), **Upload**, **Skip**
- **Generate Timeline** unlocks when all *required* materials are resolved; the frontend builds the entire timeline from the JSON (Gemini never touches the UI)
- Retry (2×) + timeout (120 s) + validation + friendly errors; audio & analysis cached in IndexedDB

### Editor
- **Preview**: 1080×1920 canvas, play/pause/stop, frame step, safe area, fullscreen, timecode
- **GPU Chroma Key (WebGL)** — no AI segmentation; controls: Key Color, Tolerance, Edge Softness, Spill Removal, Feather, Blur, Enable toggle — all live
- **VTuber defaults applied automatically**: X 547.5 · Y 1363.2 · Scale 206.1 (user-editable)
- **Direct manipulation** — click any object in the preview to move it / corner-drag to scale, exactly like Premiere
- **Canvas timeline** (no DOM clips → smooth with hundreds of clips): 10 tracks (Background, VTuber, B-Roll Img, B-Roll Vid, Memes, Overlays, Captions, Transitions, Music, SFX), zoom (Ctrl+wheel), scroll, ruler, **magnetic/frame/second snap**, playhead scrub, move, trim in/out, multi-select + marquee, track **lock/hide/mute**, markers (dbl-click ruler), split
- **Clip ops**: move, resize/trim, delete, duplicate, split, copy/paste, replace, change timing/transitions
- **Properties/Inspector**: transform (X/Y/scale/rotation/opacity/flip), transitions in/out (cut/fade/crossDissolve/zoom/blur/whip/flash/glitch/slide/pop), animations (fade/zoom/pop/slides/scale/rotate/bounce/flash/rgbPop), audio (volume dB, treble, fades, mute)
- **Keyboard shortcuts**: Space play · S split · Del delete · Ctrl+Z/Shift+Z undo/redo · Ctrl+C/V/D · ←/→ frame step · Home/End

### Captions
- Auto-generated from Gemini word timings, **TikTok style default**: current word **bright yellow #FFD400 + 15% larger**, other words dark yellow #B8960C, centered at X 540 / Y 960 / Scale 100
- **Max 18 chars/line (spaces included), words never split**, auto line breaks + silence-gap breaks
- 5 built-in templates (TikTok, YouTube Shorts, Minimal, Gaming, Neon) — extensible
- Caption editor: text, timing, position, font (system + imported), size, colors, outline

### Materials Library
- Categories: Backgrounds (Gaming/Anime/Dark/Funny/Minimal/Custom) · Music · SFX · Memes · B-Roll · VTuber videos
- Upload once → reuse forever (IndexedDB blobs), drag-drop zones, search, favorites, audio preview
- File validation (type whitelist + 500 MB cap)
- **Music mastering defaults auto-applied**: Treble −24 dB, Volume −27 dB (−25…−30 range), fade in/out
- **Video → audio extraction**: drop a VIDEO file into SFX/Music (library, editor panel, or AI material upload) and the audio track is extracted automatically to WAV

### Media Extraction Toolbox (`js/services/mediaExtract.js`)
- **Extract from Video** button on every AI material card: give it a donor video → Gemini analyzes its **audio + sampled frames** and returns the best-matching segment for the requested material → the app auto-cuts it:
  - sfx/music → trimmed WAV
  - video/gif → trimmed WebM segment (canvas re-encode with audio)
  - image/meme/screenshot → best frame captured as PNG
- Frame capture and segment trimming available as reusable services

### Export (rewritten — offline, frame-accurate)
- **MP4 H.264 + AAC export (primary)** — WebCodecs offline pipeline: every frame is seeked & awaited before drawing (**no dropped/black frames**), H.264 encode (hardware→software fallback across profiles), audio mixed with OfflineAudioContext (VTuber voice + music with dB/treble/fades + SFX) → AAC, muxed to .mp4 via `mp4-muxer` (CDN), 12 Mbps, faststart
- **Graceful fallbacks**: VP9-in-MP4 → MediaRecorder MP4 → MediaRecorder WebM (real-time) — user is told which format was produced
- **Premiere Pro Package (ZIP)** — `Project.fcpxml` + `Media/` folder with a copy of **every used material** (originals, uncompressed-stored) + bilingual README; import the XML in Premiere and all media links resolve automatically via relative paths
- **Premiere-compatible FCPXML 1.10** (standalone) — preserves timing, tracks/lanes, transforms, captions as titles, audio roles
- **.vtproject export** with embedded assets

---

## 🌐 Public URLs
- **Production**: publish via the Publish tab (static site — runs fully client-side)
- **Entry point**: `index.html` (SPA; views: dashboard / projects / editor / materials / export / settings — internal routing, no URL params)
- **External API used**: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` (user's own key, called directly from the browser)

## 🗄️ Data Architecture
| Store | Technology | Contents |
|---|---|---|
| `projects` | IndexedDB | project JSON (timeline, captions, AI analysis, settings) |
| `assets` | IndexedDB | media blobs + metadata (category, duration, favorites) |
| `kv` | IndexedDB | settings, custom fonts, audio/analysis caches, autosave snapshots |
| `localStorage` | — | language, encrypted API key, selected model |

## 📁 File Structure
```
index.html
css/theme.css                     — dark professional theme
js/
  config.js                       — ALL defaults & constants (nothing hardcoded elsewhere)
  i18n.js  · store.js · utils.js  — translation / state+history / helpers
  services/
    db.js · assets.js · fonts.js  — IndexedDB, material manager, font system
    gemini.js                     — AI Director (prompt, retry, JSON validation, audio extraction)
    timelineGenerator.js          — Director JSON → timeline clips
  engine/
    chromaKey.js                  — WebGL keyer
    renderer.js                   — frame compositor (layers, animations, karaoke captions)
    audio.js                      — WebAudio playback (dB gains, treble shelf, fades)
    timeline.js                   — canvas NLE timeline
    exporter.js                   — MP4 H.264 (WebCodecs+mp4-muxer), Premiere ZIP package (JSZip), FCPXML, .vtproject
  ui/
    components.js                 — toast/modal/dropzone/sliders
    views/                        — dashboard, projects, editor, materials, export, settings
    panels/                       — mediaPanel, aiPanel, propertiesPanel, historyPanel
```

## 🚧 Not Yet Implemented
- Proxy media generation (currently renders originals; playback is realtime-synced)
- Slip/slide tools & dedicated ripple-delete button (move/trim/split/duplicate done)
- Waveform & thumbnail rendering inside timeline clips
- Per-word caption dragging; caption keyframe animations
- Crop/border/shadow/tint per-object controls (position/scale/rotation/opacity/flip done)
- Cloud sync, YouTube/TikTok/Instagram upload, AI thumbnail/title/SEO generators

## 👉 Recommended Next Steps
1. Timeline clip thumbnails + audio waveform cache
2. Proxy (low-res) preview transcoding for very large source videos
3. Custom caption template creator UI (save unlimited user templates)
4. Slip/slide edit modes + ripple delete + dynamic track add/remove UI
5. Optional quality/bitrate selector in the Export view

## 🧭 The Workflow
1. Upload VTuber green-screen video (defaults auto-applied)
2. Pick/upload a background (library persists forever)
3. **Analyze with AI Director** (Gemini) → scenes, scores, hook, materials
4. Resolve the **Materials Needed** queue (Search / Upload / Skip)
5. **Generate Timeline** — fully built automatically
6. Fine-tune anything manually (timeline, captions, chroma, audio)
7. Export MP4 (H.264) / Premiere Package (XML + Media) / FCPXML / `.vtproject`
