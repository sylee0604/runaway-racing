import * as THREE from 'three';
import type { Vehicle } from '../entities/Vehicle';
import type { CityLayout, Surface } from '../world/CityLayout';

export interface ImpactEvent {
  a: Vehicle;
  b: Vehicle | null; // null = static world
  impact: number; // closing speed m/s
  x: number;
  y: number;
  z: number;
}

const RESTITUTION_WALL = 0.22;
const RESTITUTION_CAR = 0.35;

/** Custom arcade collision: car circles vs world AABBs / solid ramps, and car vs car. */
export class Physics {
  private readonly scratch: number[] = [];
  private readonly c = new THREE.Vector2();
  private readonly c2 = new THREE.Vector2();
  readonly events: ImpactEvent[] = [];
  private readonly solidSurfaces: Surface[];

  constructor(private readonly layout: CityLayout) {
    this.solidSurfaces = layout.surfaces;
  }

  resolveStatic(v: Vehicle): void {
    const r = v.spec.radius;
    for (const idx of [0, 1] as const) {
      v.circle(idx, this.c);
      // boxes
      this.layout.queryBoxes(this.c.x, this.c.y, r + 1, this.scratch);
      for (const bi of this.scratch) {
        const b = this.layout.boxes[bi];
        if (v.position.y >= b.y1 - 0.2 || v.position.y + 1.4 <= b.y0) continue;
        this.pushOut(v, b.x0, b.z0, b.x1, b.z1, r);
        v.circle(idx, this.c);
      }
      // solid surfaces too high to climb (ramp undersides, kicker lips)
      for (const s of this.solidSurfaces) {
        const cx = THREE.MathUtils.clamp(this.c.x, s.x0, s.x1);
        const cz = THREE.MathUtils.clamp(this.c.y, s.z0, s.z1);
        const dx = this.c.x - cx;
        const dz = this.c.y - cz;
        if (dx * dx + dz * dz > r * r) continue;
        const h = this.layout.surfaceHeight(s, cx, cz);
        if (h <= v.position.y + 1.3) continue;
        if (!s.solid && v.position.y + 2.4 <= h - s.thickness) continue;
        this.pushOut(v, s.x0, s.z0, s.x1, s.z1, r);
        v.circle(idx, this.c);
      }
    }
  }

  private pushOut(v: Vehicle, x0: number, z0: number, x1: number, z1: number, r: number): void {
    const px = this.c.x;
    const pz = this.c.y;
    let nx = 0;
    let nz = 0;
    let pen = 0;
    if (px > x0 && px < x1 && pz > z0 && pz < z1) {
      // inside: push along the shallowest axis
      const l = px - x0;
      const rr = x1 - px;
      const d = pz - z0;
      const u = z1 - pz;
      const m = Math.min(l, rr, d, u);
      if (m === l) {
        nx = -1;
        pen = l + r;
      } else if (m === rr) {
        nx = 1;
        pen = rr + r;
      } else if (m === d) {
        nz = -1;
        pen = d + r;
      } else {
        nz = 1;
        pen = u + r;
      }
    } else {
      const cx = Math.max(x0, Math.min(px, x1));
      const cz = Math.max(z0, Math.min(pz, z1));
      const dx = px - cx;
      const dz = pz - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      const d = Math.sqrt(d2) || 0.0001;
      nx = dx / d;
      nz = dz / d;
      pen = r - d;
    }
    v.position.x += nx * pen;
    v.position.z += nz * pen;
    const vn = v.velocity.x * nx + v.velocity.y * nz;
    if (vn < 0) {
      v.velocity.x -= (1 + RESTITUTION_WALL) * vn * nx;
      v.velocity.y -= (1 + RESTITUTION_WALL) * vn * nz;
      // scrape friction
      const tx = -nz;
      const tz = nx;
      const vt = v.velocity.x * tx + v.velocity.y * tz;
      const keep = 0.94;
      v.velocity.x -= vt * (1 - keep) * tx;
      v.velocity.y -= vt * (1 - keep) * tz;
      const impact = -vn;
      if (impact > 2) {
        this.events.push({ a: v, b: null, impact, x: this.c.x - nx * 0.2, y: v.position.y + 0.6, z: this.c.y - nz * 0.2 });
      }
    }
  }

  resolvePairs(vehicles: Vehicle[]): void {
    for (let i = 0; i < vehicles.length; i += 1) {
      const a = vehicles[i];
      for (let j = i + 1; j < vehicles.length; j += 1) {
        const b = vehicles[j];
        const dx0 = a.position.x - b.position.x;
        const dz0 = a.position.z - b.position.z;
        const reach = a.spec.halfLength + b.spec.halfLength + a.spec.radius + b.spec.radius;
        if (dx0 * dx0 + dz0 * dz0 > reach * reach) continue;
        if (Math.abs(a.position.y - b.position.y) > 2) continue;
        for (const ia of [0, 1] as const) {
          for (const ib of [0, 1] as const) {
            a.circle(ia, this.c);
            b.circle(ib, this.c2);
            const dx = this.c2.x - this.c.x;
            const dz = this.c2.y - this.c.y;
            const rr = a.spec.radius + b.spec.radius;
            const d2 = dx * dx + dz * dz;
            if (d2 >= rr * rr || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            const nx = dx / d;
            const nz = dz / d;
            const pen = rr - d;
            const ma = a.spec.mass;
            const mb = b.spec.mass;
            const wa = mb / (ma + mb);
            const wb = ma / (ma + mb);
            a.position.x -= nx * pen * wa;
            a.position.z -= nz * pen * wa;
            b.position.x += nx * pen * wb;
            b.position.z += nz * pen * wb;
            const rvx = b.velocity.x - a.velocity.x;
            const rvz = b.velocity.y - a.velocity.y;
            const vrel = rvx * nx + rvz * nz;
            if (vrel < 0) {
              const jimp = (-(1 + RESTITUTION_CAR) * vrel) / (1 / ma + 1 / mb);
              a.velocity.x -= (jimp / ma) * nx;
              a.velocity.y -= (jimp / ma) * nz;
              b.velocity.x += (jimp / mb) * nx;
              b.velocity.y += (jimp / mb) * nz;
              // a little yaw kick so hits spin cars out
              const side = Math.sign(nx * Math.cos(a.heading) - nz * Math.sin(a.heading));
              a.heading += side * Math.min(0.5, -vrel * 0.012) * wa;
              b.heading -= side * Math.min(0.5, -vrel * 0.012) * wb;
              if (-vrel > 2) {
                this.events.push({ a, b, impact: -vrel, x: this.c.x + nx * a.spec.radius, y: (a.position.y + b.position.y) / 2 + 0.7, z: this.c.y + nz * a.spec.radius });
              }
            }
          }
        }
      }
    }
  }
}
