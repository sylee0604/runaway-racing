import * as THREE from 'three';
import { HILL } from '../game/config';
import type { CityLayout } from '../world/CityLayout';
import { createHelicopterModel, type HelicopterVisual } from './VehicleModels';

function beamTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  // CylinderGeometry v runs bottom(0) → top(1); canvas y=0 maps to v=1 (the light source end)
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.32)');
  g.addColorStop(1, 'rgba(255,255,255,0.03)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Whether a ground position is hidden from the air (tunnel, under the elevated highway). */
export function hiddenFromAir(layout: CityLayout, x: number, y: number, z: number): boolean {
  if (x > HILL.x0 && x < HILL.x1 && Math.abs(z - HILL.tunnelZ) < 9) return true;
  return layout.underDeck(x, y, z);
}

export class Helicopter {
  readonly visual: HelicopterVisual;
  readonly spot: THREE.SpotLight;
  readonly beam: THREE.Mesh;
  readonly pool: THREE.Mesh;
  readonly position = new THREE.Vector3();
  readonly aim = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private orbit = 0;
  private t = 0;
  spotted = false;
  active = true;
  leaving = false;
  readonly spotRadius = 9;

  constructor(
    scene: THREE.Scene,
    private readonly seed: number,
    castShadow: boolean,
  ) {
    this.visual = createHelicopterModel();
    this.visual.root.rotation.order = 'YXZ';
    this.spot = new THREE.SpotLight('#e8f2ff', 0, 140, 0.2, 0.55, 1.2);
    this.spot.castShadow = castShadow;
    if (castShadow) {
      this.spot.shadow.mapSize.set(1024, 1024);
      this.spot.shadow.camera.near = 5;
      this.spot.shadow.camera.far = 140;
      this.spot.shadow.bias = -0.0005;
    }
    const beamGeo = new THREE.CylinderGeometry(0.4, 1, 1, 24, 1, true);
    beamGeo.translate(0, -0.5, 0); // apex at origin, extends down -y
    this.beam = new THREE.Mesh(
      beamGeo,
      new THREE.MeshBasicMaterial({
        map: beamTexture(),
        color: new THREE.Color(0.5, 0.58, 0.7),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.beam.frustumCulled = false;
    const poolGeo = new THREE.CircleGeometry(1, 32);
    poolGeo.rotateX(-Math.PI / 2);
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.75, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const pt = new THREE.CanvasTexture(c);
    this.pool = new THREE.Mesh(
      poolGeo,
      new THREE.MeshBasicMaterial({ map: pt, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, color: new THREE.Color(0.7, 0.75, 0.85), polygonOffset: true, polygonOffsetFactor: -6 }),
    );
    scene.add(this.visual.root, this.spot, this.spot.target, this.beam, this.pool);
    this.orbit = seed * 2.1;
  }

  hide(): void {
    this.active = false;
    this.spotted = false;
    this.visual.root.visible = false;
    this.spot.intensity = 0;
    this.beam.visible = false;
    this.pool.visible = false;
  }

  spawn(px: number, pz: number, angle: number): void {
    this.visual.root.visible = true;
    this.position.set(px + Math.cos(angle) * 260, 60, pz + Math.sin(angle) * 260);
    this.aim.set(px, 0, pz);
    this.vel.set(0, 0, 0);
    this.active = true;
    this.leaving = false;
    this.spot.intensity = 0;
  }

  update(dt: number, player: THREE.Vector3, playerVel: THREE.Vector2, accuracy: number, elapsed: number, layout: CityLayout): void {
    this.t += dt;
    this.orbit += dt * 0.25;
    // hover point: trailing behind/around the player, high above roofs
    const r = 26;
    const tx = this.leaving ? this.position.x + 50 : player.x + Math.cos(this.orbit) * r + playerVel.x * 0.9;
    const tz = this.leaving ? this.position.z + 50 : player.z + Math.sin(this.orbit) * r + playerVel.y * 0.9;
    const ty = this.leaving ? 90 : 42 + Math.sin(this.t * 0.4 + this.seed) * 3;
    const ax = (tx - this.position.x) * 1.4 - this.vel.x * 1.6;
    const ay = (ty - this.position.y) * 1.2 - this.vel.y * 1.8;
    const az = (tz - this.position.z) * 1.4 - this.vel.z * 1.6;
    this.vel.x += ax * dt;
    this.vel.y += ay * dt;
    this.vel.z += az * dt;
    const maxV = 58;
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (hv > maxV) {
      this.vel.x *= maxV / hv;
      this.vel.z *= maxV / hv;
    }
    this.position.addScaledVector(this.vel, dt);

    // searchlight aim: lags the player and wobbles; more accurate at high heat
    const err = (1 - accuracy) * 9;
    const wx = player.x + playerVel.x * 0.25 + Math.sin(elapsed * 0.9 + this.seed) * err;
    const wz = player.z + playerVel.y * 0.25 + Math.cos(elapsed * 1.13 + this.seed * 2) * err;
    const k = Math.min(1, dt * (1.6 + accuracy * 1.8));
    this.aim.x += (wx - this.aim.x) * k;
    this.aim.z += (wz - this.aim.z) * k;
    this.aim.y = player.y;

    const v = this.visual;
    v.root.position.copy(this.position);
    const yaw = Math.atan2(this.vel.x, this.vel.z);
    if (hv > 3) v.root.rotation.y += Math.atan2(Math.sin(yaw - v.root.rotation.y), Math.cos(yaw - v.root.rotation.y)) * Math.min(1, dt * 1.5);
    v.root.rotation.x = Math.min(0.3, hv * 0.008);
    v.root.rotation.z = 0;
    v.rotor.rotation.y += dt * 28;
    v.tailRotor.rotation.x += dt * 40;
    v.beacon.visible = Math.sin(elapsed * 7 + this.seed) > 0.6;

    const lightPos = new THREE.Vector3();
    v.lightPivot.getWorldPosition(lightPos);
    this.spot.position.copy(lightPos);
    this.spot.target.position.copy(this.aim);
    this.spot.target.updateMatrixWorld();
    const arrive = this.leaving ? 0 : Math.min(1, Math.max(0, 1 - (Math.hypot(this.position.x - player.x, this.position.z - player.z) - 40) / 120));
    this.spot.intensity = 900 * arrive;
    const dist = lightPos.distanceTo(this.aim);
    this.beam.position.copy(lightPos);
    this.beam.lookAt(this.aim);
    this.beam.rotateX(-Math.PI / 2);
    const spread = Math.tan(0.2) * dist;
    this.beam.scale.set(spread, dist, spread);
    (this.beam.material as THREE.MeshBasicMaterial).opacity = arrive * 0.22;
    this.beam.visible = arrive > 0.02;
    this.pool.position.set(this.aim.x, this.aim.y + 0.08, this.aim.z);
    this.pool.scale.setScalar(this.spotRadius);
    this.pool.visible = arrive > 0.02;
    (this.pool.material as THREE.MeshBasicMaterial).opacity = arrive * 0.3;

    const d = Math.hypot(player.x - this.aim.x, player.z - this.aim.z);
    this.spotted = arrive > 0.6 && d < this.spotRadius && !hiddenFromAir(layout, player.x, player.y, player.z);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.visual.root, this.spot, this.spot.target, this.beam, this.pool);
    this.spot.dispose();
    this.beam.geometry.dispose();
    this.pool.geometry.dispose();
  }
}
