import * as THREE from 'three';
import type { Vehicle } from '../entities/Vehicle';

/** Chase camera with speed FOV, drift-aware yaw lag, shake, and a title orbit mode. */
export class CameraRig {
  private readonly pos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private yaw = 0;
  private shake = 0;
  private fov = 62;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera) {}

  addShake(amount: number): void {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  snap(v: Vehicle): void {
    this.yaw = v.heading;
    this.computeTarget(v, false);
    this.pos.copy(this.tmp);
    this.look.set(v.position.x, v.position.y + 1.2, v.position.z);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  private computeTarget(v: Vehicle, lookBack: boolean): void {
    const dist = 9.5 + Math.min(4, v.speed * 0.06);
    const height = 3.6 + Math.min(1.2, v.speed * 0.02);
    const dir = lookBack ? -1 : 1;
    this.tmp.set(v.position.x - Math.sin(this.yaw) * dist * dir, v.position.y + height, v.position.z - Math.cos(this.yaw) * dist * dir);
  }

  update(dt: number, v: Vehicle, nitro: boolean, lookBack: boolean, reducedMotion: boolean): void {
    // follow a blend of facing and travel direction so drifts read clearly
    let target = v.heading;
    if (v.speed > 6 && v.forwardSpeed > 0) {
      const travel = Math.atan2(v.velocity.x, v.velocity.y);
      const d = Math.atan2(Math.sin(travel - target), Math.cos(travel - target));
      target += d * 0.45;
    }
    const diff = Math.atan2(Math.sin(target - this.yaw), Math.cos(target - this.yaw));
    this.yaw += diff * Math.min(1, dt * 4.2);
    this.computeTarget(v, lookBack);
    const k = Math.min(1, dt * 7);
    this.pos.lerp(this.tmp, lookBack ? 1 : k);
    // never dip below the car (ramps) and keep under tunnel/deck ceilings
    this.pos.y = Math.max(this.pos.y, v.position.y + 2.2);
    if (v.position.y < 5) {
      const inTunnel = v.position.x > 68 && v.position.x < 232 && Math.abs(v.position.z - 180) < 9;
      const underDeck = Math.abs(v.position.z + 60) < 9 && Math.abs(v.position.x) < 188;
      if (inTunnel) this.pos.y = Math.min(this.pos.y, 6.6);
      if (underDeck) this.pos.y = Math.min(this.pos.y, 7.2);
    }
    const ahead = 6 + v.speed * 0.12;
    const lx = v.position.x + Math.sin(this.yaw) * ahead * (lookBack ? -1 : 1);
    const lz = v.position.z + Math.cos(this.yaw) * ahead * (lookBack ? -1 : 1);
    this.look.lerp(this.tmp.set(lx, v.position.y + 1.3, lz), Math.min(1, dt * 10));

    this.camera.position.copy(this.pos);
    if (this.shake > 0 && !reducedMotion) {
      const s = this.shake * this.shake * 0.5;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.camera.lookAt(this.look);

    const targetFov = 60 + Math.min(16, v.speed * 0.32) + (nitro ? 8 : 0);
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 3);
    if (Math.abs(this.camera.fov - this.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  orbit(elapsed: number, center: THREE.Vector3): void {
    const a = elapsed * 0.08;
    this.camera.position.set(center.x + Math.cos(a) * 34, 58 + Math.sin(elapsed * 0.2) * 4, center.z + Math.sin(a) * 34);
    this.camera.lookAt(center.x + Math.cos(a + 2.2) * 60, 0, center.z + Math.sin(a + 2.2) * 60);
    if (this.camera.fov !== 55) {
      this.camera.fov = 55;
      this.camera.updateProjectionMatrix();
    }
  }
}
