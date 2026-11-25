import type { Vehicle } from '../entities/Vehicle';
import type { CityLayout } from '../world/CityLayout';

const LANE = 4.2;
const scratch: number[] = [];

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Point-in-solid test at the car's height (buildings, pillars, rails, props). */
function blocked(layout: CityLayout, x: number, z: number, y: number): boolean {
  layout.queryBoxes(x, z, 0.1, scratch);
  for (const i of scratch) {
    const b = layout.boxes[i];
    if (y >= b.y1 - 0.2 || y + 1.4 <= b.y0) continue;
    if (x > b.x0 - 0.6 && x < b.x1 + 0.6 && z > b.z0 - 0.6 && z < b.z1 + 0.6) return true;
  }
  const s = layout.blockingSurface(x, z, y);
  return s !== null;
}

/**
 * Shared steering: drive toward (tx,tz) at desiredSpeed, with whisker obstacle
 * avoidance and stuck recovery. Writes vehicle.input.
 */
export class AIDriver {
  stuckTimer = 0;
  reverseTimer = 0;
  private reverseSteer = 0;
  avoid = 0;

  drive(v: Vehicle, layout: CityLayout, tx: number, tz: number, desiredSpeed: number, dt: number, aggressive = false): void {
    const inp = v.input;
    inp.handbrake = false;
    inp.nitro = false;
    if (!v.alive) {
      inp.throttle = 0;
      inp.steer = 0;
      return;
    }
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      inp.throttle = -1;
      inp.steer = this.reverseSteer;
      return;
    }
    const dx = tx - v.position.x;
    const dz = tz - v.position.z;
    const want = Math.atan2(dx, dz);
    let diff = wrapAngle(want - v.heading);

    // whiskers
    const speed = Math.max(4, v.forwardSpeed);
    const look = 5 + speed * 0.42 + v.spec.halfLength;
    const y = v.position.y;
    const px = v.position.x;
    const pz = v.position.z;
    const hL = v.heading + 0.38;
    const hR = v.heading - 0.38;
    const hitC = blocked(layout, px + Math.sin(v.heading) * look, pz + Math.cos(v.heading) * look, y);
    const hitL = blocked(layout, px + Math.sin(hL) * look * 0.8, pz + Math.cos(hL) * look * 0.8, y);
    const hitR = blocked(layout, px + Math.sin(hR) * look * 0.8, pz + Math.cos(hR) * look * 0.8, y);
    let targetAvoid = 0;
    if (hitL && !hitR) targetAvoid = -0.9;
    else if (hitR && !hitL) targetAvoid = 0.9;
    else if (hitC) targetAvoid = diff >= 0 ? 1 : -1;
    // only avoid when the target is not straight through the obstacle at close range
    const distT = Math.hypot(dx, dz);
    if (aggressive && distT < 10) targetAvoid *= 0.2;
    this.avoid += (targetAvoid - this.avoid) * Math.min(1, dt * 8);
    diff += this.avoid * 0.9;

    inp.steer = Math.max(-1, Math.min(1, diff * 2.4));
    const turnSlow = 1 - Math.min(0.62, Math.abs(diff) / Math.PI) * (aggressive ? 0.7 : 1);
    const target = desiredSpeed * turnSlow * (hitC && !aggressive ? 0.55 : 1);
    const fs = v.forwardSpeed;
    if (fs < target - 1) inp.throttle = 1;
    else if (fs > target + 4) inp.throttle = -0.6;
    else inp.throttle = 0.25;
    if (Math.abs(diff) > 1.3 && fs > 18) inp.handbrake = true;

    // stuck detection
    if (inp.throttle > 0.2 && v.speed < 1.6) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.0) {
        this.stuckTimer = 0;
        this.reverseTimer = 0.9 + (v.id % 5) * 0.12;
        this.reverseSteer = diff > 0 ? -1 : 1;
      }
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
    }
  }
}

/** Follows the road graph toward a goal node, producing lane-offset waypoints. */
export class RouteFollower {
  path: number[] = [];
  index = 0;
  repathTimer = 0;
  private lastGoal = -1;

  reset(): void {
    this.path.length = 0;
    this.index = 0;
    this.repathTimer = 0;
    this.lastGoal = -1;
  }

  update(v: Vehicle, layout: CityLayout, goalNode: number, dt: number, out: { x: number; z: number; final: boolean }): void {
    this.repathTimer -= dt;
    if (this.repathTimer <= 0 || goalNode !== this.lastGoal || this.index >= this.path.length) {
      this.repathTimer = 1.1;
      this.lastGoal = goalNode;
      const start = layout.nearestNode(v.position.x, v.position.z, v.position.y);
      layout.findPath(start, goalNode, this.path);
      this.index = 0;
      // skip the first node if we're already past it toward the second
      if (this.path.length > 1) {
        const a = layout.nodes[this.path[0]];
        const b = layout.nodes[this.path[1]];
        const toA = (a.x - v.position.x) * (b.x - a.x) + (a.z - v.position.z) * (b.z - a.z);
        if (toA < 0 || Math.hypot(a.x - v.position.x, a.z - v.position.z) < 12) this.index = 1;
      }
    }
    if (this.path.length === 0) {
      out.x = v.position.x;
      out.z = v.position.z;
      out.final = true;
      return;
    }
    let node = layout.nodes[this.path[Math.min(this.index, this.path.length - 1)]];
    if (Math.hypot(node.x - v.position.x, node.z - v.position.z) < 11 && this.index < this.path.length - 1) {
      this.index += 1;
      node = layout.nodes[this.path[this.index]];
    }
    // lane offset to the right of travel direction (prev node -> node)
    const prev = this.index > 0 ? layout.nodes[this.path[this.index - 1]] : null;
    let ox = 0;
    let oz = 0;
    if (prev) {
      const dx = node.x - prev.x;
      const dz = node.z - prev.z;
      const l = Math.hypot(dx, dz) || 1;
      ox = (-dz / l) * LANE;
      oz = (dx / l) * LANE;
    }
    out.x = node.x + ox;
    out.z = node.z + oz;
    out.final = this.index >= this.path.length - 1;
  }
}
