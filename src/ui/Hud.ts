import type { Cop, Spike } from '../systems/PoliceSystem';
import type { Helicopter } from '../entities/Helicopter';
import type { Vehicle } from '../entities/Vehicle';
import type { CityLayout } from '../world/CityLayout';
import { HIGHWAY, RIVER, HILL } from '../game/config';

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface HudState {
  time: number;
  score: number;
  cash: number;
  takedowns: number;
  stars: number;
  heatLabel: string;
  evading: boolean;
  health: number;
  nitro: number;
  speedKmh: number;
  boosting: boolean;
  busted: number; // 0..1
}

/** DOM HUD: survival clock, score, wanted stars, radar, bars, speedometer, toasts. */
export class Hud {
  private readonly root = $('hud');
  private readonly time = $('hud-time');
  private readonly score = $('hud-score');
  private readonly cash = $('hud-cash');
  private readonly takedowns = $('hud-takedowns');
  private readonly stars = $('stars');
  private readonly heat = $('heat-label');
  private readonly evade = $('evade-label');
  private readonly healthFill = $('health-fill');
  private readonly nitroFill = $('nitro-fill');
  private readonly speed = $('hud-speed');
  private readonly speedo = $('speedo');
  private readonly busted = $('busted-meter');
  private readonly bustedFill = $('busted-fill');
  private readonly toasts = $('toasts');
  private readonly hit = $('hit-flash');
  private readonly mapCanvas = $('minimap') as HTMLCanvasElement;
  private readonly map: CanvasRenderingContext2D;
  private readonly mapBase: HTMLCanvasElement;
  private lastStars = 0;
  private last: Partial<HudState> = {};
  private readonly starEls: HTMLElement[] = [];

  constructor(private readonly layout: CityLayout) {
    for (let i = 0; i < 5; i += 1) {
      const s = document.createElement('div');
      s.className = 'star';
      this.stars.appendChild(s);
      this.starEls.push(s);
    }
    this.map = this.mapCanvas.getContext('2d')!;
    this.mapBase = this.renderMapBase();
  }

  show(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  private set(el: HTMLElement, key: keyof HudState, text: string, value: unknown): void {
    if (this.last[key] === value) return;
    (this.last as Record<string, unknown>)[key] = value;
    el.textContent = text;
  }

  update(s: HudState): void {
    this.set(this.time, 'time', formatTime(s.time), Math.floor(s.time));
    this.set(this.score, 'score', s.score.toLocaleString('en-US'), s.score);
    this.set(this.cash, 'cash', `$${s.cash.toLocaleString('en-US')}`, s.cash);
    this.set(this.takedowns, 'takedowns', String(s.takedowns), s.takedowns);
    this.set(this.speed, 'speedKmh', String(Math.round(s.speedKmh)), Math.round(s.speedKmh));
    this.set(this.heat, 'heatLabel', s.heatLabel, s.heatLabel);
    if (s.stars !== this.lastStars) {
      this.starEls.forEach((el, i) => {
        el.classList.toggle('on', i < s.stars);
        el.classList.remove('flash');
        if (i < s.stars && i >= this.lastStars) {
          void el.offsetWidth;
          el.classList.add('flash');
        }
      });
      this.lastStars = s.stars;
    }
    this.stars.classList.toggle('evading', s.evading);
    this.evade.classList.toggle('hidden', !s.evading);
    this.healthFill.style.transform = `scaleX(${Math.max(0, s.health)})`;
    this.healthFill.parentElement!.classList.toggle('low', s.health < 0.3);
    this.nitroFill.style.transform = `scaleX(${Math.max(0, s.nitro)})`;
    this.speedo.classList.toggle('boost', s.boosting);
    this.busted.classList.toggle('hidden', s.busted <= 0.02);
    this.bustedFill.style.transform = `scaleX(${s.busted})`;
  }

  resetStars(): void {
    this.lastStars = -1;
    this.last = {};
  }

  toast(text: string, kind: '' | 'big' | 'good' | 'blue' = '', life = 2.2): void {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.style.setProperty('--life', `${life}s`);
    t.textContent = text;
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    window.setTimeout(() => t.remove(), (life + 0.5) * 1000);
  }

  clearToasts(): void {
    this.toasts.replaceChildren();
  }

  flashHit(strength: number): void {
    this.hit.style.transition = 'none';
    this.hit.style.opacity = String(Math.min(1, strength));
    void this.hit.offsetWidth;
    this.hit.style.transition = 'opacity 0.5s ease-out';
    this.hit.style.opacity = '0';
  }

  // ------------------------------------------------------------ minimap
  private readonly worldSize = 540;
  private readonly baseRes = 1080;

  private renderMapBase(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.baseRes;
    c.height = this.baseRes;
    const ctx = c.getContext('2d')!;
    const k = this.baseRes / this.worldSize;
    const tx = (x: number) => (x + this.worldSize / 2) * k;
    const tz = (z: number) => (z + this.worldSize / 2) * k;
    ctx.fillStyle = '#10131c';
    ctx.fillRect(0, 0, c.width, c.height);
    // blocks
    for (const b of this.layout.blocks) {
      ctx.fillStyle = b.type === 'park' ? '#1d3b25' : b.type === 'plaza' ? '#3a3328' : b.type === 'hill' ? '#22351f' : '#232838';
      if (b.type !== 'river') ctx.fillRect(tx(b.x0), tz(b.z0), (b.x1 - b.x0) * k, (b.z1 - b.z0) * k);
    }
    for (const l of this.layout.lots) {
      ctx.fillStyle = '#2f3548';
      ctx.fillRect(tx(l.x0), tz(l.z0), (l.x1 - l.x0) * k, (l.z1 - l.z0) * k);
    }
    // river
    ctx.fillStyle = '#123a5c';
    ctx.fillRect(tx(RIVER.x - RIVER.halfWidth), tz(-this.worldSize / 2), RIVER.halfWidth * 2 * k, this.worldSize * k);
    // roads
    ctx.lineCap = 'square';
    for (const r of this.layout.roads) {
      ctx.strokeStyle = r.kind === 'tunnel' ? '#6b5a3a' : r.kind === 'bridge' ? '#8a9bb0' : '#5b6275';
      ctx.lineWidth = r.width * k;
      if (r.kind === 'highway' || r.kind === 'ramp') continue;
      ctx.beginPath();
      ctx.moveTo(tx(r.ax), tz(r.az));
      ctx.lineTo(tx(r.bx), tz(r.bz));
      ctx.stroke();
    }
    // highway drawn on top, bright
    ctx.strokeStyle = '#c9a54a';
    ctx.lineWidth = HIGHWAY.width * k * 0.7;
    ctx.beginPath();
    ctx.moveTo(tx(-HIGHWAY.rampEnd), tz(HIGHWAY.z));
    ctx.lineTo(tx(HIGHWAY.rampEnd), tz(HIGHWAY.z));
    ctx.stroke();
    // tunnel dashes
    ctx.strokeStyle = 'rgba(255,190,90,0.7)';
    ctx.setLineDash([10, 8]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tx(HILL.x0), tz(HILL.tunnelZ));
    ctx.lineTo(tx(HILL.x1), tz(HILL.tunnelZ));
    ctx.stroke();
    ctx.setLineDash([]);
    return c;
  }

  drawMap(player: Vehicle, cops: Cop[], helis: Helicopter[], spikes: Spike[], pickups: { x: number; z: number; type: string }[], elapsed: number): void {
    const ctx = this.map;
    const W = this.mapCanvas.width;
    const R = W / 2;
    const scale = 1.25; // map px per meter
    ctx.save();
    ctx.clearRect(0, 0, W, W);
    ctx.beginPath();
    ctx.arc(R, R, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(R, R + 28);
    // rotate so the player's heading points up
    ctx.rotate(Math.PI + player.heading);
    const k = this.baseRes / this.worldSize;
    ctx.scale(scale / k, scale / k);
    ctx.translate(-(player.position.x + this.worldSize / 2) * k, -(player.position.z + this.worldSize / 2) * k);
    ctx.drawImage(this.mapBase, 0, 0);
    ctx.restore();

    const toScreen = (x: number, z: number): [number, number] => {
      const dx = x - player.position.x;
      const dz = z - player.position.z;
      const a = Math.PI + player.heading;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const sx = (dx * c - dz * s) * scale;
      const sz = (dx * s + dz * c) * scale;
      return [R + sx, R + 28 + sz];
    };
    const clampEdge = (p: [number, number]): [number, number, boolean] => {
      const dx = p[0] - R;
      const dy = p[1] - R;
      const d = Math.hypot(dx, dy);
      const max = R - 9;
      if (d > max) return [R + (dx / d) * max, R + (dy / d) * max, true];
      return [p[0], p[1], false];
    };

    for (const it of pickups) {
      const [x, y, edge] = clampEdge(toScreen(it.x, it.z));
      if (edge) continue;
      ctx.fillStyle = it.type === 'cash' ? '#4dff88' : it.type === 'repair' ? '#ff6655' : '#56c8ff';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const s of spikes) {
      const [x, y] = clampEdge(toScreen(s.x, s.z));
      ctx.fillStyle = '#ffa21a';
      ctx.fillRect(x - 5, y - 2, 10, 4);
    }
    const blink = Math.sin(elapsed * 10) > 0;
    for (const c of cops) {
      if (c.mode === 'wreck') continue;
      const [x, y, edge] = clampEdge(toScreen(c.v.position.x, c.v.position.z));
      ctx.fillStyle = blink ? '#ff3b4e' : '#3d7bff';
      const big = c.v.kind === 'swat' || c.v.kind === 'apc';
      ctx.beginPath();
      ctx.arc(x, y, edge ? 3.5 : big ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (!edge) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    for (const h of helis) {
      if (!h.active) continue;
      const [x, y] = clampEdge(toScreen(h.aim.x, h.aim.z));
      ctx.strokeStyle = h.spotted ? 'rgba(255,255,255,0.95)' : 'rgba(200,220,255,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, h.spotRadius * scale, 0, Math.PI * 2);
      ctx.stroke();
      const [hx, hy] = clampEdge(toScreen(h.position.x, h.position.z));
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✈', hx, hy);
    }
    // player arrow
    ctx.save();
    ctx.translate(R, R + 28);
    ctx.fillStyle = '#ffcc1a';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(7, 8);
    ctx.lineTo(0, 4);
    ctx.lineTo(-7, 8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (player.onDeck) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(R - 34, W - 26, 68, 18);
      ctx.fillStyle = '#ffcc1a';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('고가도로', R, W - 16);
    }
  }
}
