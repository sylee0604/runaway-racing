import * as THREE from 'three';
import { createSeededRandom } from '../utils/random';

const rng = createSeededRandom(99);

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [c, ctx];
}

function finish(c: HTMLCanvasElement, srgb = true, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, count: number, alpha: number, light = false): void {
  for (let i = 0; i < count; i += 1) {
    const v = light ? 200 + rng() * 55 : rng() * 60;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * rng()})`;
    const s = 1 + rng() * 2.5;
    ctx.fillRect(rng() * w, rng() * h, s, s);
  }
}

/** Asphalt road tile: u spans road width (16m), v spans 16m of length. */
export function roadTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#26272b';
  ctx.fillRect(0, 0, 512, 512);
  noise(ctx, 512, 512, 9000, 0.35);
  noise(ctx, 512, 512, 2500, 0.08, true);
  // tyre tracks
  ctx.fillStyle = 'rgba(10,10,12,0.25)';
  for (const x of [56, 104, 160, 208, 304, 352, 408, 456]) ctx.fillRect(x - 12, 0, 24, 512);
  // edge lines
  ctx.fillStyle = '#d9d6cc';
  ctx.fillRect(10, 0, 6, 512);
  ctx.fillRect(496, 0, 6, 512);
  // centre double yellow
  ctx.fillStyle = '#e8b221';
  ctx.fillRect(248, 0, 5, 512);
  ctx.fillRect(259, 0, 5, 512);
  // lane dashes
  ctx.fillStyle = '#d9d6cc';
  for (const x of [128, 384]) {
    ctx.fillRect(x - 3, 40, 6, 170);
    ctx.fillRect(x - 3, 296, 6, 170);
  }
  // cracks / patches
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 14; i += 1) {
    ctx.beginPath();
    let x = rng() * 512;
    let y = rng() * 512;
    ctx.moveTo(x, y);
    for (let k = 0; k < 6; k += 1) {
      x += (rng() - 0.5) * 40;
      y += (rng() - 0.5) * 40;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return finish(c);
}

export function intersectionTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#25262a';
  ctx.fillRect(0, 0, 512, 512);
  noise(ctx, 512, 512, 9000, 0.35);
  ctx.fillStyle = '#d9d6cc';
  // zebra crossings on all four sides
  for (let k = 0; k < 9; k += 1) {
    const p = 40 + k * 50;
    ctx.fillRect(p, 6, 26, 46);
    ctx.fillRect(p, 460, 26, 46);
    ctx.fillRect(6, p, 46, 26);
    ctx.fillRect(460, p, 46, 26);
  }
  return finish(c, true, false);
}

export function sidewalkTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#5a5a5f';
  ctx.fillRect(0, 0, 256, 256);
  noise(ctx, 256, 256, 4000, 0.25);
  ctx.strokeStyle = 'rgba(25,25,30,0.6)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 256);
    ctx.moveTo(0, i);
    ctx.lineTo(256, i);
    ctx.stroke();
  }
  return finish(c);
}

export function plazaTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 512);
  ctx.fillStyle = '#6b6258';
  ctx.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 32) {
    for (let x = 0; x < 512; x += 32) {
      const v = 90 + rng() * 40;
      ctx.fillStyle = `rgb(${v + 10},${v},${v - 8})`;
      ctx.fillRect(x + 1, y + 1, 30, 30);
    }
  }
  noise(ctx, 512, 512, 5000, 0.2);
  ctx.strokeStyle = 'rgba(210,180,120,0.5)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(256, 256, 200, 0, Math.PI * 2);
  ctx.stroke();
  return finish(c);
}

export function grassTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#1f3a22';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 6000; i += 1) {
    const g = 50 + rng() * 60;
    ctx.fillStyle = `rgba(${g * 0.5},${g},${g * 0.45},0.6)`;
    ctx.fillRect(rng() * 256, rng() * 256, 1.5, 3);
  }
  return finish(c);
}

export function concreteTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#7a7b80';
  ctx.fillRect(0, 0, 256, 256);
  noise(ctx, 256, 256, 6000, 0.3);
  noise(ctx, 256, 256, 1500, 0.12, true);
  ctx.fillStyle = 'rgba(30,30,35,0.25)';
  for (let i = 0; i < 6; i += 1) ctx.fillRect(0, rng() * 256, 256, 2);
  // drip stains
  for (let i = 0; i < 30; i += 1) {
    ctx.fillStyle = `rgba(40,38,36,${0.05 + rng() * 0.12})`;
    ctx.fillRect(rng() * 256, 0, 2 + rng() * 6, 60 + rng() * 190);
  }
  return finish(c);
}

export function rockTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#3d3a36';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 300; i += 1) {
    const v = 40 + rng() * 50;
    ctx.fillStyle = `rgba(${v},${v * 0.96},${v * 0.9},0.5)`;
    ctx.beginPath();
    ctx.ellipse(rng() * 256, rng() * 256, 4 + rng() * 16, 3 + rng() * 9, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  noise(ctx, 256, 256, 3000, 0.3);
  return finish(c);
}

export interface FacadeSet {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
  /** meters covered by one texture repeat horizontally / vertically */
  tileW: number;
  tileH: number;
}

const FACADE_STYLES = [
  { wall: '#3a3f4a', frame: '#23262d', glass: '#1a2433', lit: ['#ffd8a0', '#fff1d0', '#ffe2b0'], cols: 4, rows: 4, litChance: 0.45 },
  { wall: '#5b4a3f', frame: '#33281f', glass: '#1d1a1a', lit: ['#ffc888', '#ffb870'], cols: 3, rows: 4, litChance: 0.4 },
  { wall: '#2b3a46', frame: '#16222b', glass: '#10283a', lit: ['#bfe3ff', '#e6f4ff', '#9fd0ff'], cols: 6, rows: 6, litChance: 0.55 },
  { wall: '#6f6a62', frame: '#4b4740', glass: '#22252b', lit: ['#fff0c8', '#ffe0a8'], cols: 4, rows: 5, litChance: 0.35 },
  { wall: '#262a33', frame: '#111318', glass: '#0e1a28', lit: ['#a8f0ff', '#ffd0f0', '#fff'], cols: 8, rows: 8, litChance: 0.5 },
  { wall: '#4a3b4f', frame: '#2a2130', glass: '#1a1424', lit: ['#ffd0a0', '#ff9fd0', '#fff2e0'], cols: 4, rows: 4, litChance: 0.45 },
];

export const FACADE_COUNT = FACADE_STYLES.length;

/** Window facade texture pair (albedo + emissive). One repeat = cols×4m wide, rows×3.6m tall. */
export function facadeTextures(style: number): FacadeSet {
  const st = FACADE_STYLES[style % FACADE_STYLES.length];
  const W = 256;
  const H = 256;
  const [c, ctx] = canvas(W, H);
  const [e, ectx] = canvas(W, H);
  ctx.fillStyle = st.wall;
  ctx.fillRect(0, 0, W, H);
  noise(ctx, W, H, 2500, 0.18);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, W, H);
  const cw = W / st.cols;
  const rh = H / st.rows;
  for (let r = 0; r < st.rows; r += 1) {
    for (let k = 0; k < st.cols; k += 1) {
      const x = k * cw + cw * 0.14;
      const y = r * rh + rh * 0.2;
      const w = cw * 0.72;
      const h = rh * 0.58;
      ctx.fillStyle = st.frame;
      ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
      ctx.fillStyle = st.glass;
      ctx.fillRect(x, y, w, h);
      // subtle reflection streak
      ctx.fillStyle = 'rgba(160,190,230,0.08)';
      ctx.fillRect(x, y, w * 0.35, h);
      if (rng() < st.litChance) {
        const col = st.lit[Math.floor(rng() * st.lit.length)];
        const g = ectx.createLinearGradient(x, y, x, y + h);
        g.addColorStop(0, col);
        g.addColorStop(1, 'rgba(80,60,40,0.6)');
        ectx.globalAlpha = 0.45 + rng() * 0.55;
        ectx.fillStyle = g;
        ectx.fillRect(x, y, w, h);
        // blinds / silhouettes
        if (rng() < 0.4) {
          ectx.fillStyle = 'rgba(0,0,0,0.55)';
          ectx.fillRect(x, y, w, h * (0.2 + rng() * 0.5));
        }
        ectx.globalAlpha = 1;
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(x, y, w, h);
        ctx.globalAlpha = 1;
      }
    }
    // floor slab line
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, r * rh, W, 3);
  }
  return { map: finish(c), emissive: finish(e), tileW: st.cols * 2.8, tileH: st.rows * 3.4 };
}

export function roofTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#2c2d31';
  ctx.fillRect(0, 0, 256, 256);
  noise(ctx, 256, 256, 5000, 0.3);
  ctx.strokeStyle = 'rgba(70,70,76,0.6)';
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, 248, 248);
  return finish(c);
}

/** Soft radial glow used for lamp light pools, headlight splashes and sprites. */
export function glowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, inner.replace(/[\d.]+\)$/, '0.45)'));
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return finish(c, true, false);
}

export function smokeTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  for (let i = 0; i < 18; i += 1) {
    const x = 34 + rng() * 60;
    const y = 34 + rng() * 60;
    const r = 18 + rng() * 26;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
  }
  return finish(c, true, false);
}

export function waterNormalTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  const img = ctx.createImageData(256, 256);
  for (let y = 0; y < 256; y += 1) {
    for (let x = 0; x < 256; x += 1) {
      const a = Math.sin((x / 256) * Math.PI * 8 + Math.sin((y / 256) * Math.PI * 6) * 1.5);
      const b = Math.cos((y / 256) * Math.PI * 10 + Math.sin((x / 256) * Math.PI * 4) * 2);
      const i = (y * 256 + x) * 4;
      img.data[i] = 128 + a * 50;
      img.data[i + 1] = 128 + b * 50;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(c, false);
}

export function chevronTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(128, 128);
  ctx.fillStyle = '#f2c230';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#151515';
  for (let i = -128; i < 256; i += 40) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 20, 0);
    ctx.lineTo(i + 20 + 128, 128);
    ctx.lineTo(i + 128, 128);
    ctx.closePath();
    ctx.fill();
  }
  return finish(c);
}

/** Neon sign texture with text, emissive-ready. */
export function neonSignTexture(text: string, color: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(512, 128);
  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, 512, 128);
  ctx.font = 'bold 78px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = 24;
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 68);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.6;
  ctx.fillText(text, 256, 68);
  return finish(c, true, false);
}

export function skyTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(32, 512);
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#04050c');
  g.addColorStop(0.42, '#0d1230');
  g.addColorStop(0.5, '#2a2346');
  g.addColorStop(0.53, '#5a3550');
  g.addColorStop(0.56, '#1a1626');
  g.addColorStop(1, '#0a0a10');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 512);
  return finish(c, true, false);
}
