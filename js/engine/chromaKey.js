/**
 * chromaKey.js — high-performance GPU chroma key (WebGL).
 * No AI segmentation; classic keying with tolerance, softness, spill, feather, blur.
 */
const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = vec2(aPos.x * .5 + .5, .5 - aPos.y * .5);
  gl_Position = vec4(aPos, 0., 1.);
}`;

const FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec3 uKey;        // key color RGB
uniform float uTolerance; // 0..1
uniform float uSoftness;  // 0..1
uniform float uSpill;     // 0..1
uniform float uFeather;   // px-ish 0..1
uniform float uBlur;      // 0..1
uniform vec2 uTexel;

vec2 rgb2uv(vec3 c) {
  return vec2(
    c.r * -0.169 + c.g * -0.331 + c.b * 0.5 + 0.5,
    c.r * 0.5 + c.g * -0.419 + c.b * -0.081 + 0.5
  );
}

float keyDist(vec3 c) {
  return distance(rgb2uv(c), rgb2uv(uKey));
}

void main() {
  vec4 col = texture2D(uTex, vUV);
  float d = keyDist(col.rgb);

  // feather: average distance of neighbours for smoother matte edge
  if (uFeather > 0.001) {
    float acc = d;
    float r = uFeather * 3.0;
    acc += keyDist(texture2D(uTex, vUV + vec2( uTexel.x * r, 0.)).rgb);
    acc += keyDist(texture2D(uTex, vUV + vec2(-uTexel.x * r, 0.)).rgb);
    acc += keyDist(texture2D(uTex, vUV + vec2(0.,  uTexel.y * r)).rgb);
    acc += keyDist(texture2D(uTex, vUV + vec2(0., -uTexel.y * r)).rgb);
    d = acc / 5.0;
  }

  float t0 = uTolerance * 0.45;
  float t1 = t0 + max(uSoftness * 0.35, 0.001);
  float alpha = smoothstep(t0, t1, d);

  // spill removal — desaturate towards luminance where key color leaks
  float spillMask = 1.0 - smoothstep(t0, t1 + 0.15, d);
  float luma = dot(col.rgb, vec3(0.299, 0.587, 0.114));
  vec3 despilled = mix(col.rgb, vec3(luma), spillMask * uSpill);

  // optional edge blur on matte
  if (uBlur > 0.001) {
    float b = uBlur * 2.5;
    float a2 = alpha;
    a2 += smoothstep(t0, t1, keyDist(texture2D(uTex, vUV + vec2(uTexel.x*b, uTexel.y*b)).rgb));
    a2 += smoothstep(t0, t1, keyDist(texture2D(uTex, vUV - vec2(uTexel.x*b, uTexel.y*b)).rgb));
    a2 += smoothstep(t0, t1, keyDist(texture2D(uTex, vUV + vec2(-uTexel.x*b, uTexel.y*b)).rgb));
    a2 += smoothstep(t0, t1, keyDist(texture2D(uTex, vUV + vec2(uTexel.x*b, -uTexel.y*b)).rgb));
    alpha = a2 / 5.0;
  }

  gl_FragColor = vec4(despilled * alpha, col.a * alpha); // premultiplied
}`;

export class ChromaKeyer {
  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.u = {};
    for (const n of ['uKey', 'uTolerance', 'uSoftness', 'uSpill', 'uFeather', 'uBlur', 'uTexel']) {
      this.u[n] = gl.getUniformLocation(prog, n);
    }
  }

  /**
   * Key out the color from a video/image source, returns internal canvas.
   * @param {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement} source
   * @param {object} p chroma params {keyColor,tolerance,softness,spill,feather,blur}
   */
  process(source, p) {
    const gl = this.gl;
    const w = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    if (!w || !h) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const key = hexToRgb(p.keyColor || '#00ff00');
    gl.uniform3f(this.u.uKey, key[0], key[1], key[2]);
    gl.uniform1f(this.u.uTolerance, p.tolerance ?? 0.3);
    gl.uniform1f(this.u.uSoftness, p.softness ?? 0.1);
    gl.uniform1f(this.u.uSpill, p.spill ?? 0.5);
    gl.uniform1f(this.u.uFeather, p.feather ?? 0);
    gl.uniform1f(this.u.uBlur, p.blur ?? 0);
    gl.uniform2f(this.u.uTexel, 1 / w, 1 / h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  return [parseInt(m.slice(0, 2), 16) / 255, parseInt(m.slice(2, 4), 16) / 255, parseInt(m.slice(4, 6), 16) / 255];
}

/**
 * CpuChromaKeyer — pure Canvas2D fallback when WebGL is unavailable.
 * Same YUV-distance algorithm as the shader (tolerance, softness, spill).
 */
export class CpuChromaKeyer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }
  process(source, p) {
    const w = source.videoWidth || source.naturalWidth || source.width;
    const h = source.videoHeight || source.naturalHeight || source.height;
    if (!w || !h) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.drawImage(source, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const key = hexToRgb(p.keyColor || '#00ff00');
    const kU = key[0] * -0.169 + key[1] * -0.331 + key[2] * 0.5 + 0.5;
    const kV = key[0] * 0.5 + key[1] * -0.419 + key[2] * -0.081 + 0.5;
    const t0 = (p.tolerance ?? 0.3) * 0.45;
    const t1 = t0 + Math.max((p.softness ?? 0.1) * 0.35, 0.001);
    const spill = p.spill ?? 0.5;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const u = r * -0.169 + g * -0.331 + b * 0.5 + 0.5;
      const v = r * 0.5 + g * -0.419 + b * -0.081 + 0.5;
      const dist = Math.hypot(u - kU, v - kV);
      let alpha = (dist - t0) / (t1 - t0);
      alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha * alpha * (3 - 2 * alpha); // smoothstep
      if (alpha < 1 && spill > 0) {
        const sm = (1 - Math.min(1, Math.max(0, (dist - t0) / (t1 + 0.15 - t0)))) * spill;
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        d[i]     = Math.round((r + (luma - r) * sm) * 255);
        d[i + 1] = Math.round((g + (luma - g) * sm) * 255);
        d[i + 2] = Math.round((b + (luma - b) * sm) * 255);
      }
      d[i + 3] = Math.round(d[i + 3] * alpha);
    }
    this.ctx.putImageData(img, 0, 0);
    return this.canvas;
  }
}
