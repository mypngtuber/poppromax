/** utils.js — shared helpers */
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function fmtTime(sec, fps = 30) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const f = Math.floor((sec - Math.floor(sec)) * fps);
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}
export function fmtDur(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
export function fmtDate(ts) { return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
export function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}
export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function throttle(fn, ms) {
  let last = 0, t;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last)); }
  };
}

/** Simple local obfuscation for API keys (client-side only; never sent anywhere). */
const XOR_SALT = 'vt-editor-local-key-v1';
export function encryptLocal(text) {
  const out = [...text].map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ XOR_SALT.charCodeAt(i % XOR_SALT.length)));
  return btoa(unescape(encodeURIComponent(out.join(''))));
}
export function decryptLocal(enc) {
  try {
    const raw = decodeURIComponent(escape(atob(enc)));
    return [...raw].map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ XOR_SALT.charCodeAt(i % XOR_SALT.length))).join('');
  } catch { return ''; }
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

/** Probe media duration/dimensions from a blob.
 * Handles the Infinity-duration bug of recorded WebM files (OBS/MediaRecorder):
 * seeking to a huge time forces the browser to compute the real duration. */
export function probeMedia(blob, kind) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const done = (meta) => { URL.revokeObjectURL(url); resolve(meta); };
    if (kind === 'video') {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => {
        if (!isFinite(v.duration) || v.duration === 0) {
          // Infinity-duration hack: seek far, wait for real duration
          const timer = setTimeout(() => done({ duration: 0, width: v.videoWidth, height: v.videoHeight }), 4000);
          v.ondurationchange = () => {
            if (isFinite(v.duration) && v.duration > 0) {
              clearTimeout(timer);
              done({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
            }
          };
          v.currentTime = 1e7;
        } else {
          done({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
        }
      };
      v.onerror = () => done({ duration: 0, width: 0, height: 0 });
      v.src = url;
    } else if (kind === 'audio') {
      const a = new Audio();
      a.preload = 'metadata';
      a.onloadedmetadata = () => {
        if (!isFinite(a.duration) || a.duration === 0) {
          const timer = setTimeout(() => done({ duration: 0 }), 4000);
          a.ondurationchange = () => {
            if (isFinite(a.duration) && a.duration > 0) { clearTimeout(timer); done({ duration: a.duration }); }
          };
          a.currentTime = 1e7;
        } else done({ duration: a.duration });
      };
      a.onerror = () => done({ duration: 0 });
      a.src = url;
    } else {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight, duration: 0 });
      img.onerror = () => done({ width: 0, height: 0, duration: 0 });
      img.src = url;
    }
  });
}

export function kindFromMime(type) {
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'image/gif') return 'gif';
  if (type.startsWith('image/')) return 'image';
  return 'other';
}
