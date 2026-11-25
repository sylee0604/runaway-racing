import * as THREE from 'three';
import type { VehicleSpec } from '../game/config';
import type { CityLayout } from '../world/CityLayout';
import { createVehicleModel, type VehicleKind, type VehicleVisual } from './VehicleModels';

export interface DriveInput {
  throttle: number; // -1 (brake/reverse) .. 1
  steer: number; // +1 = turn left (heading increases), -1 = right
  handbrake: boolean;
  nitro: boolean;
}

const GRAVITY = 22;

let nextId = 1;

/** Arcade vehicle: kinematic bicycle-ish model with lateral grip, ramps, jumps. */
export class Vehicle {
  readonly id = nextId++;
  readonly visual: VehicleVisual;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector2(); // x,z world
  vy = 0;
  heading = 0;
  health: number;
  alive = true;
  airborne = false;
  airTime = 0;
  onDeck = false;
  readonly input: DriveInput = { throttle: 0, steer: 0, handbrake: false, nitro: false };
  nitroActive = false;
  speedScale = 1; // spikes etc.
  gripScale = 1;
  maxSpeedBonus = 0;
  accelBonus = 0;
  lastImpact = 0;
  wreckTimer = 0;
  sinking = false;
  landedImpact = 0;
  readonly prevPosition = new THREE.Vector3();

  private groundVy = 0;
  private steerVisual = 0;
  private wheelSpin = 0;
  private pitch = 0;
  private roll = 0;

  constructor(
    readonly kind: VehicleKind,
    readonly spec: VehicleSpec,
    variant = 0,
  ) {
    this.visual = createVehicleModel(kind, variant);
    this.visual.root.rotation.order = 'YXZ';
    this.health = spec.health;
  }

  get speed(): number {
    return this.velocity.length();
  }

  get forwardX(): number {
    return Math.sin(this.heading);
  }

  get forwardZ(): number {
    return Math.cos(this.heading);
  }

  /** Signed speed along the car's facing. */
  get forwardSpeed(): number {
    return this.velocity.x * this.forwardX + this.velocity.y * this.forwardZ;
  }

  get lateralSpeed(): number {
    return this.velocity.x * Math.cos(this.heading) - this.velocity.y * Math.sin(this.heading);
  }

  place(x: number, y: number, z: number, heading: number): void {
    this.position.set(x, y, z);
    this.prevPosition.copy(this.position);
    this.heading = heading;
    this.velocity.set(0, 0);
    this.vy = 0;
    this.groundVy = 0;
    this.airborne = false;
    this.alive = true;
    this.sinking = false;
    this.health = this.spec.health;
    this.wreckTimer = 0;
    this.speedScale = 1;
    this.gripScale = 1;
    this.syncVisual(0);
  }

  update(dt: number, layout: CityLayout): void {
    this.prevPosition.copy(this.position);
    const spec = this.spec;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    // right-hand lateral axis (perpendicular), consistent with lateralSpeed
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    let vF = this.velocity.x * fx + this.velocity.y * fz;
    let vL = this.velocity.x * rx + this.velocity.y * rz;

    const control = this.alive && !this.airborne;
    const inp = this.input;
    const maxSpeed = (spec.maxSpeed + this.maxSpeedBonus) * this.speedScale;

    if (control) {
      const accel = spec.accel + this.accelBonus;
      if (inp.throttle > 0) {
        if (vF < -0.5) vF += spec.brake * inp.throttle * dt;
        else vF += accel * inp.throttle * Math.max(0, 1 - vF / maxSpeed) * dt * 1.6;
      } else if (inp.throttle < 0) {
        if (vF > 0.5) vF += spec.brake * inp.throttle * dt;
        else vF += accel * 0.7 * inp.throttle * Math.max(0, 1 + vF / spec.reverseSpeed) * dt;
      }
      if (inp.handbrake) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 9 * dt);
      // rolling resistance & drag
      vF -= vF * spec.drag * dt;
      if (inp.throttle === 0) vF -= Math.sign(vF) * Math.min(Math.abs(vF), 2.2 * dt);

      // steering: authority grows with speed, eases off at top speed
      const sp = Math.abs(vF);
      const authority = Math.min(1, sp / 7) * (1 - 0.38 * Math.min(1, sp / 46));
      const drift = inp.handbrake ? 1.45 : 1;
      const yaw = inp.steer * spec.steerRate * authority * drift * Math.sign(vF || 1);
      this.heading += yaw * dt;

      const grip = (inp.handbrake ? spec.driftGrip : spec.grip) * this.gripScale;
      vL *= Math.exp(-grip * dt);
    } else if (!this.alive) {
      vF *= Math.exp(-1.6 * dt);
      vL *= Math.exp(-3 * dt);
    }

    // recompute axes after heading change so grip aligns velocity with the new facing
    const nfx = Math.sin(this.heading);
    const nfz = Math.cos(this.heading);
    const nrx = Math.cos(this.heading);
    const nrz = -Math.sin(this.heading);
    this.velocity.set(nfx * vF + nrx * vL, nfz * vF + nrz * vL);

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.y * dt;

    // vertical: ramps, decks, jumps
    const prevY = this.position.y;
    if (this.airborne) {
      this.vy -= GRAVITY * dt;
      this.position.y += this.vy * dt;
      this.airTime += dt;
      const g = layout.groundAt(this.position.x, this.position.z, prevY);
      if (this.position.y <= g) {
        this.landedImpact = -this.vy;
        this.position.y = g;
        this.vy = 0;
        this.airborne = false;
        this.airTime = 0;
      }
    } else {
      const g = layout.groundAt(this.position.x, this.position.z, this.position.y);
      const drop = this.position.y - g;
      if (drop > 0.75) {
        // left a ramp lip or ledge: fly with the last climb rate
        this.airborne = true;
        this.vy = Math.max(this.groundVy, 0);
      } else {
        this.position.y = g;
        const climb = dt > 0 ? (g - prevY) / dt : 0;
        this.groundVy = THREE.MathUtils.lerp(this.groundVy, climb, 0.6);
      }
    }
    if (this.position.y < -3.5 && !this.sinking) {
      this.sinking = true;
    }
    this.onDeck = this.position.y > 6;
  }

  syncVisual(dt: number): void {
    const v = this.visual;
    v.root.position.copy(this.position);
    v.root.rotation.y = this.heading;
    const fs = this.forwardSpeed;
    this.wheelSpin += (fs / 0.42) * dt;
    for (const w of v.wheels) w.rotation.x = this.wheelSpin;
    this.steerVisual = THREE.MathUtils.lerp(this.steerVisual, this.input.steer * 0.45, Math.min(1, dt * 10));
    for (const w of v.frontWheels) w.rotation.y = this.steerVisual;
    // body lean: roll into corners, pitch on accel/ramps
    const targetRoll = THREE.MathUtils.clamp(-this.lateralSpeed * 0.012 + this.input.steer * Math.min(1, Math.abs(fs) / 30) * -0.05, -0.12, 0.12);
    this.roll = THREE.MathUtils.lerp(this.roll, targetRoll, Math.min(1, dt * 6));
    let targetPitch = this.airborne ? THREE.MathUtils.clamp(-this.vy * 0.02, -0.35, 0.3) : -this.groundVy / Math.max(6, Math.abs(fs)) ;
    if (!this.airborne) targetPitch += -this.input.throttle * 0.025;
    this.pitch = THREE.MathUtils.lerp(this.pitch, THREE.MathUtils.clamp(targetPitch, -0.4, 0.4), Math.min(1, dt * 7));
    v.body.rotation.z = this.roll;
    v.root.rotation.x = this.pitch;
    const braking = this.input.throttle < -0.1 && fs > 1;
    v.brakeMat.color.setRGB(braking ? 5 : 1.1, braking ? 0.15 : 0.05, braking ? 0.1 : 0.05);
  }

  /** Two circle colliders along the car's length. */
  circle(index: 0 | 1, out: THREE.Vector2): THREE.Vector2 {
    const off = this.spec.halfLength * (index === 0 ? 0.62 : -0.62);
    out.set(this.position.x + Math.sin(this.heading) * off, this.position.z + Math.cos(this.heading) * off);
    return out;
  }

  damage(amount: number): void {
    if (!this.alive) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
  }
}
