import * as THREE from 'three';
import { SPECS, TRAFFIC_COUNT } from '../game/config';
import { Vehicle } from '../entities/Vehicle';
import type { CityLayout } from '../world/CityLayout';
import { AIDriver } from './AIDriver';

interface Civ {
  v: Vehicle;
  driver: AIDriver;
  from: number;
  to: number;
  cruise: number;
  stunned: number;
}

const LANE = 4.2;

/** Civilian cars wandering the road graph: obstacles for both player and police. */
export class TrafficSystem {
  readonly civs: Civ[] = [];
  private readonly target = { x: 0, z: 0 };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly layout: CityLayout,
    private readonly rand: () => number,
    count = TRAFFIC_COUNT,
  ) {
    for (let i = 0; i < count; i += 1) {
      const v = new Vehicle('civilian', SPECS.civilian, i);
      this.scene.add(v.visual.root);
      this.civs.push({ v, driver: new AIDriver(), from: 0, to: 0, cruise: 11, stunned: 0 });
    }
  }

  get vehicles(): Vehicle[] {
    return this.civs.map((c) => c.v);
  }

  reset(px: number, pz: number): void {
    for (const c of this.civs) this.relocate(c, px, pz, 40, 220, null);
  }

  private relocate(c: Civ, px: number, pz: number, minD: number, maxD: number, camera: THREE.Vector3 | null): boolean {
    for (let tries = 0; tries < 30; tries += 1) {
      const n = this.layout.nodes[Math.floor(this.rand() * this.layout.nodes.length)];
      if (n.edges.length === 0) continue;
      const d = Math.hypot(n.x - px, n.z - pz);
      if (d < minD || d > maxD) continue;
      if (camera && this.layout.lineOfSight(camera.x, camera.z, n.x, n.z) && d < 150) continue;
      const to = n.edges[Math.floor(this.rand() * n.edges.length)];
      const t = this.layout.nodes[to];
      const heading = Math.atan2(t.x - n.x, t.z - n.z);
      const dx = t.x - n.x;
      const dz = t.z - n.z;
      const l = Math.hypot(dx, dz) || 1;
      const along = n.roundabout ? 24 : 14;
      const sx = n.x + (dx / l) * along + (-dz / l) * LANE;
      const sz = n.z + (dz / l) * along + (dx / l) * LANE;
      c.v.place(sx, n.y, sz, heading);
      c.v.health = c.v.spec.health;
      c.from = n.id;
      c.to = to;
      c.cruise = 10 + this.rand() * 6;
      c.stunned = 0;
      c.v.syncVisual(0);
      return true;
    }
    return false;
  }

  update(dt: number, player: Vehicle, others: Vehicle[], camera: THREE.Vector3): void {
    const p = player.position;
    for (const c of this.civs) {
      const v = c.v;
      const d = Math.hypot(v.position.x - p.x, v.position.z - p.z);
      if ((d > 240 || v.sinking) && Math.hypot(v.position.x - camera.x, v.position.z - camera.z) > 120) {
        this.relocate(c, p.x, p.z, 80, 200, camera);
        continue;
      }
      if (v.lastImpact > 5) {
        c.stunned = 2.5 + this.rand() * 2;
        v.lastImpact = 0;
      }
      if (c.stunned > 0 || !v.alive) {
        c.stunned -= dt;
        v.input.throttle = v.forwardSpeed > 0.5 ? -0.4 : 0;
        v.input.steer = 0;
        v.input.handbrake = false;
        continue;
      }
      const b = this.layout.nodes[c.to];
      this.layout.laneTarget(c.from, c.to, LANE, this.target);
      const tx = this.target.x;
      const tz = this.target.z;
      if (Math.hypot(b.x - v.position.x, b.z - v.position.z) < (b.roundabout ? 16 : 10)) {
        const options = b.edges.filter((e) => e !== c.from);
        const next = options.length ? options[Math.floor(this.rand() * options.length)] : c.from;
        c.from = c.to;
        c.to = next;
      }
      // brake for anything just ahead
      let speed = c.cruise;
      const fx = v.forwardX;
      const fz = v.forwardZ;
      for (const o of others) {
        if (o === v) continue;
        const ox = o.position.x - v.position.x;
        const oz = o.position.z - v.position.z;
        const along = ox * fx + oz * fz;
        if (along < 0 || along > 13) continue;
        const lat = Math.abs(ox * fz - oz * fx);
        if (lat < 2.6 && Math.abs(o.position.y - v.position.y) < 2) speed = Math.min(speed, Math.max(0, (along - 6) * 1.5));
      }
      c.driver.drive(v, this.layout, tx, tz, speed, dt);
      if (speed < 1) v.input.throttle = v.forwardSpeed > 0.3 ? -1 : 0;
    }
  }
}
