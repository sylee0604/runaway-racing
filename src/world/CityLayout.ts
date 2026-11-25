import { CITY_HALF, GRID, HIGHWAY, HILL, RIVER } from '../game/config';
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
  level: 'ground' | 'highway';
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
  type: 'city' | 'river' | 'hill' | 'plaza' | 'park';
}

const S = GRID.spacing;
const HALF_ROAD = GRID.roadWidth / 2;

export class CityLayout {
  readonly boxes: Box[] = [];
  readonly surfaces: Surface[] = [];
  readonly roads: RoadSegment[] = [];
  readonly nodes: GraphNode[] = [];
  readonly lots: Lot[] = [];
  readonly blocks: BlockInfo[] = [];
  readonly lamps: { x: number; z: number; rot: number }[] = [];
  readonly trees: { x: number; z: number; s: number }[] = [];
  readonly trafficLights: { x: number; z: number; rot: number }[] = [];
  readonly fountain = { x: 30, z: 30, r: 5 };

  private readonly hash = new Map<number, number[]>();
  private readonly cell = 16;
  private readonly nodeIndex = new Map<string, number>();
  private readonly rng = createSeededRandom(1337);

  constructor() {
    this.buildRoads();
    this.buildBlocks();
    this.buildHighway();
    this.buildRiver();
    this.buildHill();
    this.buildBoundary();
    this.buildStreetFurniture();
    for (let i = 0; i < this.boxes.length; i += 1) this.insertHash(i);
  }

  // ---------------------------------------------------------------- roads

  static hasHorizontal(i: number, j: number): RoadKind | null {
    // segment along x on row j between column i and i+1
    if (i === -3) return RIVER.bridgeRows.includes(j) ? 'bridge' : null;
    if (j === -1 && (i === -4 || i === 3)) return null; // replaced by highway ramps
    if (j === 3 && i >= 1 && i <= 3) return 'tunnel';
    return 'street';
  }

  static hasVertical(i: number, j: number): RoadKind | null {
    // segment along z on column i between row j and j+1
    if ((i === 2 || i === 3) && (j === 2 || j === 3)) return null; // inside the hill
    return 'street';
  }

  private nodeAt(i: number, j: number, level: 'ground' | 'highway' = 'ground'): number {
    const key = `${level}:${i}:${j}`;
    const existing = this.nodeIndex.get(key);
    if (existing !== undefined) return existing;
    const id = this.nodes.length;
    this.nodes.push({ id, x: i * S, z: j * S, y: level === 'highway' ? HIGHWAY.height : 0, edges: [], level });
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
    if (bi === -3) return 'river';
    if (bi >= 1 && bi <= 3 && bj >= 2 && bj <= 3) return 'hill';
    if (bi === 0 && bj === 0) return 'plaza';
    if (bi === -2 && bj === 1) return 'park';
    return 'city';
  }

  private buildBlocks(): void {
    for (let bj = GRID.min; bj < GRID.max; bj += 1) {
      for (let bi = GRID.min; bi < GRID.max; bi += 1) {
        const x0 = bi * S + HALF_ROAD;
        const x1 = (bi + 1) * S - HALF_ROAD;
        const z0 = bj * S + HALF_ROAD;
        const z1 = (bj + 1) * S - HALF_ROAD;
        const type = this.blockType(bi, bj);
        this.blocks.push({ bi, bj, x0, z0, x1, z1, type });
        if (type === 'city') this.fillCityBlock(x0, z0, x1, z1);
        if (type === 'plaza') this.fillPlaza(x0, z0, x1, z1);
        if (type === 'park') this.fillPark(x0, z0, x1, z1);
      }
    }
  }

  private fillCityBlock(bx0: number, bz0: number, bx1: number, bz1: number): void {
    const inset = GRID.sidewalk;
    const x0 = bx0 + inset;
    const x1 = bx1 - inset;
    const z0 = bz0 + inset;
    const z1 = bz1 - inset;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const downtown = Math.max(0, 1 - Math.hypot(cx - 20, cz + 20) / 230);
    const r = this.rng();
    const alley = this.rng() < 0.4;
    const gap = alley ? 7 : 1.5;

    const pushLot = (lx0: number, lz0: number, lx1: number, lz1: number) => {
      const height = 12 + this.rng() * 26 + downtown * downtown * (40 + this.rng() * 55);
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

  private fillPlaza(_x0: number, _z0: number, _x1: number, _z1: number): void {
    const f = this.fountain;
    this.boxes.push({ x0: f.x - f.r, z0: f.z - f.r, x1: f.x + f.r, z1: f.z + f.r, y0: -1, y1: 3, kind: 'prop', blocksSight: false });
    // Two kicker ramps that launch the car across the plaza.
    this.surfaces.push({ x0: 14, z0: 16, x1: 22, z1: 27, axis: 'z', h0: 0, h1: 2.6, solid: true, thickness: 0, kind: 'kicker' });
    this.surfaces.push({ x0: 38, z0: 33, x1: 46, z1: 44, axis: 'z', h0: 2.6, h1: 0, solid: true, thickness: 0, kind: 'kicker' });
    // Bollards around the plaza edge leave wide openings.
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
      const s = 0.8 + this.rng() * 0.7;
      this.trees.push({ x, z, s });
      this.boxes.push({ x0: x - 0.5, z0: z - 0.5, x1: x + 0.5, z1: z + 0.5, y0: -1, y1: 6, kind: 'prop', blocksSight: false });
    }
  }

  // -------------------------------------------------------------- highway

  private buildHighway(): void {
    const z = HIGHWAY.z;
    const hw = HIGHWAY.width / 2;
    const h = HIGHWAY.height;
    const L = HIGHWAY.deckHalfLength;
    const R = HIGHWAY.rampEnd;
    this.surfaces.push({ x0: -L, z0: z - hw, x1: L, z1: z + hw, axis: 'x', h0: h, h1: h, solid: false, thickness: 1.2, kind: 'deck' });
    this.surfaces.push({ x0: L, z0: z - hw, x1: R, z1: z + hw, axis: 'x', h0: h, h1: 0, solid: true, thickness: 0, kind: 'ramp' });
    this.surfaces.push({ x0: -R, z0: z - hw, x1: -L, z1: z + hw, axis: 'x', h0: 0, h1: h, solid: true, thickness: 0, kind: 'ramp' });

    // Deck rails (only collide with cars up on the deck).
    for (const side of [-1, 1]) {
      const rz = z + side * (hw + 0.4);
      this.boxes.push({ x0: -L, z0: rz - 0.4, x1: L, z1: rz + 0.4, y0: h - 0.8, y1: h + 1.3, kind: 'rail', blocksSight: false });
      for (const dir of [-1, 1]) {
        const a = dir > 0 ? L : -R;
        const b = dir > 0 ? R : -L;
        this.boxes.push({ x0: a, z0: rz - 0.4, x1: b, z1: rz + 0.4, y0: -1, y1: h + 1.3, kind: 'rail', blocksSight: false });
      }
    }

    // Pillars down the middle of the street underneath: the "under-bridge road".
    for (let x = -165; x <= 165; x += 30) {
      this.boxes.push({ x0: x - 1.3, z0: z - 1.3, x1: x + 1.3, z1: z + 1.3, y0: -1, y1: h - 1.2, kind: 'pillar', blocksSight: false });
    }

    // Highway graph nodes linked to the ground at both ramp ends.
    let prev = -1;
    for (let i = -3; i <= 3; i += 1) {
      const id = this.nodeAt(i, -1, 'highway');
      if (prev >= 0) this.link(prev, id);
      prev = id;
    }
    this.link(this.nodeAt(-3, -1, 'highway'), this.nodeAt(-4, -1));
    this.link(this.nodeAt(3, -1, 'highway'), this.nodeAt(4, -1));
    this.roads.push({ ax: -L, az: z, bx: L, bz: z, y0: h, y1: h, kind: 'highway', width: HIGHWAY.width });
    this.roads.push({ ax: L, az: z, bx: R, bz: z, y0: h, y1: 0, kind: 'ramp', width: HIGHWAY.width });
    this.roads.push({ ax: -R, az: z, bx: -L, bz: z, y0: 0, y1: h, kind: 'ramp', width: HIGHWAY.width });
    // short ground stubs from ramp feet to the perimeter intersections
    this.roads.push({ ax: R, az: z, bx: CITY_HALF, bz: z, y0: 0, y1: 0, kind: 'street', width: HIGHWAY.width });
    this.roads.push({ ax: -CITY_HALF, az: z, bx: -R, bz: z, y0: 0, y1: 0, kind: 'street', width: HIGHWAY.width });
  }

  // ---------------------------------------------------------------- river

  private buildRiver(): void {
    const eastRail = RIVER.x + 22; // -128
    const westRail = RIVER.x - 22; // -172
    const gaps = RIVER.bridgeRows.map((j) => j * S);
    const jumpRow = 1 * S;
    for (const rx of [westRail, eastRail]) {
      let start = -CITY_HALF - 8;
      const cuts = [...gaps, jumpRow].sort((a, b) => a - b);
      for (const g of cuts) {
        this.boxes.push({ x0: rx - 0.35, z0: start, x1: rx + 0.35, z1: g - HALF_ROAD, y0: -1, y1: 1.1, kind: 'rail', blocksSight: false });
        start = g + HALF_ROAD;
      }
      this.boxes.push({ x0: rx - 0.35, z0: start, x1: rx + 0.35, z1: CITY_HALF + 8, y0: -1, y1: 1.1, kind: 'rail', blocksSight: false });
    }
    for (const g of gaps) {
      for (const side of [-1, 1]) {
        const rz = g + side * (HALF_ROAD + 0.35);
        this.boxes.push({ x0: westRail, z0: rz - 0.35, x1: eastRail, z1: rz + 0.35, y0: -1, y1: 1.2, kind: 'rail', blocksSight: false });
      }
    }
    // River-jump kickers on both embankments of row j=1 (no bridge there).
    this.surfaces.push({ x0: RIVER.x + 14, z0: jumpRow - 6, x1: RIVER.x + 21.5, z1: jumpRow + 6, axis: 'x', h0: 3, h1: 0, solid: true, thickness: 0, kind: 'kicker' });
    this.surfaces.push({ x0: RIVER.x - 21.5, z0: jumpRow - 6, x1: RIVER.x - 14, z1: jumpRow + 6, axis: 'x', h0: 0, h1: 3, solid: true, thickness: 0, kind: 'kicker' });
    // Short barriers either side of the jump lane so the gap is only the kicker.
    for (const rx of [westRail, eastRail]) {
      for (const side of [-1, 1]) {
        const z0 = side < 0 ? jumpRow - HALF_ROAD : jumpRow + 6;
        const z1 = side < 0 ? jumpRow - 6 : jumpRow + HALF_ROAD;
        this.boxes.push({ x0: rx - 0.35, z0, x1: rx + 0.35, z1, y0: -1, y1: 1.1, kind: 'rail', blocksSight: false });
      }
    }
  }

  // ----------------------------------------------------------------- hill

  private buildHill(): void {
    const tz = HILL.tunnelZ;
    this.boxes.push({ x0: HILL.x0, z0: HILL.z0, x1: HILL.x1, z1: tz - HALF_ROAD, y0: -1, y1: 40, kind: 'hill', blocksSight: true });
    this.boxes.push({ x0: HILL.x0, z0: tz + HALF_ROAD, x1: HILL.x1, z1: HILL.z1, y0: -1, y1: 40, kind: 'hill', blocksSight: true });
  }

  private buildBoundary(): void {
    const e = CITY_HALF + HALF_ROAD + 1;
    const t = 2;
    this.boxes.push({ x0: -e - t, z0: -e - t, x1: e + t, z1: -e, y0: -1, y1: 8, kind: 'wall', blocksSight: true });
    this.boxes.push({ x0: -e - t, z0: e, x1: e + t, z1: e + t, y0: -1, y1: 8, kind: 'wall', blocksSight: true });
    this.boxes.push({ x0: -e - t, z0: -e, x1: -e, z1: e, y0: -1, y1: 8, kind: 'wall', blocksSight: true });
    this.boxes.push({ x0: e, z0: -e, x1: e + t, z1: e, y0: -1, y1: 8, kind: 'wall', blocksSight: true });
  }

  private buildStreetFurniture(): void {
    const off = HALF_ROAD + 1.4;
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
          if (Math.abs(z - HIGHWAY.z) < 10 && Math.abs(x) < HIGHWAY.rampEnd) continue;
          this.lamps.push({ x, z, rot: Math.atan2(uz * side, -ux * side) });
          this.boxes.push({ x0: x - 0.3, z0: z - 0.3, x1: x + 0.3, z1: z + 0.3, y0: -1, y1: 7, kind: 'prop', blocksSight: false });
        }
      }
    }
    for (let i = GRID.min + 1; i < GRID.max; i += 2) {
      for (let j = GRID.min + 1; j < GRID.max; j += 2) {
        const x = i * S + HALF_ROAD + 1.2;
        const z = j * S + HALF_ROAD + 1.2;
        if (this.inRiverZone(x, z) || this.inHill(x, z)) continue;
        this.trafficLights.push({ x, z, rot: 0 });
      }
    }
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
        if (Math.abs(z - j * S) < HALF_ROAD + 0.5) return 0;
      }
      return -9;
    }
    return 0;
  }

  surfaceHeight(s: Surface, x: number, z: number): number {
    const t = s.axis === 'x' ? (x - s.x0) / (s.x1 - s.x0) : (z - s.z0) / (s.z1 - s.z0);
    return s.h0 + (s.h1 - s.h0) * Math.min(1, Math.max(0, t));
  }

  /**
   * Height of the highest drivable surface reachable from `y` (step tolerance included).
   * Returns the surface the car should rest on.
   */
  groundAt(x: number, z: number, y: number, step = 1.3): number {
    let best = this.terrainHeight(x, z);
    for (const s of this.surfaces) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const h = this.surfaceHeight(s, x, z);
      if (h <= y + step && h > best) best = h;
    }
    return best;
  }

  /** Solid surfaces that are too high to climb act as walls. Returns the blocking surface, if any. */
  blockingSurface(x: number, z: number, y: number, step = 1.3): Surface | null {
    for (const s of this.surfaces) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      const h = this.surfaceHeight(s, x, z);
      if (h <= y + step) continue;
      if (s.solid) return s;
      // thin deck: blocked only if the car is not fully underneath it
      if (y + 2.4 > h - s.thickness) return s;
    }
    return null;
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

  /** Box indices near a point (fills `out`, de-duplicated by stamp). */
  private stamp = 0;
  private readonly stamps: number[] = [];
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

  /** Nearest graph node, preferring the level the car is on. */
  nearestNode(x: number, z: number, y: number): number {
    const wantHighway = y > HIGHWAY.height * 0.55 && Math.abs(z - HIGHWAY.z) < 12;
    let best = -1;
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (n.edges.length === 0) continue;
      if ((n.level === 'highway') !== wantHighway) continue;
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

  /** Random point on a ground street road segment (for spawns, pickups). */
  randomRoadPoint(rand: () => number, kinds: RoadKind[] = ['street', 'bridge', 'tunnel']): { x: number; z: number; dirX: number; dirZ: number } {
    for (let tries = 0; tries < 50; tries += 1) {
      const seg = this.roads[Math.floor(rand() * this.roads.length)];
      if (!kinds.includes(seg.kind)) continue;
      const t = 0.2 + rand() * 0.6;
      const x = seg.ax + (seg.bx - seg.ax) * t;
      const z = seg.az + (seg.bz - seg.az) * t;
      if (Math.abs(z - HIGHWAY.z) < 3 && Math.abs(x) < HIGHWAY.deckHalfLength) continue; // pillar line
      const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
      return { x, z, dirX: (seg.bx - seg.ax) / len, dirZ: (seg.bz - seg.az) / len };
    }
    return { x: 0, z: -4, dirX: 1, dirZ: 0 };
  }
}
