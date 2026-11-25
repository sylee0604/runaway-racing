import { CITY_HALF, GRID, HIGHWAYS, HILL, RIVER, ROUNDABOUT, ROUNDABOUTS, type HighwayDef } from '../game/config';
import { createSeededRandom } from '../utils/random';

/** Axis-aligned solid box in world space (x/z footprint plus a vertical span). */
export interface Box {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y0: number;
  y1: number;
  kind: 'building' | 'pillar' | 'rail' | 'hill' | 'prop' | 'wall';
  blocksSight: boolean;
}

/** Round solid (roundabout islands, fountain). */
export interface Circle {
  x: number;
  z: number;
  r: number;
  y0: number;
  y1: number;
}

/** Drivable surface (deck or ramp) whose height varies linearly along one axis. */
export interface Surface {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  axis: 'x' | 'z';
  h0: number; // height at axis min
  h1: number; // height at axis max
  solid: boolean; // true = nothing drivable underneath
  thickness: number;
  kind: 'deck' | 'ramp' | 'kicker';
}

export type RoadKind = 'street' | 'bridge' | 'tunnel' | 'highway' | 'ramp';

export interface RoadSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  y0: number;
  y1: number;
  kind: RoadKind;
  width: number;
}

export interface GraphNode {
  id: number;
  x: number;
  y: number;
  z: number;
  edges: number[];
  level: string; // 'ground' or a highway id
  roundabout: boolean;
}

export interface Lot {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  height: number;
  style: number;
  tiers: number;
}

export interface BlockInfo {
  bi: number;
  bj: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  type: 'city' | 'river' | 'hill' | 'plaza' | 'park' | 'lot';
}

export interface ParkedCar {
  x: number;
  z: number;
  rot: number;
  color: number;
}

const S = GRID.spacing;
const HR = GRID.roadWidth / 2;

/** World coordinates for a point given along/across a highway's axis. */
export function hwPoint(hw: HighwayDef, u: number, v: number): { x: number; z: number } {
  return hw.axis === 'x' ? { x: u, z: hw.line + v } : { x: hw.line + v, z: u };
}

/** World box for along-range [u0,u1] and across-range [v0,v1] of a highway. */
export function hwRect(hw: HighwayDef, u0: number, u1: number, v0: number, v1: number): { x0: number; z0: number; x1: number; z1: number } {
  return hw.axis === 'x'
    ? { x0: Math.min(u0, u1), x1: Math.max(u0, u1), z0: hw.line + Math.min(v0, v1), z1: hw.line + Math.max(v0, v1) }
    : { x0: hw.line + Math.min(v0, v1), x1: hw.line + Math.max(v0, v1), z0: Math.min(u0, u1), z1: Math.max(u0, u1) };
}

/** Height of a highway's roadway at along-coordinate u (deck, ramps, or null when off it). */
export function hwHeightAt(hw: HighwayDef, u: number): number | null {
  const a = Math.abs(u);
  if (a <= hw.deckHalf) return hw.height;
  if (a <= hw.rampEnd) return hw.height * (1 - (a - hw.deckHalf) / (hw.rampEnd - hw.deckHalf));
  return null;
}

export class CityLayout {
  readonly boxes: Box[] = [];
  readonly circles: Circle[] = [];
  readonly surfaces: Surface[] = [];
  readonly roads: RoadSegment[] = [];
  readonly nodes: GraphNode[] = [];
  readonly lots: Lot[] = [];
  readonly blocks: BlockInfo[] = [];
  readonly lamps: { x: number; z: number; rot: number; y?: number }[] = [];
  readonly trees: { x: number; z: number; s: number; y?: number }[] = [];
  readonly trafficLights: { x: number; z: number; rot: number }[] = [];
  readonly parkedCars: ParkedCar[] = [];
  readonly roundabouts: { x: number; z: number }[] = ROUNDABOUTS.map(([i, j]) => ({ x: i * S, z: j * S }));
  readonly fountain = { x: 30, z: 30, r: 5 };

  private readonly hash = new Map<number, number[]>();
  private readonly cell = 16;
  private readonly nodeIndex = new Map<string, number>();
  private readonly rng = createSeededRandom(1337);

  constructor() {
    this.buildRoads();
    this.buildBlocks();
    for (const hw of HIGHWAYS) this.buildHighway(hw);
    this.buildRiver();
    this.buildHill();
    this.buildRoundabouts();
    this.buildBoundary();
    this.buildStreetFurniture();
    for (let i = 0; i < this.boxes.length; i += 1) this.insertHash(i);
  }

  // ---------------------------------------------------------------- roads

  static isRoundabout(i: number, j: number): boolean {
    return ROUNDABOUTS.some(([a, b]) => a === i && b === j);
  }

  /** Ground road along x on row j between column i and i+1. */
  static hasHorizontal(i: number, j: number): RoadKind | null {
    if (i === -4) return RIVER.bridgeRows.includes(j) ? 'bridge' : null;
    for (const hw of HIGHWAYS) {
      // the last block before each ramp foot is taken by the ramp itself
      if (hw.axis === 'x' && hw.line === j * S && (i === GRID.min || i === GRID.max - 1)) return null;
    }
    if (j === 3 && i >= 3 && i <= 5) return 'tunnel';
    return 'street';
  }

  /** Ground road along z on column i between row j and j+1. */
  static hasVertical(i: number, j: number): RoadKind | null {
    if ((i === 4 || i === 5) && (j === 2 || j === 3)) return null; // inside the hill
    for (const hw of HIGHWAYS) {
      if (hw.axis === 'z' && hw.line === i * S && (j === GRID.min || j === GRID.max - 1)) return null;
    }
    return 'street';
  }

  private nodeAt(i: number, j: number, level = 'ground', y = 0): number {
    const key = `${level}:${i}:${j}`;
    const existing = this.nodeIndex.get(key);
    if (existing !== undefined) return existing;
    const id = this.nodes.length;
    this.nodes.push({ id, x: i * S, z: j * S, y, edges: [], level, roundabout: level === 'ground' && CityLayout.isRoundabout(i, j) });
    this.nodeIndex.set(key, id);
    return id;
  }

  private link(a: number, b: number): void {
    this.nodes[a].edges.push(b);
    this.nodes[b].edges.push(a);
  }

  private buildRoads(): void {
    for (let j = GRID.min; j <= GRID.max; j += 1) {
      for (let i = GRID.min; i < GRID.max; i += 1) {
        const kind = CityLayout.hasHorizontal(i, j);
        if (!kind) continue;
        this.roads.push({ ax: i * S, az: j * S, bx: (i + 1) * S, bz: j * S, y0: 0, y1: 0, kind, width: GRID.roadWidth });
        this.link(this.nodeAt(i, j), this.nodeAt(i + 1, j));
      }
    }
    for (let i = GRID.min; i <= GRID.max; i += 1) {
      for (let j = GRID.min; j < GRID.max; j += 1) {
        const kind = CityLayout.hasVertical(i, j);
        if (!kind) continue;
        this.roads.push({ ax: i * S, az: j * S, bx: i * S, bz: (j + 1) * S, y0: 0, y1: 0, kind, width: GRID.roadWidth });
        this.link(this.nodeAt(i, j), this.nodeAt(i, j + 1));
      }
    }
  }

  // --------------------------------------------------------------- blocks

  private blockType(bi: number, bj: number): BlockInfo['type'] {
    if (bi === -4) return 'river';
    if (bi >= 3 && bi <= 5 && bj >= 2 && bj <= 3) return 'hill';
    if (bi === 0 && bj === 0) return 'plaza';
    if ((bi === -2 && bj === 1) || (bi === 3 && bj === -6) || (bi === -6 && bj === 4)) return 'park';
    if ((bi === -2 || bi === -1) && bj === 3) return 'lot';
    return 'city';
  }

  private buildBlocks(): void {
    for (let bj = GRID.min; bj < GRID.max; bj += 1) {
      for (let bi = GRID.min; bi < GRID.max; bi += 1) {
        const x0 = bi * S + HR;
        const x1 = (bi + 1) * S - HR;
        const z0 = bj * S + HR;
        const z1 = (bj + 1) * S - HR;
        const type = this.blockType(bi, bj);
        this.blocks.push({ bi, bj, x0, z0, x1, z1, type });
        if (type === 'city') this.fillCityBlock(x0, z0, x1, z1);
        if (type === 'plaza') this.fillPlaza();
        if (type === 'park') this.fillPark(x0, z0, x1, z1);
        if (type === 'lot') this.fillParkingLot(x0, z0, x1, z1);
      }
    }
  }

  private nearRoundabout(x0: number, z0: number, x1: number, z1: number, margin: number): boolean {
    for (const r of this.roundabouts) {
      const cx = Math.max(x0, Math.min(r.x, x1));
      const cz = Math.max(z0, Math.min(r.z, z1));
      if (Math.hypot(cx - r.x, cz - r.z) < margin) return true;
    }
    return false;
  }

  private fillCityBlock(bx0: number, bz0: number, bx1: number, bz1: number): void {
    const inset = GRID.sidewalk;
    const x0 = bx0 + inset;
    const x1 = bx1 - inset;
    const z0 = bz0 + inset;
    const z1 = bz1 - inset;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const downtown = Math.max(0, 1 - Math.hypot(cx - 20, cz + 20) / 300);
    const r = this.rng();
    const alley = this.rng() < 0.4;
    const gap = alley ? 7 : 1.5;

    const pushLot = (lx0: number, lz0: number, lx1: number, lz1: number) => {
      const height = 12 + this.rng() * 26 + downtown * downtown * (40 + this.rng() * 60);
      if (this.nearRoundabout(lx0, lz0, lx1, lz1, ROUNDABOUT.outer + 4)) {
        // corner lots at a roundabout become small tree plazas
        const tx = (lx0 + lx1) / 2;
        const tz = (lz0 + lz1) / 2;
        if (!this.nearRoundabout(tx - 1, tz - 1, tx + 1, tz + 1, ROUNDABOUT.outer + 3)) this.addTree(tx, tz, 1.1);
        return;
      }
      const tiers = height > 45 ? 1 + Math.floor(this.rng() * 3) : 1;
      this.lots.push({ x0: lx0, z0: lz0, x1: lx1, z1: lz1, height, style: Math.floor(this.rng() * 6), tiers });
      this.boxes.push({ x0: lx0, z0: lz0, x1: lx1, z1: lz1, y0: -1, y1: height, kind: 'building', blocksSight: true });
    };

    if (r < 0.25) {
      pushLot(x0, z0, x1, z1);
    } else if (r < 0.62) {
      const split = 0.35 + this.rng() * 0.3;
      if (this.rng() < 0.5) {
        const sx = x0 + (x1 - x0) * split;
        pushLot(x0, z0, sx - gap / 2, z1);
        pushLot(sx + gap / 2, z0, x1, z1);
      } else {
        const sz = z0 + (z1 - z0) * split;
        pushLot(x0, z0, x1, sz - gap / 2);
        pushLot(x0, sz + gap / 2, x1, z1);
      }
    } else {
      const sx = (x0 + x1) / 2 + (this.rng() - 0.5) * 8;
      const sz = (z0 + z1) / 2 + (this.rng() - 0.5) * 8;
      const g2 = this.rng() < 0.5 ? gap : 1.5;
      pushLot(x0, z0, sx - gap / 2, sz - g2 / 2);
      pushLot(sx + gap / 2, z0, x1, sz - g2 / 2);
      pushLot(x0, sz + g2 / 2, sx - gap / 2, z1);
      pushLot(sx + gap / 2, sz + g2 / 2, x1, z1);
    }
  }

  private addTree(x: number, z: number, s: number, y = 0): void {
    this.trees.push({ x, z, s, y });
    if (y === 0) this.boxes.push({ x0: x - 0.5, z0: z - 0.5, x1: x + 0.5, z1: z + 0.5, y0: -1, y1: 6, kind: 'prop', blocksSight: false });
  }

  private fillPlaza(): void {
    const f = this.fountain;
    this.circles.push({ x: f.x, z: f.z, r: f.r + 0.3, y0: -1, y1: 3 });
    // Two kicker ramps that launch the car across the plaza.
    this.surfaces.push({ x0: 14, z0: 16, x1: 22, z1: 27, axis: 'z', h0: 0, h1: 2.6, solid: true, thickness: 0, kind: 'kicker' });
    this.surfaces.push({ x0: 38, z0: 33, x1: 46, z1: 44, axis: 'z', h0: 2.6, h1: 0, solid: true, thickness: 0, kind: 'kicker' });
    for (const [bx, bz] of [[10, 10], [50, 10], [10, 50], [50, 50]]) {
      this.boxes.push({ x0: bx - 1.2, z0: bz - 1.2, x1: bx + 1.2, z1: bz + 1.2, y0: -1, y1: 1.4, kind: 'prop', blocksSight: false });
    }
  }

  private fillPark(x0: number, z0: number, x1: number, z1: number): void {
    for (let k = 0; k < 26; k += 1) {
      const x = x0 + 4 + this.rng() * (x1 - x0 - 8);
      const z = z0 + 4 + this.rng() * (z1 - z0 - 8);
      // keep a diagonal shortcut lane clear
      const t = (x - x0) / (x1 - x0) - (z - z0) / (z1 - z0);
      if (Math.abs(t) < 0.16) continue;
      this.addTree(x, z, 0.8 + this.rng() * 0.7);
    }
  }

  /** Open car park: rows of parked cars (solid) with driving aisles and a launch ramp. */
  private fillParkingLot(x0: number, z0: number, x1: number, z1: number): void {
    const rows = [z0 + 6, z0 + 17, z1 - 17, z1 - 6];
    rows.forEach((rz, ri) => {
      for (let x = x0 + 4; x < x1 - 4; x += 3.4) {
        if (this.rng() < 0.3) continue; // empty bays
        const rot = ri % 2 === 0 ? 0 : Math.PI;
        this.parkedCars.push({ x, z: rz, rot, color: Math.floor(this.rng() * 9) });
        this.boxes.push({ x0: x - 1.0, z0: rz - 2.2, x1: x + 1.0, z1: rz + 2.2, y0: -1, y1: 1.5, kind: 'prop', blocksSight: false });
      }
    });
    // lamp posts in the middle aisle
    for (let x = x0 + 10; x < x1; x += 20) {
      this.lamps.push({ x, z: (z0 + z1) / 2, rot: 0 });
      this.boxes.push({ x0: x - 0.3, z0: (z0 + z1) / 2 - 0.3, x1: x + 0.3, z1: (z0 + z1) / 2 + 0.3, y0: -1, y1: 7, kind: 'prop', blocksSight: false });
    }
  }

  // -------------------------------------------------------------- highway

  private buildHighway(hw: HighwayDef): void {
    const hwW = hw.width / 2;
    const h = hw.height;
    const L = hw.deckHalf;
    const R = hw.rampEnd;
    const axis = hw.axis;
    const deck = hwRect(hw, -L, L, -hwW, hwW);
    this.surfaces.push({ ...deck, axis, h0: h, h1: h, solid: false, thickness: 1.2, kind: 'deck' });
    const rampP = hwRect(hw, L, R, -hwW, hwW);
    const rampN = hwRect(hw, -R, -L, -hwW, hwW);
    this.surfaces.push({ ...rampP, axis, h0: h, h1: 0, solid: false, thickness: 1.2, kind: 'ramp' });
    this.surfaces.push({ ...rampN, axis, h0: 0, h1: h, solid: false, thickness: 1.2, kind: 'ramp' });

    // Rails: on the deck, and stepped along the ramps so cars can still pass underneath.
    for (const side of [-1, 1]) {
      const v0 = side * (hwW + 0.05);
      const v1 = side * (hwW + 0.85);
      this.boxes.push({ ...hwRect(hw, -L, L, v0, v1), y0: h - 0.8, y1: h + 1.3, kind: 'rail', blocksSight: false });
      for (const dir of [-1, 1]) {
        const steps = 10;
        for (let k = 0; k < steps; k += 1) {
          const ua = dir * (L + ((R - L) * k) / steps);
          const ub = dir * (L + ((R - L) * (k + 1)) / steps);
          const hy = h * (1 - (k + 0.5) / steps);
          this.boxes.push({ ...hwRect(hw, ua, ub, v0, v1), y0: hy < 3 ? -1 : hy - 1.6, y1: hy + 1.6, kind: 'rail', blocksSight: false });
        }
      }
    }

    // Pillars down the centre of the street underneath, skipping crossings and other decks.
    // u ≡ 15 (mod 30) never lands within 15 m of a grid crossing
    for (let u = -Math.floor(R / 30) * 30 + 15; u <= R - 4; u += 30) {
      const y = hwHeightAt(hw, u);
      if (y === null || y - 1.2 < 3.2) continue;
      const p = hwPoint(hw, u, 0);
      let clash = false;
      for (const other of HIGHWAYS) {
        if (other === hw) continue;
        const ov = other.axis === 'x' ? p.z - other.line : p.x - other.line;
        const ou = other.axis === 'x' ? p.x : p.z;
        if (Math.abs(ov) < other.width / 2 + 3 && hwHeightAt(other, ou) !== null) clash = true;
      }
      if (clash) continue;
      this.boxes.push({ x0: p.x - 1.3, z0: p.z - 1.3, x1: p.x + 1.3, z1: p.z + 1.3, y0: -1, y1: y - 1.2, kind: 'pillar', blocksSight: false });
    }

    // Graph: deck nodes over each grid line, linked to the ground at both ramp feet.
    const first = Math.ceil(-L / S);
    const last = Math.floor(L / S);
    let prev = -1;
    const lineIdx = Math.round(hw.line / S);
    const deckNode = (k: number) => (axis === 'x' ? this.nodeAt(k, lineIdx, hw.id, h) : this.nodeAt(lineIdx, k, hw.id, h));
    for (let k = first; k <= last; k += 1) {
      const id = deckNode(k);
      if (prev >= 0) this.link(prev, id);
      prev = id;
    }
    const footP = axis === 'x' ? this.nodeAt(GRID.max, lineIdx) : this.nodeAt(lineIdx, GRID.max);
    const footN = axis === 'x' ? this.nodeAt(GRID.min, lineIdx) : this.nodeAt(lineIdx, GRID.min);
    this.link(deckNode(last), footP);
    this.link(deckNode(first), footN);

    const a = hwPoint(hw, -L, 0);
    const b = hwPoint(hw, L, 0);
    const c = hwPoint(hw, R, 0);
    const d = hwPoint(hw, -R, 0);
    const e = hwPoint(hw, CITY_HALF, 0);
    const f = hwPoint(hw, -CITY_HALF, 0);
    this.roads.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, y0: h, y1: h, kind: 'highway', width: hw.width });
    this.roads.push({ ax: b.x, az: b.z, bx: c.x, bz: c.z, y0: h, y1: 0, kind: 'ramp', width: hw.width });
    this.roads.push({ ax: d.x, az: d.z, bx: a.x, bz: a.z, y0: 0, y1: h, kind: 'ramp', width: hw.width });
    this.roads.push({ ax: c.x, az: c.z, bx: e.x, bz: e.z, y0: 0, y1: 0, kind: 'street', width: hw.width });
    this.roads.push({ ax: f.x, az: f.z, bx: d.x, bz: d.z, y0: 0, y1: 0, kind: 'street', width: hw.width });

    // overhead sign gantries (solid posts on the deck)
    for (const gu of [-L * 0.45, L * 0.45]) {
      for (const side of [-1, 1]) {
        const p = hwPoint(hw, gu, side * (hwW - 0.3));
        this.boxes.push({ x0: p.x - 0.35, z0: p.z - 0.35, x1: p.x + 0.35, z1: p.z + 0.35, y0: h - 0.5, y1: h + 7.2, kind: 'prop', blocksSight: false });
      }
    }
    // deck lamps along the barrier line
    for (let u = -L + 18; u <= L - 18; u += 34) {
      for (const side of [-1, 1]) {
        const p = hwPoint(hw, u, side * (hwW + 0.4));
        const rot = axis === 'x' ? (side > 0 ? Math.PI : 0) : side > 0 ? -Math.PI / 2 : Math.PI / 2;
        this.lamps.push({ x: p.x, z: p.z, rot, y: h });
      }
    }
  }

  // ---------------------------------------------------------------- river

  private buildRiver(): void {
    const eastRail = RIVER.x + 22;
    const westRail = RIVER.x - 22;
    const gaps = RIVER.bridgeRows.map((j) => j * S);
    const jumpRow = RIVER.jumpRow * S;
    for (const rx of [westRail, eastRail]) {
      let start = -CITY_HALF - 8;
      const cuts = [...gaps, jumpRow].sort((a, b) => a - b);
      for (const g of cuts) {
        this.boxes.push({ x0: rx - 0.35, z0: start, x1: rx + 0.35, z1: g - HR, y0: -1, y1: 1.1, kind: 'rail', blocksSight: false });
        start = g + HR;
      }
      this.boxes.push({ x0: rx - 0.35, z0: start, x1: rx + 0.35, z1: CITY_HALF + 8, y0: -1, y1: 1.1, kind: 'rail', blocksSight: false });
    }
    for (const g of gaps) {
      for (const side of [-1, 1]) {
        const rz = g + side * (HR + 0.35);
        this.boxes.push({ x0: westRail, z0: rz - 0.35, x1: eastRail, z1: rz + 0.35, y0: -1, y1: 1.2, kind: 'rail', blocksSight: false });
      }
      // bridge lamps are solid too
      for (const side of [-1, 1]) {
        for (const dx of [-10, 10]) {
          const x = RIVER.x + dx;
          const z = g + side * (HR + 0.6);
          this.lamps.push({ x, z, rot: side > 0 ? Math.PI : 0 });
          this.boxes.push({ x0: x - 0.3, z0: z - 0.3, x1: x + 0.3, z1: z + 0.3, y0: -1, y1: 7, kind: 'prop', blocksSight: false });
        }
      }
    }
    // River-jump kickers on both embankments of the jump row (no bridge there).
    this.surfaces.push({ x0: RIVER.x + 14, z0: jumpRow - 6, x1: RIVER.x + 21.5, z1: jumpRow + 6, axis: 'x', h0: 3, h1: 0, solid: true, thickness: 0, kind: 'kicker' });
    this.surfaces.push({ x0: RIVER.x - 21.5, z0: jumpRow - 6, x1: RIVER.x - 14, z1: jumpRow + 6, axis: 'x', h0: 0, h1: 3, solid: true, thickness: 0, kind: 'kicker' });
    for (const rx of [westRail, eastRail]) {
      for (const side of [-1, 1]) {
        const z0 = side < 0 ? jumpRow - HR : jumpRow + 6;
        const z1 = side < 0 ? jumpRow - 6 : jumpRow + HR;
        this.boxes.push({ x0: rx - 0.35, z0, x1: rx + 0.35, z1, y0: -1, y1: 1.1, kind: 'rail', blocksSight: false });
      }
    }
  }

  // ----------------------------------------------------------------- hill

  private buildHill(): void {
    const tz = HILL.tunnelZ;
    this.boxes.push({ x0: HILL.x0, z0: HILL.z0, x1: HILL.x1, z1: tz - HR, y0: -1, y1: 40, kind: 'hill', blocksSight: true });
    this.boxes.push({ x0: HILL.x0, z0: tz + HR, x1: HILL.x1, z1: HILL.z1, y0: -1, y1: 40, kind: 'hill', blocksSight: true });
  }

  private buildRoundabouts(): void {
    for (const r of this.roundabouts) {
      this.circles.push({ x: r.x, z: r.z, r: ROUNDABOUT.island, y0: -1, y1: 2.5 });
    }
  }

  private buildBoundary(): void {
    const e = CITY_HALF + HR + 1;
    const t = 2;
    this.boxes.push({ x0: -e - t, z0: -e - t, x1: e + t, z1: -e, y0: -1, y1: 8, kind: 'wall', blocksSight: true });
    this.boxes.push({ x0: -e - t, z0: e, x1: e + t, z1: e + t, y0: -1, y1: 8, kind: 'wall', blocksSight: true });
    this.boxes.push({ x0: -e - t, z0: -e, x1: -e, z1: e, y0: -1, y1: 8, kind: 'wall', blocksSight: true });
    this.boxes.push({ x0: e, z0: -e, x1: e + t, z1: e, y0: -1, y1: 8, kind: 'wall', blocksSight: true });
  }

  private underAnyDeckCorridor(x: number, z: number, pad: number): boolean {
    for (const hw of HIGHWAYS) {
      const v = hw.axis === 'x' ? z - hw.line : x - hw.line;
      const u = hw.axis === 'x' ? x : z;
      if (Math.abs(v) < hw.width / 2 + pad && Math.abs(u) < hw.rampEnd + 2) return true;
    }
    return false;
  }

  private nearRoundaboutPoint(x: number, z: number, r: number): boolean {
    return this.roundabouts.some((p) => Math.hypot(p.x - x, p.z - z) < r);
  }

  private buildStreetFurniture(): void {
    const off = HR + 1.4;
    for (const seg of this.roads) {
      if (seg.kind !== 'street') continue;
      const dx = seg.bx - seg.ax;
      const dz = seg.bz - seg.az;
      const len = Math.hypot(dx, dz);
      if (len < 30) continue;
      const ux = dx / len;
      const uz = dz / len;
      for (let d = 22; d < len - 15; d += 26) {
        for (const side of [-1, 1]) {
          const x = seg.ax + ux * d + -uz * off * side;
          const z = seg.az + uz * d + ux * off * side;
          if (this.inRiverZone(x, z) || this.inHill(x, z) || Math.abs(x) > CITY_HALF + 6 || Math.abs(z) > CITY_HALF + 6) continue;
          if (this.underAnyDeckCorridor(x, z, 2) || this.nearRoundaboutPoint(x, z, ROUNDABOUT.outer + 4)) continue;
          if (this.blockedByLot(x, z)) continue;
          this.lamps.push({ x, z, rot: Math.atan2(uz * side, -ux * side) });
          this.boxes.push({ x0: x - 0.3, z0: z - 0.3, x1: x + 0.3, z1: z + 0.3, y0: -1, y1: 7, kind: 'prop', blocksSight: false });
        }
      }
    }
    for (let i = GRID.min + 1; i < GRID.max; i += 2) {
      for (let j = GRID.min + 1; j < GRID.max; j += 2) {
        if (CityLayout.isRoundabout(i, j)) continue;
        const x = i * S + HR + 1.2;
        const z = j * S + HR + 1.2;
        if (this.inRiverZone(x, z) || this.inHill(x, z) || this.underAnyDeckCorridor(x, z, 1)) continue;
        if (this.blockedByLot(x, z)) continue;
        this.trafficLights.push({ x, z, rot: 0 });
        this.boxes.push({ x0: x - 0.35, z0: z - 0.35, x1: x + 0.35, z1: z + 0.35, y0: -1, y1: 5.5, kind: 'prop', blocksSight: false });
      }
    }
  }

  private blockedByLot(x: number, z: number): boolean {
    for (const l of this.lots) if (x > l.x0 - 0.5 && x < l.x1 + 0.5 && z > l.z0 - 0.5 && z < l.z1 + 0.5) return true;
    return false;
  }

  // ------------------------------------------------------------- queries

  inRiverZone(x: number, _z: number): boolean {
    return x > RIVER.x - 22 && x < RIVER.x + 22;
  }

  inHill(x: number, z: number): boolean {
    return x > HILL.x0 - 1 && x < HILL.x1 + 1 && z > HILL.z0 - 1 && z < HILL.z1 + 1;
  }

  /** Base terrain height (river bed is below street level). */
  terrainHeight(x: number, z: number): number {
    if (x > RIVER.x - RIVER.halfWidth + 4 && x < RIVER.x + RIVER.halfWidth - 4) {
      for (const j of RIVER.bridgeRows) {
        if (Math.abs(z - j * S) < HR + 0.5) return 0;
      }
      return -9;
    }
    return 0;
  }

  surfaceHeight(s: Surface, x: number, z: number): number {
    const t = s.axis === 'x' ? (x - s.x0) / (s.x1 - s.x0) : (z - s.z0) / (s.z1 - s.z0);
    return s.h0 + (s.h1 - s.h0) * Math.min(1, Math.max(0, t));
  }

  /** Height of the highest drivable surface reachable from `y` (step tolerance included). */
  groundAt(x: number, z: number, y: number, step = 1.3): number {
    let best = this.terrainHeight(x, z);
    for (const s of this.surfaces) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const h = this.surfaceHeight(s, x, z);
      if (h <= y + step && h > best) best = h;
    }
    return best;
  }

  /** Surfaces too high to climb act as walls. Returns the blocking surface, if any. */
  blockingSurface(x: number, z: number, y: number, step = 1.3): Surface | null {
    for (const s of this.surfaces) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const h = this.surfaceHeight(s, x, z);
      if (h <= y + step) continue;
      if (s.solid) return s;
      if (y + 2.4 > h - s.thickness) return s;
    }
    return null;
  }

  /** True when a point is covered by an elevated deck/ramp overhead (hidden from helicopters). */
  underDeck(x: number, y: number, z: number): boolean {
    for (const s of this.surfaces) {
      if (s.solid || x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      if (this.surfaceHeight(s, x, z) > y + 4) return true;
    }
    return false;
  }

  /** Lowest overhead surface above a point (for camera clamping). */
  ceilingAbove(x: number, y: number, z: number): number {
    let best = Infinity;
    for (const s of this.surfaces) {
      if (s.solid || x < s.x0 - 2 || x > s.x1 + 2 || z < s.z0 - 2 || z > s.z1 + 2) continue;
      const h = this.surfaceHeight(s, Math.max(s.x0, Math.min(x, s.x1)), Math.max(s.z0, Math.min(z, s.z1))) - s.thickness;
      if (h > y + 2.5 && h < best) best = h;
    }
    return best;
  }

  private key(cx: number, cz: number): number {
    return (cx + 512) * 4096 + (cz + 512);
  }

  private insertHash(index: number): void {
    const b = this.boxes[index];
    const cx0 = Math.floor(b.x0 / this.cell);
    const cx1 = Math.floor(b.x1 / this.cell);
    const cz0 = Math.floor(b.z0 / this.cell);
    const cz1 = Math.floor(b.z1 / this.cell);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cz = cz0; cz <= cz1; cz += 1) {
        const k = this.key(cx, cz);
        let list = this.hash.get(k);
        if (!list) {
          list = [];
          this.hash.set(k, list);
        }
        list.push(index);
      }
    }
  }

  private stamp = 0;
  private readonly stamps: number[] = [];
  /** Box indices near a point (fills `out`, de-duplicated by stamp). */
  queryBoxes(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    this.stamp += 1;
    const cx0 = Math.floor((x - radius) / this.cell);
    const cx1 = Math.floor((x + radius) / this.cell);
    const cz0 = Math.floor((z - radius) / this.cell);
    const cz1 = Math.floor((z + radius) / this.cell);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cz = cz0; cz <= cz1; cz += 1) {
        const list = this.hash.get(this.key(cx, cz));
        if (!list) continue;
        for (const idx of list) {
          if (this.stamps[idx] === this.stamp) continue;
          this.stamps[idx] = this.stamp;
          out.push(idx);
        }
      }
    }
    return out;
  }

  /** Is (x,z) inside any solid at height y (boxes, circles, unclimbable surfaces)? `pad` grows obstacles. */
  isBlocked(x: number, z: number, y: number, pad = 0.6, scratch: number[] = []): boolean {
    this.queryBoxes(x, z, 0.1 + pad, scratch);
    for (const i of scratch) {
      const b = this.boxes[i];
      if (y >= b.y1 - 0.2 || y + 1.4 <= b.y0) continue;
      if (x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad) return true;
    }
    for (const c of this.circles) {
      if (y >= c.y1 || y + 1.4 <= c.y0) continue;
      if (Math.hypot(x - c.x, z - c.z) < c.r + pad) return true;
    }
    return this.blockingSurface(x, z, y) !== null;
  }

  private readonly losScratch: number[] = [];
  /** Coarse line of sight test against sight-blocking boxes (buildings, hill, walls). */
  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(dist / 5);
    for (let s = 1; s < steps; s += 1) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      this.queryBoxes(x, z, 0.1, this.losScratch);
      for (const idx of this.losScratch) {
        const b = this.boxes[idx];
        if (!b.blocksSight) continue;
        if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return false;
      }
    }
    return true;
  }

  /** Which level a car is on: 'ground' or the id of the highway whose roadway it is riding. */
  levelAt(x: number, y: number, z: number): string {
    for (const hw of HIGHWAYS) {
      const v = hw.axis === 'x' ? z - hw.line : x - hw.line;
      const u = hw.axis === 'x' ? x : z;
      if (Math.abs(v) > hw.width / 2 + 1) continue;
      const h = hwHeightAt(hw, u);
      if (h !== null && h > 2.5 && Math.abs(y - h) < 2.5) return hw.id;
    }
    return 'ground';
  }

  /** Nearest graph node on the level the car is on. */
  nearestNode(x: number, z: number, y: number): number {
    const level = this.levelAt(x, y, z);
    let best = -1;
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (n.edges.length === 0 || n.level !== level) continue;
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  }

  /** A* over the road graph. Returns node ids from start to goal (inclusive). */
  findPath(start: number, goal: number, out: number[]): number[] {
    out.length = 0;
    if (start < 0 || goal < 0) return out;
    const n = this.nodes.length;
    const g = new Float32Array(n).fill(Infinity);
    const f = new Float32Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const open: number[] = [start];
    const closed = new Uint8Array(n);
    g[start] = 0;
    f[start] = this.h(start, goal);
    while (open.length) {
      let bi = 0;
      for (let k = 1; k < open.length; k += 1) if (f[open[k]] < f[open[bi]]) bi = k;
      const cur = open[bi];
      open.splice(bi, 1);
      if (cur === goal) break;
      closed[cur] = 1;
      for (const nb of this.nodes[cur].edges) {
        if (closed[nb]) continue;
        const a = this.nodes[cur];
        const b = this.nodes[nb];
        const cost = g[cur] + Math.hypot(a.x - b.x, a.z - b.z);
        if (cost < g[nb]) {
          came[nb] = cur;
          g[nb] = cost;
          f[nb] = cost + this.h(nb, goal);
          if (!open.includes(nb)) open.push(nb);
        }
      }
    }
    if (came[goal] < 0 && goal !== start) return out;
    let c = goal;
    while (c >= 0) {
      out.push(c);
      if (c === start) break;
      c = came[c];
    }
    out.reverse();
    return out;
  }

  private h(a: number, b: number): number {
    const na = this.nodes[a];
    const nb = this.nodes[b];
    return Math.hypot(na.x - nb.x, na.z - nb.z);
  }

  /**
   * Waypoint for travelling from node `prev` toward node `node`, offset into the right-hand lane.
   * Roundabouts are passed around the island instead of through its centre.
   */
  laneTarget(prevId: number | null, nodeId: number, lane: number, out: { x: number; z: number }): void {
    const node = this.nodes[nodeId];
    let dx = 0;
    let dz = 1;
    if (prevId !== null) {
      const prev = this.nodes[prevId];
      const l = Math.hypot(node.x - prev.x, node.z - prev.z) || 1;
      dx = (node.x - prev.x) / l;
      dz = (node.z - prev.z) / l;
    }
    const rx = -dz;
    const rz = dx;
    if (node.roundabout) {
      const r = ROUNDABOUT.island + 4.5;
      out.x = node.x + rx * r;
      out.z = node.z + rz * r;
      return;
    }
    out.x = node.x + rx * lane;
    out.z = node.z + rz * lane;
  }

  /** Random point on a ground road segment (for spawns, pickups). */
  randomRoadPoint(rand: () => number, kinds: RoadKind[] = ['street', 'bridge', 'tunnel']): { x: number; z: number; dirX: number; dirZ: number } {
    for (let tries = 0; tries < 60; tries += 1) {
      const seg = this.roads[Math.floor(rand() * this.roads.length)];
      if (!kinds.includes(seg.kind)) continue;
      const t = 0.25 + rand() * 0.5;
      const x = seg.ax + (seg.bx - seg.ax) * t;
      const z = seg.az + (seg.bz - seg.az) * t;
      if (this.nearRoundaboutPoint(x, z, ROUNDABOUT.outer + 2)) continue;
      const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
      return { x, z, dirX: (seg.bx - seg.ax) / len, dirZ: (seg.bz - seg.az) / len };
    }
    return { x: 0, z: -4, dirX: 1, dirZ: 0 };
  }
}
