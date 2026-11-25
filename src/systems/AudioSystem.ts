/**
 * Fully procedural Web Audio: engine, sirens, helicopter chop, crashes,
 * pickups, alarms and a driving music loop. Starts on the first user gesture.
 */
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engineOsc: OscillatorNode[] = [];
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private sirenLfo: OscillatorNode | null = null;
  private heliGain: GainNode | null = null;
  private skidGain: GainNode | null = null;
  private nitroGain: GainNode | null = null;
  private musicTimer = 0;
  private musicStep = 0;
  private nextNoteTime = 0;
  private intensity = 1;
  muted = false;
  private running = false;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.22;
    this.musicBus.connect(this.master);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;

    // engine: two detuned saws through a low-pass
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 600;
    this.engineFilter.Q.value = 4;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.sfx);
    for (const [type, det] of [['sawtooth', 0], ['square', 7]] as [OscillatorType, number][]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 50;
      o.detune.value = det;
      o.connect(this.engineFilter);
      o.start();
      this.engineOsc.push(o);
    }

    // siren: triangle wail with LFO-driven pitch
    this.sirenOsc = ctx.createOscillator();
    this.sirenOsc.type = 'triangle';
    this.sirenOsc.frequency.value = 900;
    this.sirenLfo = ctx.createOscillator();
    this.sirenLfo.frequency.value = 0.55;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 380;
    this.sirenLfo.connect(lfoGain).connect(this.sirenOsc.frequency);
    this.sirenGain = ctx.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenOsc.connect(this.sirenGain).connect(this.sfx);
    this.sirenOsc.start();
    this.sirenLfo.start();

    // helicopter: band-passed noise, amplitude-chopped
    const heliSrc = ctx.createBufferSource();
    heliSrc.buffer = this.noise;
    heliSrc.loop = true;
    const heliBp = ctx.createBiquadFilter();
    heliBp.type = 'lowpass';
    heliBp.frequency.value = 260;
    const chop = ctx.createGain();
    chop.gain.value = 0.5;
    const chopLfo = ctx.createOscillator();
    chopLfo.type = 'square';
    chopLfo.frequency.value = 13;
    const chopDepth = ctx.createGain();
    chopDepth.gain.value = 0.5;
    chopLfo.connect(chopDepth).connect(chop.gain);
    this.heliGain = ctx.createGain();
    this.heliGain.gain.value = 0;
    heliSrc.connect(heliBp).connect(chop).connect(this.heliGain).connect(this.sfx);
    heliSrc.start();
    chopLfo.start();

    // tyre squeal & nitro hiss loops
    this.skidGain = this.loopNoise('bandpass', 1800, 6);
    this.nitroGain = this.loopNoise('highpass', 2500, 0.7);
    this.nextNoteTime = ctx.currentTime + 0.1;
  }

  private loopNoise(type: BiquadFilterType, freq: number, q: number): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(this.sfx!);
    src.start();
    return g;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  setRunning(running: boolean): void {
    this.running = running;
    if (!running && this.ctx) {
      const t = this.ctx.currentTime;
      this.engineGain?.gain.setTargetAtTime(0, t, 0.1);
      this.sirenGain?.gain.setTargetAtTime(0, t, 0.2);
      this.heliGain?.gain.setTargetAtTime(0, t, 0.2);
      this.skidGain?.gain.setTargetAtTime(0, t, 0.05);
      this.nitroGain?.gain.setTargetAtTime(0, t, 0.05);
    }
  }

  update(dt: number, s: { speed: number; throttle: number; sirenDist: number; heliDist: number; skid: number; nitro: boolean; stars: number }): void {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    // gear-ish rpm curve
    const gear = Math.min(5, Math.floor(s.speed / 11));
    const inGear = (s.speed - gear * 11) / 11;
    const rpm = 0.25 + inGear * 0.75 + (gear === 0 ? 0 : 0.15);
    const f = 38 + rpm * 70 + gear * 6;
    for (const o of this.engineOsc) o.frequency.setTargetAtTime(f, t, 0.05);
    this.engineFilter!.frequency.setTargetAtTime(350 + rpm * 900 + Math.abs(s.throttle) * 500, t, 0.06);
    this.engineGain!.gain.setTargetAtTime(0.09 + Math.abs(s.throttle) * 0.08, t, 0.08);
    const sv = s.sirenDist < 160 ? Math.min(0.11, 7 / Math.max(8, s.sirenDist)) : 0;
    this.sirenGain!.gain.setTargetAtTime(sv, t, 0.15);
    this.sirenLfo!.frequency.setTargetAtTime(s.sirenDist < 30 ? 3.2 : 0.55, t, 0.3);
    const hv = s.heliDist < 220 ? Math.min(0.35, 18 / Math.max(20, s.heliDist)) : 0;
    this.heliGain!.gain.setTargetAtTime(hv, t, 0.3);
    this.skidGain!.gain.setTargetAtTime(Math.min(0.12, s.skid * 0.012), t, 0.05);
    this.nitroGain!.gain.setTargetAtTime(s.nitro ? 0.16 : 0, t, 0.05);
    this.intensity = s.stars;
    this.scheduleMusic(dt);
  }

  private scheduleMusic(_dt: number): void {
    const ctx = this.ctx!;
    const bpm = 124 + this.intensity * 4;
    const step = 60 / bpm / 4;
    while (this.nextNoteTime < ctx.currentTime + 0.15) {
      const s = this.musicStep % 64;
      const time = this.nextNoteTime;
      if (s % 4 === 0) this.kick(time);
      if (s % 4 === 2 && this.intensity >= 2) this.hat(time, 0.05);
      if (s % 2 === 1 && this.intensity >= 4) this.hat(time, 0.025);
      if (s % 8 === 4) this.snare(time);
      const roots = [41.2, 41.2, 49, 36.7]; // E1 E1 G1 D1
      const bar = Math.floor(s / 16);
      const pattern = [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1];
      if (pattern[s % 16]) this.bass(time, roots[bar] * (s % 8 === 6 ? 2 : 1), step * 0.9);
      if (this.intensity >= 3 && s % 16 === 0) this.stab(time, roots[bar] * 4);
      this.nextNoteTime += step;
      this.musicStep += 1;
    }
    this.musicTimer += 1;
  }

  private kick(t: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g).connect(this.musicBus!);
    o.start(t);
    o.stop(t + 0.26);
  }

  private hat(t: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(f).connect(g).connect(this.musicBus!);
    src.start(t, Math.random() * 1.5, 0.06);
  }

  private snare(t: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(f).connect(g).connect(this.musicBus!);
    src.start(t, Math.random() * 1.5, 0.18);
  }

  private bass(t: number, freq: number, dur: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq * 2;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(160, t + dur);
    f.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.32, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f).connect(g).connect(this.musicBus!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private stab(t: number, freq: number): void {
    const ctx = this.ctx!;
    for (const mul of [1, 1.19, 1.5]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = freq * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(g).connect(this.musicBus!);
      o.start(t);
      o.stop(t + 0.42);
    }
  }

  private burst(opts: { vol: number; dur: number; freq: number; type?: BiquadFilterType; delay?: number }): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? 'lowpass';
    f.frequency.setValueAtTime(opts.freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, opts.freq * 0.2), t + opts.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(opts.vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + opts.dur);
    src.connect(f).connect(g).connect(this.sfx!);
    src.start(t, Math.random() * 1.2, opts.dur + 0.05);
  }

  private tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', delay = 0, slide = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide !== 1) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.sfx!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  crash(impact: number, distance = 0): void {
    const v = Math.min(0.9, impact / 30) / (1 + distance / 25);
    if (v < 0.02) return;
    this.burst({ vol: v, dur: 0.35 + Math.min(0.4, impact / 60), freq: 2400 });
    this.tone(90, 0.25, v * 0.6, 'square', 0, 0.5);
  }

  explosion(distance = 0): void {
    const v = 1 / (1 + distance / 30);
    this.burst({ vol: v, dur: 1.4, freq: 900 });
    this.tone(55, 0.9, v * 0.8, 'sine', 0, 0.4);
  }

  pickup(type: 'cash' | 'repair' | 'nitro'): void {
    if (type === 'cash') {
      this.tone(988, 0.12, 0.2, 'square');
      this.tone(1319, 0.25, 0.2, 'square', 0.08);
    } else if (type === 'repair') {
      this.tone(523, 0.15, 0.2, 'triangle');
      this.tone(659, 0.15, 0.2, 'triangle', 0.1);
      this.tone(784, 0.3, 0.2, 'triangle', 0.2);
    } else {
      this.burst({ vol: 0.4, dur: 0.5, freq: 6000, type: 'highpass' });
      this.tone(330, 0.4, 0.15, 'sawtooth', 0, 3);
    }
  }

  starUp(stars: number): void {
    for (let i = 0; i < stars; i += 1) this.tone(880, 0.09, 0.18, 'square', i * 0.12);
    this.tone(660, 0.35, 0.16, 'sawtooth', stars * 0.12, 1.5);
  }

  takedown(): void {
    this.tone(523, 0.1, 0.2, 'square');
    this.tone(784, 0.1, 0.2, 'square', 0.09);
    this.tone(1047, 0.3, 0.2, 'square', 0.18);
  }

  spike(): void {
    this.burst({ vol: 0.6, dur: 0.6, freq: 4000, type: 'highpass' });
    for (let i = 0; i < 4; i += 1) this.tone(180, 0.06, 0.25, 'square', i * 0.07);
  }

  landing(impact: number): void {
    this.burst({ vol: Math.min(0.6, impact / 25), dur: 0.25, freq: 600 });
  }

  splash(): void {
    this.burst({ vol: 0.8, dur: 1.2, freq: 3000, type: 'bandpass' });
  }

  gameOver(): void {
    this.tone(392, 0.4, 0.25, 'sawtooth', 0, 0.97);
    this.tone(311, 0.4, 0.25, 'sawtooth', 0.35, 0.97);
    this.tone(233, 0.9, 0.25, 'sawtooth', 0.7, 0.8);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
