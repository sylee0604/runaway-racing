export interface DriveIntent {
  throttle: number;
  steer: number; // +1 left, -1 right (heading convention)
  handbrake: boolean;
  nitro: boolean;
  lookBack: boolean;
}

type Action = 'left' | 'right' | 'gas' | 'brake' | 'drift' | 'nitro';

/** Keyboard + gamepad + touch buttons → driving intents and one-shot commands. */
export class InputController {
  private readonly keys = new Set<string>();
  private readonly touch = new Set<Action>();
  private readonly pressed = new Set<string>();
  private readonly cleanups: (() => void)[] = [];
  private steerSmooth = 0;

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (!this.keys.has(e.code)) this.pressed.add(e.code);
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private readonly onBlur = () => {
    this.keys.clear();
    this.touch.clear();
  };

  constructor(touchRoot: HTMLElement | null) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    if (touchRoot) {
      touchRoot.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
        const action = el.dataset.action as Action;
        const down = (e: PointerEvent) => {
          e.preventDefault();
          this.touch.add(action);
          el.classList.add('is-pressed');
          try {
            el.setPointerCapture(e.pointerId);
          } catch {
            /* synthetic events */
          }
        };
        const up = (e: PointerEvent) => {
          e.preventDefault();
          this.touch.delete(action);
          el.classList.remove('is-pressed');
        };
        el.addEventListener('pointerdown', down);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('lostpointercapture', up);
        this.cleanups.push(() => {
          el.removeEventListener('pointerdown', down);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          el.removeEventListener('lostpointercapture', up);
        });
      });
    }
  }

  /** True once per key press (consumed). */
  consume(...codes: string[]): boolean {
    let hit = false;
    for (const c of codes) {
      if (this.pressed.has(c)) {
        this.pressed.delete(c);
        hit = true;
      }
    }
    return hit;
  }

  clearPressed(): void {
    this.pressed.clear();
  }

  read(dt: number, out: DriveIntent): DriveIntent {
    const k = this.keys;
    let steer = 0;
    let throttle = 0;
    // Right hand on the arrow keys, left hand on Space / Shift / Z / X / C.
    if (k.has('ArrowLeft') || this.touch.has('left')) steer += 1;
    if (k.has('ArrowRight') || this.touch.has('right')) steer -= 1;
    if (k.has('ArrowUp') || this.touch.has('gas')) throttle += 1;
    if (k.has('ArrowDown') || this.touch.has('brake')) throttle -= 1;
    let handbrake = k.has('Space') || k.has('KeyX') || this.touch.has('drift');
    let nitro = k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyZ') || this.touch.has('nitro');

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const ax = pad.axes[0] ?? 0;
      if (Math.abs(ax) > 0.15) steer -= ax;
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      throttle += rt - lt;
      if (pad.buttons[0]?.pressed) throttle = Math.max(throttle, 1);
      if (pad.buttons[2]?.pressed || pad.buttons[5]?.pressed) handbrake = true;
      if (pad.buttons[1]?.pressed || pad.buttons[4]?.pressed) nitro = true;
      if (pad.buttons[9]?.pressed) this.pressed.add('Escape');
      break;
    }
    steer = Math.max(-1, Math.min(1, steer));
    // keyboard steering ramps in quickly but not instantly (prevents twitchy taps)
    const rate = steer === 0 ? 9 : 6;
    this.steerSmooth += (steer - this.steerSmooth) * Math.min(1, dt * rate);
    out.steer = Math.abs(this.steerSmooth) < 0.01 ? 0 : this.steerSmooth;
    out.throttle = Math.max(-1, Math.min(1, throttle));
    out.handbrake = handbrake;
    out.nitro = nitro;
    out.lookBack = k.has('KeyC');
    return out;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    for (const c of this.cleanups) c();
  }
}
