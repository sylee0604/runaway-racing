import * as THREE from 'three';
import { HEAT_LEVELS, SPECS, type HeatLevel } from '../game/config';
import { Helicopter } from '../entities/Helicopter';
import { Vehicle } from '../entities/Vehicle';
import { disposeVehicleVisual, type VehicleKind } from '../entities/VehicleModels';
import type { CityLayout } from '../world/CityLayout';
import { AIDriver, RouteFollower } from './AIDriver';

export type CopMode = 'chase' | 'parked' | 'wreck';

export interface Cop {
  v: Vehicle;
  driver: AIDriver;
  route: RouteFollower;
  mode: CopMode;
  wreckTime: number;
  sees: boolean;
  sirenPhase: number;
  roadblock: number; // roadblock id or -1
}

export interface Spike {
  mesh: THREE.Group;
  x: number;
  z: number;
  alongX: boolean; // strip lies across x
  halfLen: number;
  life: number;
  roadblock: number;
}

export interface PoliceEvents {
  onTakedown(cop: Cop): void;
  onSpike(): void;
}

const MAX_COPS = 14;

/** Spawns and drives police units according to the current heat level. */
export class PoliceSystem {
  readonly cops: Cop[] = [];
  readonly helis: Helicopter[] = [];
  readonly spikes: Spike[] = [];
  readonly lastKnown = new THREE.Vector3();
  lastKnownAge = 0;
  spotted = false;
  private spawnTimer = 0;
  private roadblockTimer = 12;
  private roadblockId = 0;
  private readonly sirenLights: THREE.PointLight[] = [];
  private readonly scratchPath: number[] = [];
  private readonly wp = { x: 0, z: 0, final: false };
  private readonly spikeTex: THREE.Texture;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly layout: CityLayout,
    private readonly rand: () => number,
  ) {
    for (let i = 0; i < 2; i += 1) {
      const h = new Helicopter(scene, i + 1, i === 0);
      h.hide();
      this.helis.push(h);
    }
    for (const c of ['#ff2030', '#2050ff']) {
      const l = new THREE.PointLight(c, 0, 28, 1.6);
      scene.add(l);
      this.sirenLights.push(l);
    }
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 16;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#1c1c1e';
    ctx.fillRect(0, 0, 128, 16);
    for (let x = 0; x < 128; x += 16) {
      ctx.fillStyle = '#cfd3d8';
      ctx.beginPath();
      ctx.moveTo(x + 2, 14);
      ctx.lineTo(x + 8, 2);
      ctx.lineTo(x + 14, 14);
      ctx.fill();
    }
    this.spikeTex = new THREE.CanvasTexture(cv);
    this.spikeTex.wrapS = THREE.RepeatWrapping;
  }

  reset(): void {
    for (const c of this.cops) {
      this.scene.remove(c.v.visual.root);
      disposeVehicleVisual(c.v.visual.root);
    }
    this.cops.length = 0;
    for (const s of this.spikes) this.scene.remove(s.mesh);
    this.spikes.length = 0;
    for (const h of this.helis) h.hide();
    this.spawnTimer = 0;
    this.roadblockTimer = 12;
    this.lastKnownAge = 0;
    for (const l of this.sirenLights) l.intensity = 0;
  }

  get chasingCount(): number {
    let n = 0;
    for (const c of this.cops) if (c.mode === 'chase') n += 1;
    return n;
  }

  spawnCop(kind: VehicleKind, x: number, z: number, heading: number, mode: CopMode = 'chase', roadblock = -1): Cop | null {
    if (this.cops.length >= MAX_COPS) return null;
    const v = new Vehicle(kind, SPECS[kind]);
    v.place(x, this.layout.groundAt(x, z, 0.5), z, heading);
    v.visual.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.scene.add(v.visual.root);
    const cop: Cop = { v, driver: new AIDriver(), route: new RouteFollower(), mode, wreckTime: 0, sees: false, sirenPhase: this.rand() * 6, roadblock };
    this.cops.push(cop);
    return cop;
  }

  /** Initial pursuers right behind the player at game start. */
  spawnOpening(player: Vehicle): void {
    const bx = -Math.sin(player.heading);
    const bz = -Math.cos(player.heading);
    const rx = Math.cos(player.heading);
    const rz = -Math.sin(player.heading);
    this.spawnCop('patrol', player.position.x + bx * 26 + rx * 2, player.position.z + bz * 26 + rz * 2, player.heading);
    this.spawnCop('patrol', player.position.x + bx * 40 - rx * 2, player.position.z + bz * 40 - rz * 2, player.heading);
    this.lastKnown.copy(player.position);
  }

  private pickKind(level: HeatLevel): VehicleKind {
    const w = level.weights;
    const r = this.rand() * (w.patrol + w.interceptor + w.swat + w.apc);
    if (r < w.patrol) return 'patrol';
    if (r < w.patrol + w.interceptor) return 'interceptor';
    if (r < w.patrol + w.interceptor + w.swat) return 'swat';
    return 'apc';
  }

  /** Find a ground node at distance [minD,maxD] from the player, preferring behind / out of view. */
  private findSpawnNode(player: Vehicle, minD: number, maxD: number, preferAhead = false): number {
    let best = -1;
    let bestScore = -Infinity;
    const fx = Math.sin(player.heading);
    const fz = Math.cos(player.heading);
    for (const n of this.layout.nodes) {
      if (n.level !== 'ground' || n.edges.length === 0) continue;
      const dx = n.x - player.position.x;
      const dz = n.z - player.position.z;
      const d = Math.hypot(dx, dz);
      if (d < minD || d > maxD) continue;
      const dot = (dx * fx + dz * fz) / d;
      const visible = this.layout.lineOfSight(player.position.x, player.position.z, n.x, n.z);
      let score = this.rand() * 0.6;
      score += preferAhead ? dot * 2 : -dot;
      if (!preferAhead && visible && dot > 0) score -= 2;
      if (score > bestScore) {
        bestScore = score;
        best = n.id;
      }
    }
    return best;
  }

  private spawnNear(player: Vehicle, kind: VehicleKind): void {
    const nodeId = this.findSpawnNode(player, 90, 170);
    if (nodeId < 0) return;
    const n = this.layout.nodes[nodeId];
    const goal = this.layout.nearestNode(player.position.x, player.position.z, player.position.y);
    this.layout.findPath(nodeId, goal, this.scratchPath);
    let heading = 0;
    if (this.scratchPath.length > 1) {
      const nx = this.layout.nodes[this.scratchPath[1]];
      heading = Math.atan2(nx.x - n.x, nx.z - n.z);
    }
    const rx = -Math.cos(heading);
    const rz = Math.sin(heading);
    const along = n.roundabout ? 24 : 7;
    this.spawnCop(kind, n.x + rx * 4.2 + Math.sin(heading) * along, n.z + rz * 4.2 + Math.cos(heading) * along, heading);
  }

  private placeRoadblock(player: Vehicle, level: HeatLevel): void {
    if (player.speed < 12) return;
    const vx = player.velocity.x / player.speed;
    const vz = player.velocity.y / player.speed;
    let best = -1;
    let bestDot = 0.86;
    for (const n of this.layout.nodes) {
      if (n.level !== 'ground' || n.edges.length < 2) continue;
      const dx = n.x - player.position.x;
      const dz = n.z - player.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 75 || d > 150) continue;
      const dot = (dx * vx + dz * vz) / d;
      if (dot > bestDot) {
        bestDot = dot;
        best = n.id;
      }
    }
    if (best < 0) return;
    const start = this.layout.nearestNode(player.position.x, player.position.z, player.position.y);
    this.layout.findPath(start, best, this.scratchPath);
    if (this.scratchPath.length < 2) return;
    const node = this.layout.nodes[best];
    const prev = this.layout.nodes[this.scratchPath[this.scratchPath.length - 2]];
    const dx = prev.x - node.x;
    const dz = prev.z - node.z;
    const l = Math.hypot(dx, dz);
    const ux = dx / l;
    const uz = dz / l;
    // 16m toward the approaching player from the intersection
    const back = node.roundabout ? 30 : 16;
    const cx = node.x + ux * back;
    const cz = node.z + uz * back;
    const px = -uz;
    const pz = ux;
    const id = ++this.roadblockId;
    const across = Math.atan2(px, pz);
    for (const side of [-1, 1]) {
      const kind: VehicleKind = level.stars >= 5 && side > 0 ? 'swat' : 'patrol';
      this.spawnCop(kind, cx + px * side * 5, cz + pz * side * 5, across + (side > 0 ? 0.15 : Math.PI - 0.15), 'parked', id);
    }
    if (level.spikes) {
      const g = new THREE.Group();
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshStandardMaterial({ map: this.spikeTex, metalness: 0.7, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -3 }),
      );
      strip.rotation.x = -Math.PI / 2;
      strip.scale.set(5.6, 1.1, 1);
      (strip.material as THREE.MeshStandardMaterial).map!.repeat.set(4, 1);
      g.add(strip);
      const cone = new THREE.MeshStandardMaterial({ color: '#ff6a00', emissive: '#ff4a00', emissiveIntensity: 0.6 });
      for (const s of [-3.2, 3.2]) {
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.75, 10), cone);
        c.position.set(s, 0.37, 0);
        g.add(c);
      }
      g.position.set(cx + ux * 7, 0.05, cz + uz * 7);
      g.rotation.y = Math.atan2(px, pz) + Math.PI / 2;
      this.scene.add(g);
      this.spikes.push({ mesh: g, x: g.position.x, z: g.position.z, alongX: Math.abs(px) > Math.abs(pz), halfLen: 3, life: 40, roadblock: id });
    }
  }

  update(dt: number, elapsed: number, player: Vehicle, level: HeatLevel, events: PoliceEvents, cameraPos: THREE.Vector3): void {
    const p = player.position;
    // ---- awareness
    let anySees = false;
    for (const c of this.cops) {
      c.sees = false;
      if (c.mode !== 'chase' || !c.v.alive) continue;
      const d = c.v.position.distanceTo(p);
      if (d < 130 && Math.abs(c.v.position.y - p.y) < 4 && this.layout.lineOfSight(c.v.position.x, c.v.position.z, p.x, p.z)) {
        c.sees = true;
        anySees = true;
      }
    }
    let heliSpot = false;
    const accuracy = (level.stars - 3) / 2;
    for (const h of this.helis) {
      if (!h.active) continue;
      h.update(dt, p, player.velocity, Math.max(0.2, accuracy), elapsed, this.layout);
      if (h.spotted) heliSpot = true;
    }
    this.spotted = anySees || heliSpot;
    if (this.spotted) {
      this.lastKnown.copy(p);
      this.lastKnownAge = 0;
    } else this.lastKnownAge += dt;

    // ---- helicopters per level
    const wantHelis = level.helicopters;
    this.helis.forEach((h, i) => {
      if (i < wantHelis && !h.active) h.spawn(p.x, p.z, this.rand() * Math.PI * 2);
      if (i >= wantHelis && h.active) h.hide();
    });

    // ---- spawning
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.chasingCount < level.maxCops) {
      this.spawnTimer = 3.2 - level.stars * 0.35;
      this.spawnNear(player, this.pickKind(level));
    }
    if (level.roadblocks) {
      this.roadblockTimer -= dt;
      if (this.roadblockTimer <= 0) {
        this.roadblockTimer = 22 - level.stars * 2;
        this.placeRoadblock(player, level);
      }
    }

    // ---- drive
    const goal = this.layout.nearestNode(this.lastKnown.x, this.lastKnown.z, this.lastKnown.y);
    for (let i = this.cops.length - 1; i >= 0; i -= 1) {
      const c = this.cops[i];
      const v = c.v;
      const d = v.position.distanceTo(p);
      if (c.mode === 'wreck') {
        c.wreckTime += dt;
        v.input.throttle = 0;
        v.input.steer = 0;
        if (c.wreckTime > 9 && d > 50) this.remove(i);
        continue;
      }
      if (!v.alive || v.sinking) {
        c.mode = 'wreck';
        c.wreckTime = 0;
        events.onTakedown(c);
        continue;
      }
      if (c.mode === 'parked') {
        v.input.throttle = 0;
        v.input.steer = 0;
        v.input.handbrake = true;
        if (d < 22 || v.speed > 3) c.mode = 'chase';
        if (d > 260) this.remove(i);
        continue;
      }
      // respawn stragglers that are far and out of view
      const toCam = new THREE.Vector3().subVectors(v.position, cameraPos);
      if (d > 280 && toCam.length() > 200) {
        this.remove(i);
        continue;
      }
      const rubber = d > 110 ? 1.2 : d > 60 ? 1.08 : 1;
      const desired = v.spec.maxSpeed * rubber;
      v.maxSpeedBonus = v.spec.maxSpeed * (rubber - 1);
      if (c.sees && d < 120) {
        const lead = Math.min(1.1, d / 35) * level.aggression;
        let tx = p.x + player.velocity.x * lead;
        let tz = p.z + player.velocity.y * lead;
        if (d < 14) {
          tx = p.x + player.velocity.x * 0.25;
          tz = p.z + player.velocity.y * 0.25;
        }
        c.driver.drive(v, this.layout, tx, tz, desired, dt, true);
        c.route.repathTimer = 0;
      } else {
        const lk = this.lastKnown;
        const dl = Math.hypot(lk.x - v.position.x, lk.z - v.position.z);
        if (dl < 16 && Math.abs(lk.y - v.position.y) < 4) {
          // search: circle the last known point
          const a = elapsed * 0.6 + c.sirenPhase;
          c.driver.drive(v, this.layout, lk.x + Math.cos(a) * 30, lk.z + Math.sin(a) * 30, 16, dt);
        } else {
          c.route.update(v, this.layout, goal, dt, this.wp);
          if (this.wp.final) c.driver.drive(v, this.layout, lk.x, lk.z, desired, dt, false);
          else c.driver.drive(v, this.layout, this.wp.x, this.wp.z, desired, dt, false);
        }
      }
    }

    // ---- spikes
    for (let i = this.spikes.length - 1; i >= 0; i -= 1) {
      const s = this.spikes[i];
      s.life -= dt;
      const lx = p.x - s.x;
      const lz = p.z - s.z;
      const inX = s.alongX ? Math.abs(lx) < s.halfLen + 0.8 && Math.abs(lz) < 1.6 : Math.abs(lz) < s.halfLen + 0.8 && Math.abs(lx) < 1.6;
      if (inX && p.y < 1) {
        events.onSpike();
        this.scene.remove(s.mesh);
        this.spikes.splice(i, 1);
        continue;
      }
      if (s.life <= 0 && Math.hypot(lx, lz) > 80) {
        this.scene.remove(s.mesh);
        this.spikes.splice(i, 1);
      }
    }

    // ---- siren flashing and pooled lights on the two nearest cars
    let n1: Cop | null = null;
    let n2: Cop | null = null;
    let d1 = Infinity;
    let d2 = Infinity;
    for (const c of this.cops) {
      const on = c.mode !== 'wreck';
      const ph = elapsed * 7 + c.sirenPhase;
      const redOn = on && Math.sin(ph) > 0;
      const blueOn = on && Math.sin(ph) <= 0;
      for (const o of c.v.visual.sirenRed) o.visible = redOn;
      for (const o of c.v.visual.sirenBlue) o.visible = blueOn;
      if (!on) continue;
      const d = c.v.position.distanceToSquared(p);
      if (d < d1) {
        d2 = d1;
        n2 = n1;
        d1 = d;
        n1 = c;
      } else if (d < d2) {
        d2 = d;
        n2 = c;
      }
    }
    const lights: [THREE.PointLight, Cop | null, boolean][] = [
      [this.sirenLights[0], n1, true],
      [this.sirenLights[1], n2 ?? n1, false],
    ];
    for (const [light, cop, red] of lights) {
      if (!cop) {
        light.intensity = 0;
        continue;
      }
      const ph = Math.sin(elapsed * 7 + cop.sirenPhase);
      light.position.set(cop.v.position.x, cop.v.position.y + 2.6, cop.v.position.z);
      light.intensity = (red ? ph > 0 : ph <= 0) ? 260 : 0;
    }
  }

  remove(i: number): void {
    const c = this.cops[i];
    this.scene.remove(c.v.visual.root);
    disposeVehicleVisual(c.v.visual.root);
    this.cops.splice(i, 1);
  }

  /** Nearest siren distance (for audio). */
  nearestDistance(p: THREE.Vector3): number {
    let best = Infinity;
    for (const c of this.cops) {
      if (c.mode === 'wreck') continue;
      best = Math.min(best, c.v.position.distanceTo(p));
    }
    return best;
  }

  nearestHeliDistance(p: THREE.Vector3): number {
    let best = Infinity;
    for (const h of this.helis) if (h.active) best = Math.min(best, h.position.distanceTo(p));
    return best;
  }
}

export { HEAT_LEVELS };
