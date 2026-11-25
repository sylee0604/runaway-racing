import * as THREE from 'three';

export type V3 = [number, number, number];

/** Accumulates quads into a single indexed BufferGeometry (one draw call per material). */
export class Batch {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];
  private readonly idx: number[] = [];
  private readonly col: number[] = [];
  private readonly withColor: boolean;

  constructor(withColor = false) {
    this.withColor = withColor;
  }

  get empty(): boolean {
    return this.pos.length === 0;
  }

  /** a,b,c,d counter-clockwise when viewed from the visible side. */
  quad(a: V3, b: V3, c: V3, d: V3, uvs: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]], color?: THREE.Color): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.pos.length / 3;
    for (const [p, t] of [[a, uvs[0]], [b, uvs[1]], [c, uvs[2]], [d, uvs[3]]] as [V3, [number, number]][]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.uv.push(t[0], t[1]);
      if (this.withColor) {
        const cc = color ?? new THREE.Color(1, 1, 1);
        this.col.push(cc.r, cc.g, cc.b);
      }
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Horizontal quad facing up spanning an arbitrary convex 4-gon, ordering fixed automatically. */
  upQuad(a: V3, b: V3, c: V3, d: V3, uvs?: [number, number][]): void {
    const ux = b[0] - a[0];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vz = d[2] - a[2];
    const ny = uz * vx - ux * vz;
    if (ny >= 0) this.quad(a, b, c, d, uvs);
    else this.quad(a, d, c, b, uvs ? [uvs[0], uvs[3], uvs[2], uvs[1]] : undefined);
  }

  /** Box with world-scaled UVs. uScale/vScale are meters per texture repeat. */
  box(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    opts: { uScale?: number; vScale?: number; top?: boolean; bottom?: boolean; sides?: boolean; color?: THREE.Color; topScale?: number } = {},
  ): void {
    const us = opts.uScale ?? 4;
    const vs = opts.vScale ?? 4;
    const c = opts.color;
    if (opts.sides !== false) {
      const w = (x1 - x0) / us;
      const d = (z1 - z0) / us;
      const v0 = y0 / vs;
      const v1 = y1 / vs;
      const ox = x0 / us;
      const oz = z0 / us;
      this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [[oz, v0], [oz + d, v0], [oz + d, v1], [oz, v1]], c);
      this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [[oz, v0], [oz + d, v0], [oz + d, v1], [oz, v1]], c);
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [[ox, v0], [ox + w, v0], [ox + w, v1], [ox, v1]], c);
      this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [[ox, v0], [ox + w, v0], [ox + w, v1], [ox, v1]], c);
    }
    const ts = opts.topScale ?? us;
    if (opts.top !== false) {
      this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [[x0 / ts, z1 / ts], [x1 / ts, z1 / ts], [x1 / ts, z0 / ts], [x0 / ts, z0 / ts]], c);
    }
    if (opts.bottom) {
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [[0, 0], [1, 0], [1, 1], [0, 1]], c);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.withColor) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
