import GUI from 'lil-gui';

export interface DebugTuning {
  exposure: number;
  bloomStrength: number;
  bloomThreshold: number;
  maxDpr: number;
  godMode: boolean;
  freezeHeat: boolean;
}

/** lil-gui panel, enabled with ?debug in the URL. */
export class DebugTools {
  private gui: GUI | null = null;

  constructor(tuning: DebugTuning, onChange: () => void) {
    if (!new URLSearchParams(window.location.search).has('debug')) return;
    this.gui = new GUI({ title: 'Runaway City tuning' });
    this.gui.add(tuning, 'exposure', 0.4, 2, 0.01).onChange(onChange);
    this.gui.add(tuning, 'bloomStrength', 0, 2, 0.01).onChange(onChange);
    this.gui.add(tuning, 'bloomThreshold', 0, 1.5, 0.01).onChange(onChange);
    this.gui.add(tuning, 'maxDpr', 0.75, 2, 0.25).onChange(onChange);
    this.gui.add(tuning, 'godMode');
    this.gui.add(tuning, 'freezeHeat');
  }

  setHidden(hidden: boolean): void {
    if (!this.gui) return;
    if (hidden) this.gui.hide();
    else this.gui.show();
  }

  dispose(): void {
    this.gui?.destroy();
    this.gui = null;
  }
}
