/** Central tuning constants. Values are in meters, seconds, m/s. */

export const GRID = {
  spacing: 60,
  min: -6,
  max: 6,
  roadWidth: 16,
  sidewalk: 3,
} as const;

export const CITY_HALF = GRID.spacing * GRID.max; // 360

export interface HighwayDef {
  id: string;
  axis: 'x' | 'z'; // direction the deck runs along
  line: number; // the other coordinate of its centreline (road it sits over)
  height: number;
  deckHalf: number; // deck spans [-deckHalf, deckHalf] along the axis
  rampEnd: number; // ramps reach the ground at ±rampEnd
  width: number;
}

/** Two elevated expressways: A runs east-west at 10 m, B runs north-south at 16 m and crosses over A. */
export const HIGHWAYS: HighwayDef[] = [
  { id: 'A', axis: 'x', line: -120, height: 10, deckHalf: 308, rampEnd: 352, width: 16 },
  { id: 'B', axis: 'z', line: 120, height: 16, deckHalf: 248, rampEnd: 352, width: 16 },
];

/** Kept for code that only needs the first expressway. */
export const HIGHWAY = {
  z: HIGHWAYS[0].line,
  height: HIGHWAYS[0].height,
  deckHalfLength: HIGHWAYS[0].deckHalf,
  rampEnd: HIGHWAYS[0].rampEnd,
  width: HIGHWAYS[0].width,
} as const;

export const RIVER = {
  x: -210,
  halfWidth: 18,
  bridgeRows: [-6, -3, 0, 2, 5] as number[],
  jumpRow: -4,
  waterY: -4.5,
} as const;

export const HILL = {
  x0: 188,
  x1: 352,
  z0: 128,
  z1: 232,
  tunnelZ: 180,
} as const;

/** Grid nodes (i, j) that are roundabouts instead of plain crossings. */
export const ROUNDABOUTS: [number, number][] = [
  [0, 3],
  [4, -4],
  [-2, -5],
  [5, 0],
];
export const ROUNDABOUT = { island: 9, outer: 19 } as const;

export interface VehicleSpec {
  name: string;
  maxSpeed: number;
  accel: number;
  reverseSpeed: number;
  brake: number;
  steerRate: number;
  grip: number;
  driftGrip: number;
  drag: number;
  mass: number;
  radius: number;
  halfLength: number;
  health: number;
  ramDamage: number; // damage multiplier dealt to others
}

export const SPECS: Record<string, VehicleSpec> = {
  player: {
    name: 'player',
    maxSpeed: 44,
    accel: 24,
    reverseSpeed: 14,
    brake: 40,
    steerRate: 2.5,
    grip: 9,
    driftGrip: 1.6,
    drag: 0.12,
    mass: 1.2,
    radius: 1.05,
    halfLength: 1.25,
    health: 100,
    ramDamage: 1,
  },
  patrol: {
    name: 'patrol',
    maxSpeed: 37,
    accel: 19,
    reverseSpeed: 12,
    brake: 36,
    steerRate: 2.2,
    grip: 8,
    driftGrip: 2,
    drag: 0.12,
    mass: 1.2,
    radius: 1.05,
    halfLength: 1.3,
    health: 60,
    ramDamage: 1,
  },
  interceptor: {
    name: 'interceptor',
    maxSpeed: 46,
    accel: 26,
    reverseSpeed: 14,
    brake: 42,
    steerRate: 2.5,
    grip: 9,
    driftGrip: 2,
    drag: 0.11,
    mass: 1.25,
    radius: 1.05,
    halfLength: 1.35,
    health: 70,
    ramDamage: 1.15,
  },
  swat: {
    name: 'swat',
    maxSpeed: 34,
    accel: 15,
    reverseSpeed: 10,
    brake: 30,
    steerRate: 1.7,
    grip: 9,
    driftGrip: 3,
    drag: 0.13,
    mass: 3.2,
    radius: 1.35,
    halfLength: 2.1,
    health: 160,
    ramDamage: 1.8,
  },
  apc: {
    name: 'apc',
    maxSpeed: 31,
    accel: 13,
    reverseSpeed: 9,
    brake: 28,
    steerRate: 1.5,
    grip: 10,
    driftGrip: 4,
    drag: 0.14,
    mass: 6,
    radius: 1.55,
    halfLength: 2.5,
    health: 320,
    ramDamage: 2.6,
  },
  civilian: {
    name: 'civilian',
    maxSpeed: 15,
    accel: 8,
    reverseSpeed: 6,
    brake: 20,
    steerRate: 1.8,
    grip: 9,
    driftGrip: 3,
    drag: 0.2,
    mass: 1.1,
    radius: 1.05,
    halfLength: 1.3,
    health: 40,
    ramDamage: 0.6,
  },
};

export const PLAYER_NITRO = {
  maxSpeedBonus: 14,
  accelBonus: 22,
  drainPerSec: 0.34,
  start: 0.6,
};

export interface HeatLevel {
  stars: number;
  threshold: number; // heat value needed
  maxCops: number;
  weights: { patrol: number; interceptor: number; swat: number; apc: number };
  helicopters: number;
  roadblocks: boolean;
  spikes: boolean;
  aggression: number; // 0..1 how much cops lead/ram
  label: string;
}

export const HEAT_LEVELS: HeatLevel[] = [
  { stars: 1, threshold: 0, maxCops: 2, weights: { patrol: 1, interceptor: 0, swat: 0, apc: 0 }, helicopters: 0, roadblocks: false, spikes: false, aggression: 0.3, label: '순찰차가 추격 중' },
  { stars: 2, threshold: 30, maxCops: 4, weights: { patrol: 0.7, interceptor: 0.3, swat: 0, apc: 0 }, helicopters: 0, roadblocks: false, spikes: false, aggression: 0.5, label: '고속 인터셉터 투입' },
  { stars: 3, threshold: 70, maxCops: 5, weights: { patrol: 0.5, interceptor: 0.5, swat: 0, apc: 0 }, helicopters: 1, roadblocks: false, spikes: false, aggression: 0.7, label: '경찰 헬기 출동 — 서치라이트를 피하라' },
  { stars: 4, threshold: 120, maxCops: 7, weights: { patrol: 0.3, interceptor: 0.4, swat: 0.3, apc: 0 }, helicopters: 1, roadblocks: true, spikes: true, aggression: 0.85, label: 'SWAT 장갑트럭 · 바리케이드 · 스파이크' },
  { stars: 5, threshold: 180, maxCops: 9, weights: { patrol: 0.2, interceptor: 0.35, swat: 0.25, apc: 0.2 }, helicopters: 2, roadblocks: true, spikes: true, aggression: 1, label: '군 장갑차 · 헬기 2대 — 최고 수배' },
];

export const HEAT_PER_SECOND = 1;
export const HEAT_PER_TAKEDOWN = 12;

export const BUSTED = {
  radius: 7.5,
  speedBelow: 4,
  seconds: 2.6,
};

export const SCORE = {
  perSecondBase: 10,
  takedown: 500,
  cash: 250,
};

export const TRAFFIC_COUNT = 30;
