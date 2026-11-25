/// <reference types="vite/client" />

interface ThreeGameDiagnostics {
  frame: number;
  elapsed: number;
  score: number;
  targetScore: number;
  complete: boolean;
  state?: string;
  stars?: number;
  heat?: number;
  health?: number;
  cops?: number;
  helicopters?: number;
  spotted?: boolean;
  takedowns?: number;
  fps?: number;
  overReason?: string;
  dmg?: { wall: number; cop: number; civ: number };
  stalled?: { cops: number; civs: number };
  player: {
    position: { x: number; y: number; z: number };
    speed: number;
  };
  renderer: {
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
  };
  canvas: {
    clientWidth: number;
    clientHeight: number;
    width: number;
    height: number;
    dpr: number;
  };
}

interface ThreeGameTestHooks {
  /** Re-seed the game RNG; all gameplay randomness must flow through it. */
  seed(value: number): void | Promise<void>;
  /** Acknowledge after setup/assets are ready; throw for unknown states. */
  setState(name: string): { state: string } | Promise<{ state: string }>;
  /** Stop simulation/state transitions immediately; keep rendering. Await optional synchronization. */
  setPausedForScreenshot(paused: boolean): void | Promise<void>;
  /** Stabilize ambient/idle visuals without requiring an unpaused simulation tick. */
  setReducedMotion(enabled: boolean): void | Promise<void>;
  /** Hide debug UI (lil-gui) before capturing. */
  hideDebugUi(hidden: boolean): void | Promise<void>;
  /** Let the built-in route-following driver steer the player (bot playtests). */
  setAutopilot?(on: boolean): void;
  /** Run the fixed-step simulation headlessly for N seconds (no rendering). */
  advance?(seconds: number): ThreeGameDiagnostics | undefined;
  teleport?(x: number, z: number, heading: number, speed: number, throttle?: number): void;
  track?(seconds: number): unknown[];
  viewFrom?(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void;
}

interface Window {
  __THREE_GAME_DIAGNOSTICS__?: ThreeGameDiagnostics;
  __THREE_GAME_TEST_HOOKS__?: ThreeGameTestHooks;
}
