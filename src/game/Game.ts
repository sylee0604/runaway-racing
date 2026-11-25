import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { InputController, type DriveIntent } from '../core/InputController';
import { Loop } from '../core/Loop';
import { createRenderer } from '../core/Renderer';
import { Vehicle } from '../entities/Vehicle';
import { hiddenFromAir } from '../entities/Helicopter';
import { AIDriver, RouteFollower } from '../systems/AIDriver';
import { AudioSystem } from '../systems/AudioSystem';
import { CameraRig } from '../systems/CameraRig';
import { DebugTools, type DebugTuning } from '../systems/DebugTools';
import { Effects } from '../systems/Effects';
import { Physics, type ImpactEvent } from '../systems/Physics';
import { PickupSystem, type PickupType } from '../systems/PickupSystem';
import { PoliceSystem, type Cop } from '../systems/PoliceSystem';
import { TrafficSystem } from '../systems/TrafficSystem';
import { Hud, formatTime } from '../ui/Hud';
import { createSeededRandom } from '../utils/random';
import { CityBuilder } from '../world/CityBuilder';
import { CityLayout } from '../world/CityLayout';
import { skyTexture, glowTexture } from '../world/textures';
import { BUSTED, HEAT_LEVELS, HEAT_PER_SECOND, HEAT_PER_TAKEDOWN, HIGHWAY, HILL, PLAYER_NITRO, SCORE, SPECS } from './config';

type GameState = 'title' | 'playing' | 'paused' | 'over';

const FIXED_DT = 1 / 60;
const START = { x: 18, z: 3.6, heading: Math.PI / 2 };
const BEST_KEY = 'runaway-city-best';

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(62, 1, 0.3, 1600);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly layout = new CityLayout();
  private readonly city: CityBuilder;
  private readonly input: InputController;
  private readonly intent: DriveIntent = { throttle: 0, steer: 0, handbrake: false, nitro: false, lookBack: false };
  private rng = createSeededRandom(1);
  private readonly rand = () => this.rng();
  private readonly player = new Vehicle('player', SPECS.player);
  private readonly police: PoliceSystem;
  private readonly traffic: TrafficSystem;
  private readonly pickups: PickupSystem;
  private readonly effects: Effects;
  private readonly physics: Physics;
  private readonly audio = new AudioSystem();
  private readonly hud: Hud;
  private readonly cameraRig: CameraRig;
  private readonly moon = new THREE.DirectionalLight('#9db4ff', 1.1);
  private readonly headlight = new THREE.SpotLight('#fff3dc', 0, 60, 0.5, 0.6, 1.5);
  private readonly loop: Loop;
  private readonly debug: DebugTools;
  private readonly tuning: DebugTuning = { exposure: 1.0, bloomStrength: 0.5, bloomThreshold: 0.92, maxDpr: 2, godMode: false, freezeHeat: false };

  private state: GameState = 'title';
  private frame = 0;
  private accumulator = 0;
  private elapsed = 0;
  private runTime = 0;
  private heat = 0;
  private stars = 1;
  private maxStars = 1;
  private score = 0;
  private cash = 0;
  private takedowns = 0;
  private nitro = PLAYER_NITRO.start;
  private bustedTimer = 0;
  private spikeTimer = 0;
  private skidDistance = 0;
  private overReason = '';
  private pausedForScreenshot = false;
  private reducedMotion = false;
  private autopilot = false;
  private showcase = false;
  private heldThrottle: number | null = null;
  private readonly autoDriver = new AIDriver();
  private readonly autoRoute = new RouteFollower();
  private autoGoal = -1;
  private readonly autoWp = { x: 0, z: 0, final: false };
  private readonly hitCooldown = new Map<string, number>();
  private readonly allVehicles: Vehicle[] = [];
  private readonly titleCenter = new THREE.Vector3(30, 0, 30);
  private lowQuality = false;
  private dprCap = 2;
  private fpsAvg = 60;
  private lowFpsTime = 0;
  /** 0 = full, 1 = no bloom, 2 = no shadows. Raised automatically when frames are slow. */
  private tier = 0;
  private lastFrameAt = performance.now();
  private readonly dmgLog = { wall: 0, cop: 0, civ: 0 };

  private readonly els = {
    title: document.getElementById('title-screen')!,
    pause: document.getElementById('pause-screen')!,
    over: document.getElementById('over-screen')!,
    touch: document.getElementById('touch-controls')!,
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const q = new URLSearchParams(window.location.search);
    // ?low / ?high force the quality profile; otherwise phones and small screens start low
    this.lowQuality = q.has('low') || (!q.has('high') && (window.matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 500));
    this.dprCap = this.lowQuality ? 1 : 1.5;
    this.tier = this.lowQuality ? 1 : 0;
    this.renderer = createRenderer(canvas, !this.lowQuality);
    this.renderer.toneMappingExposure = this.tuning.exposure;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.18;
    pmrem.dispose();
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.autoUpdate = false;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), this.tuning.bloomStrength, 0.55, this.tuning.bloomThreshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.city = new CityBuilder(this.layout);
    this.scene.add(this.city.group);
    this.buildAtmosphere();

    this.physics = new Physics(this.layout);
    this.effects = new Effects(this.rand, !this.lowQuality);
    this.scene.add(this.effects.group);
    this.police = new PoliceSystem(this.scene, this.layout, this.rand, !this.lowQuality);
    this.traffic = new TrafficSystem(this.scene, this.layout, this.rand, this.lowQuality ? 18 : undefined);
    this.pickups = new PickupSystem(this.scene, this.layout, this.rand);
    this.hud = new Hud(this.layout);
    this.cameraRig = new CameraRig(this.camera, this.layout);

    this.player.visual.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.scene.add(this.player.visual.root);
    this.headlight.position.set(0, 1.1, 1.6);
    this.headlight.target.position.set(0, -1.5, 20);
    this.player.visual.root.add(this.headlight, this.headlight.target);
    this.headlight.intensity = 520;

    if (new URLSearchParams(window.location.search).has('god')) this.tuning.godMode = true;
    this.input = new InputController(this.els.touch);
    this.debug = new DebugTools(this.tuning, () => this.applyTuning());
    this.loop = new Loop((dt) => this.update(dt), () => this.render());

    this.wireUi();
    this.traffic.reset(this.titleCenter.x, this.titleCenter.z);
    this.player.place(START.x, 0, START.z, START.heading);
    this.player.visual.root.visible = false;
    this.showBest();
    this.resize();
    window.addEventListener('resize', this.onResize);
    this.warmUpShaders();
    this.installTestHooks();
    this.publishDiagnostics();
  }

  /** Compile every shader up front so the first SWAT truck / explosion / helicopter doesn't stall a frame. */
  private warmUpShaders(): void {
    const kinds = ['patrol', 'interceptor', 'swat', 'apc'] as const;
    kinds.forEach((k, i) => this.police.spawnCop(k, START.x + i * 8, START.z + 20, 0, 'parked'));
    const hidden: THREE.Object3D[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
    });
    this.renderer.compile(this.scene, this.camera);
    for (const o of hidden) o.visible = false;
    this.police.reset();
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.audio.dispose();
    this.debug.dispose();
    this.city.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  // ----------------------------------------------------------------- setup

  private buildAtmosphere(): void {
    this.scene.fog = new THREE.FogExp2('#0e1124', 0.0024);
    this.scene.background = new THREE.Color('#05060c');
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1300, 32, 16),
      new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    sky.renderOrder = -1;
    this.scene.add(sky);
    // stars
    const starCount = 900;
    const pos = new Float32Array(starCount * 3);
    const r = createSeededRandom(77);
    for (let i = 0; i < starCount; i += 1) {
      const a = r() * Math.PI * 2;
      const e = 0.08 + r() * 1.3;
      pos[i * 3] = Math.cos(a) * Math.cos(e) * 1200;
      pos[i * 3 + 1] = Math.sin(e) * 1200;
      pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * 1200;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: '#cfd8ff', size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8 })));
    const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(220,230,255,1)', 'rgba(150,170,255,0)'), fog: false, color: new THREE.Color(1.6, 1.6, 1.8), toneMapped: false, depthWrite: false }));
    moon.position.set(-500, 420, -700);
    moon.scale.set(120, 120, 1);
    this.scene.add(moon);

    this.scene.add(new THREE.HemisphereLight('#5c6c9e', '#1c1a24', 0.75));
    this.scene.add(new THREE.AmbientLight('#30344a', 0.35));
    this.moon.castShadow = true;
    const ms = this.lowQuality ? 1024 : 2048;
    this.moon.shadow.mapSize.set(ms, ms);
    const sc = this.moon.shadow.camera;
    sc.left = -80;
    sc.right = 80;
    sc.top = 80;
    sc.bottom = -80;
    sc.near = 10;
    sc.far = 400;
    this.moon.shadow.bias = -0.0008;
    this.moon.shadow.normalBias = 0.6;
    this.scene.add(this.moon, this.moon.target);
  }

  private setTier(tier: number): void {
    this.tier = tier;
    // tier 2: stop rendering shadow maps and fade them out via a uniform, so no shader recompiles mid-chase
    const k = tier >= 2 ? 0 : 1;
    this.moon.shadow.intensity = k;
    this.police.helis[0].spot.shadow.intensity = k;
  }

  private applyTuning(): void {
    this.renderer.toneMappingExposure = this.tuning.exposure;
    this.bloom.strength = this.tuning.bloomStrength;
    this.bloom.threshold = this.tuning.bloomThreshold;
    this.dprCap = this.tuning.maxDpr;
    this.resize(true);
  }

  private readonly onResize = () => this.resize(true);

  private resize(force = false): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    if (!force && this.canvas.width === Math.floor(w * dpr) && this.canvas.height === Math.floor(h * dpr)) return;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private wireUi(): void {
    const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
    on('start-button', () => this.startRun());
    on('retry-button', () => this.startRun());
    on('resume-button', () => this.setPaused(false));
    on('quit-button', () => this.toTitle());
    on('touch-pause', () => this.setPaused(this.state === 'playing'));
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.setPaused(true);
    });
  }

  private showBest(): void {
    const best = this.loadBest();
    const line = best ? `최고 기록: ${formatTime(best.time)} · ${best.score.toLocaleString('en-US')}점 · ★${best.stars}` : '';
    document.getElementById('best-line')!.textContent = line;
  }

  private loadBest(): { time: number; score: number; stars: number } | null {
    try {
      const raw = localStorage.getItem(BEST_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ run flow

  private startRun(): void {
    this.audio.unlock();
    this.input.clearPressed();
    this.effects.clear();
    this.police.reset();
    this.player.place(START.x, 0, START.z, START.heading);
    this.player.velocity.set(Math.sin(START.heading) * 14, Math.cos(START.heading) * 14);
    this.player.visual.root.visible = true;
    this.player.speedScale = 1;
    this.player.gripScale = 1;
    this.traffic.reset(START.x, START.z);
    this.pickups.reset(START.x, START.z);
    this.police.spawnOpening(this.player);
    this.heat = 0;
    this.stars = 1;
    this.maxStars = 1;
    this.score = 0;
    this.cash = 0;
    this.takedowns = 0;
    this.runTime = 0;
    this.nitro = PLAYER_NITRO.start;
    this.bustedTimer = 0;
    this.spikeTimer = 0;
    this.accumulator = 0;
    this.hitCooldown.clear();
    this.dmgLog.wall = this.dmgLog.cop = this.dmgLog.civ = 0;
    this.cameraRig.snap(this.player);
    this.hud.resetStars();
    this.hud.clearToasts();
    this.hud.show(true);
    this.state = 'playing';
    this.els.title.classList.add('hidden');
    this.els.over.classList.add('hidden');
    this.els.pause.classList.add('hidden');
    this.els.touch.classList.add('active');
    this.audio.setRunning(true);
    this.hud.toast('경찰이 쫓아온다 — 도망쳐!', 'big', 2.6);
  }

  private toTitle(): void {
    this.state = 'title';
    this.police.reset();
    this.player.visual.root.visible = false;
    this.hud.show(false);
    this.els.pause.classList.add('hidden');
    this.els.over.classList.add('hidden');
    this.els.title.classList.remove('hidden');
    this.els.touch.classList.remove('active');
    this.audio.setRunning(false);
    this.traffic.reset(this.titleCenter.x, this.titleCenter.z);
    this.showBest();
  }

  private setPaused(paused: boolean): void {
    if (paused && this.state === 'playing') {
      this.state = 'paused';
      this.els.pause.classList.remove('hidden');
      this.audio.setRunning(false);
    } else if (!paused && this.state === 'paused') {
      this.state = 'playing';
      this.els.pause.classList.add('hidden');
      this.audio.setRunning(true);
      this.input.clearPressed();
    }
  }

  private endRun(kind: 'busted' | 'wrecked' | 'drowned'): void {
    if (this.state !== 'playing') return;
    this.state = 'over';
    this.audio.setRunning(false);
    this.audio.gameOver();
    const title = document.getElementById('over-title')!;
    title.textContent = kind === 'busted' ? 'BUSTED' : 'WRECKED';
    title.classList.toggle('wrecked', kind !== 'busted');
    this.overReason = kind === 'busted' ? '경찰에게 포위당해 체포되었다.' : kind === 'drowned' ? '차가 강물에 빠졌다.' : '차량이 완전히 부서졌다.';
    document.getElementById('over-reason')!.textContent = this.overReason;
    document.getElementById('over-time')!.textContent = formatTime(this.runTime);
    document.getElementById('over-stars')!.textContent = '★'.repeat(this.maxStars);
    document.getElementById('over-takedowns')!.textContent = String(this.takedowns);
    document.getElementById('over-score')!.textContent = this.score.toLocaleString('en-US');
    const best = this.loadBest();
    let bestLine = best ? `최고 기록 ${best.score.toLocaleString('en-US')}점` : '';
    if (!best || this.score > best.score) {
      bestLine = '🏆 새 최고 기록!';
      try {
        localStorage.setItem(BEST_KEY, JSON.stringify({ time: this.runTime, score: this.score, stars: this.maxStars }));
      } catch {
        /* storage unavailable */
      }
    }
    document.getElementById('over-best')!.textContent = bestLine;
    this.els.touch.classList.remove('active');
    window.setTimeout(() => {
      if (this.state === 'over') this.els.over.classList.remove('hidden');
    }, this.pausedForScreenshot ? 0 : 1100);
  }

  // ---------------------------------------------------------------- loop

  private update(dt: number): void {
    this.frame += 1;
    const now = performance.now();
    const realDt = Math.min(1, (now - this.lastFrameAt) / 1000);
    this.fpsAvg = this.fpsAvg * 0.9 + (1 / Math.max(realDt, 1e-3)) * 0.1;
    this.lastFrameAt = now;
    // adaptive resolution: step the pixel ratio down when the GPU can't keep up
    if (this.state === 'playing' && !this.pausedForScreenshot) {
      this.lowFpsTime = this.fpsAvg < 38 ? this.lowFpsTime + realDt : 0;
      if (this.lowFpsTime > 3) {
        // cheapest wins first: resolution, then bloom, then shadows, then sub-native resolution
        this.lowFpsTime = 0;
        if (this.dprCap > 1) this.dprCap = Math.max(1, this.dprCap - 0.25);
        else if (this.tier < 2) this.setTier(this.tier + 1);
        else if (this.dprCap > 0.75) this.dprCap = 0.75;
        this.resize(true);
      }
    }
    this.resize();
    if (this.pausedForScreenshot) {
      this.publishDiagnostics();
      return;
    }
    this.elapsed += dt;
    if (this.showcase) {
      this.publishDiagnostics();
      return;
    }
    this.handleCommands();
    if (this.state === 'playing' || this.state === 'over' || this.state === 'title') {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < 4) {
        this.step(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps += 1;
      }
      if (steps === 4) this.accumulator = 0;
    }
    this.updateFrame(dt);
    this.publishDiagnostics();
  }

  private handleCommands(): void {
    const i = this.input;
    if (i.consume('KeyM')) {
      this.audio.setMuted(!this.audio.muted);
      if (this.state === 'playing') this.hud.toast(this.audio.muted ? '소리 꺼짐' : '소리 켜짐', 'blue', 1.2);
    }
    if (this.state === 'title' && i.consume('Enter', 'Space')) this.startRun();
    else if (this.state === 'over' && i.consume('KeyR', 'Enter')) this.startRun();
    else if (this.state === 'playing' && i.consume('KeyP', 'Escape')) this.setPaused(true);
    else if (this.state === 'paused' && i.consume('KeyP', 'Escape')) this.setPaused(false);
    else if (this.state === 'playing' && i.consume('KeyR')) this.startRun();
  }

  /** Fixed-step simulation. */
  private step(dt: number): void {
    const playing = this.state === 'playing';
    const p = this.player;
    const level = HEAT_LEVELS[this.stars - 1];

    // ---- player intent
    if (playing && p.alive) {
      if (this.autopilot) this.driveAutopilot(dt);
      else if (this.heldThrottle !== null) {
        p.input.throttle = this.heldThrottle;
        p.input.steer = 0;
        p.input.handbrake = false;
        p.input.nitro = false;
      } else {
        this.input.read(dt, this.intent);
        p.input.throttle = this.intent.throttle;
        p.input.steer = this.intent.steer;
        p.input.handbrake = this.intent.handbrake;
        p.input.nitro = this.intent.nitro;
      }
      const boosting = p.input.nitro && this.nitro > 0.01 && p.input.throttle > 0 && !p.airborne;
      p.nitroActive = boosting;
      if (boosting) this.nitro = Math.max(0, this.nitro - PLAYER_NITRO.drainPerSec * dt);
      p.maxSpeedBonus = boosting ? PLAYER_NITRO.maxSpeedBonus : 0;
      p.accelBonus = boosting ? PLAYER_NITRO.accelBonus : 0;
      if (this.spikeTimer > 0) {
        this.spikeTimer -= dt;
        p.speedScale = 0.68;
        p.gripScale = 0.55;
        if (this.spikeTimer <= 0) {
          p.speedScale = 1;
          p.gripScale = 1;
          this.hud.toast('타이어 복구됨', 'good', 1.4);
        }
      }
    } else if (playing || this.state === 'over') {
      p.input.throttle = 0;
      p.input.steer = 0;
      p.input.handbrake = true;
      p.input.nitro = false;
      p.nitroActive = false;
    }

    // ---- AI
    if (playing) {
      this.police.update(dt, this.elapsed, p, level, {
        onTakedown: (cop) => this.onTakedown(cop),
        onSpike: () => this.onSpike(),
      }, this.camera.position);
    }
    const all = this.allVehicles;
    all.length = 0;
    if (this.state !== 'title') all.push(p);
    for (const c of this.police.cops) all.push(c.v);
    for (const c of this.traffic.civs) all.push(c.v);
    this.traffic.update(dt, this.state === 'title' ? this.dummyPlayer() : p, all, this.camera.position);

    // ---- integrate + collide
    for (const v of all) v.update(dt, this.layout);
    for (const v of all) this.physics.resolveStatic(v);
    this.physics.resolvePairs(all);
    for (const e of this.physics.events) this.onImpact(e);
    this.physics.events.length = 0;
    for (const [k, t] of this.hitCooldown) {
      if (t - dt <= 0) this.hitCooldown.delete(k);
      else this.hitCooldown.set(k, t - dt);
    }

    if (!playing) return;

    // ---- landings, water
    if (p.landedImpact > 0) {
      if (p.landedImpact > 8) {
        this.cameraRig.addShake(Math.min(0.8, p.landedImpact * 0.04));
        this.audio.landing(p.landedImpact);
        this.effects.sparks(p.position.x, p.position.y + 0.2, p.position.z, 18, 0.8);
      }
      if (p.landedImpact > 14) this.addScore(150, '점프 착지 +150');
      p.landedImpact = 0;
    }
    if (p.sinking) {
      this.effects.splash(p.position.x, -4.4, p.position.z);
      this.audio.splash();
      p.alive = false;
      this.endRun('drowned');
      return;
    }

    // ---- heat & score
    const hidden = !this.police.spotted;
    if (!this.tuning.freezeHeat) this.heat += dt * HEAT_PER_SECOND * (hidden ? 0.5 : 1);
    this.runTime += dt;
    this.score += Math.round(dt * SCORE.perSecondBase * this.stars * 10) / 10;
    this.updateStars();

    // ---- pickups
    this.pickups.update(dt, this.elapsed, p.position, (type, at) => this.onPickup(type, at));

    // ---- busted
    let near = 0;
    for (const c of this.police.cops) {
      if (c.mode === 'wreck') continue;
      if (c.v.position.distanceTo(p.position) < BUSTED.radius + c.v.spec.radius) near += 1;
    }
    if (near > 0 && p.speed < BUSTED.speedBelow) this.bustedTimer += dt * (near >= 2 ? 1.5 : 1);
    else this.bustedTimer = Math.max(0, this.bustedTimer - dt * 1.5);
    if (this.bustedTimer >= BUSTED.seconds && !this.tuning.godMode) {
      this.endRun('busted');
      return;
    }
    if (!p.alive && !this.tuning.godMode) {
      this.effects.explosion(p.position.x, p.position.y, p.position.z);
      this.audio.explosion(0);
      this.cameraRig.addShake(1.2);
      this.endRun('wrecked');
    }
    if (this.tuning.godMode && !p.alive) {
      p.alive = true;
      p.health = p.spec.health;
    }
  }

  private dummyPlayer(): Vehicle {
    // traffic wanders around the plaza on the title screen
    this.player.position.set(this.titleCenter.x, 0, this.titleCenter.z);
    return this.player;
  }

  private driveAutopilot(dt: number): void {
    const p = this.player;
    // pick a far goal node ahead and keep re-picking when close
    if (this.autoGoal < 0 || Math.hypot(this.layout.nodes[this.autoGoal].x - p.position.x, this.layout.nodes[this.autoGoal].z - p.position.z) < 25) {
      let best = -1;
      let bestScore = -Infinity;
      for (const n of this.layout.nodes) {
        if (n.edges.length === 0 || n.level !== 'ground') continue;
        const d = Math.hypot(n.x - p.position.x, n.z - p.position.z);
        if (d < 120 || d > 330) continue;
        const s = this.rng() + ((n.x - p.position.x) * p.forwardX + (n.z - p.position.z) * p.forwardZ) / d;
        if (s > bestScore) {
          bestScore = s;
          best = n.id;
        }
      }
      this.autoGoal = best;
      this.autoRoute.reset();
    }
    this.autoRoute.update(p, this.layout, this.autoGoal, dt, this.autoWp);
    this.autoDriver.drive(p, this.layout, this.autoWp.x, this.autoWp.z, 34, dt);
    p.input.nitro = this.nitro > 0.5;
  }

  private updateStars(): void {
    let s = 1;
    for (const l of HEAT_LEVELS) if (this.heat >= l.threshold) s = l.stars;
    if (s > this.stars) {
      this.stars = s;
      this.maxStars = Math.max(this.maxStars, s);
      const l = HEAT_LEVELS[s - 1];
      this.hud.toast(`수배 ${'★'.repeat(s)} — ${l.label}`, 'big', 3.2);
      this.audio.starUp(s);
      this.nitro = Math.min(1, this.nitro + 0.25);
    }
  }

  private addScore(n: number, label?: string): void {
    this.score += n;
    if (label) this.hud.toast(label, 'good', 1.4);
  }

  private onTakedown(cop: Cop): void {
    const v = cop.v;
    this.effects.explosion(v.position.x, v.position.y, v.position.z);
    const d = v.position.distanceTo(this.player.position);
    this.audio.explosion(d);
    if (d < 40) this.cameraRig.addShake(0.6 * (1 - d / 40));
    if (v.sinking) this.effects.splash(v.position.x, -4.4, v.position.z);
    this.takedowns += 1;
    const bonus = SCORE.takedown * (v.kind === 'apc' ? 4 : v.kind === 'swat' ? 2 : 1);
    this.score += bonus;
    if (!this.tuning.freezeHeat) this.heat += HEAT_PER_TAKEDOWN;
    const names: Record<string, string> = { patrol: '순찰차', interceptor: '인터셉터', swat: 'SWAT 트럭', apc: '장갑차' };
    this.hud.toast(`${names[v.kind] ?? '경찰'} 격파! +${bonus}`, 'good', 1.8);
    this.audio.takedown();
    v.visual.paint.color.multiplyScalar(0.25);
    v.visual.headMat.color.setRGB(0.05, 0.05, 0.05);
  }

  private onSpike(): void {
    this.spikeTimer = 7;
    this.audio.spike();
    this.hud.toast('스파이크 밟음! 타이어 펑크', 'big', 2);
    this.effects.sparks(this.player.position.x, 0.3, this.player.position.z, 30, 1);
    this.cameraRig.addShake(0.4);
    this.player.damage(8);
  }

  private onPickup(type: PickupType, at: THREE.Vector3): void {
    this.audio.pickup(type);
    this.effects.sparks(at.x, 1.5, at.z, 24, 0.6, type === 'cash' ? new THREE.Color(0.5, 4, 1) : type === 'repair' ? new THREE.Color(4, 1, 0.8) : new THREE.Color(0.6, 2, 4));
    if (type === 'cash') {
      this.cash += SCORE.cash;
      this.score += SCORE.cash;
      this.hud.toast(`현금 +$${SCORE.cash}`, 'good', 1.2);
    } else if (type === 'repair') {
      const p = this.player;
      p.health = Math.min(p.spec.health, p.health + 40);
      this.spikeTimer = Math.min(this.spikeTimer, 0.01);
      this.hud.toast('차량 수리 +40', 'good', 1.2);
    } else {
      this.nitro = Math.min(1, this.nitro + 0.5);
      this.hud.toast('니트로 충전', 'blue', 1.2);
    }
  }

  private onImpact(e: ImpactEvent): void {
    const a = e.a;
    const b = e.b;
    const key = b ? (a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`) : `${a.id}:w`;
    if (this.hitCooldown.has(key)) return;
    this.hitCooldown.set(key, 0.3);
    const p = this.player;
    const involvesPlayer = a === p || b === p;
    const playing = this.state === 'playing';
    const dist = Math.hypot(e.x - p.position.x, e.z - p.position.z);
    if (e.impact > 4) {
      this.effects.sparks(e.x, e.y, e.z, Math.min(40, Math.floor(e.impact * 1.4)), Math.min(1.6, e.impact / 15));
      if (playing) this.audio.crash(e.impact, dist);
    }
    if (b) {
      const ma = a.spec.mass;
      const mb = b.spec.mass;
      const dmgA = Math.max(0, e.impact - 3.5) * 1.3 * b.spec.ramDamage * ((2 * mb) / (ma + mb));
      const dmgB = Math.max(0, e.impact - 3.5) * 1.3 * a.spec.ramDamage * ((2 * ma) / (ma + mb));
      this.applyDamage(a, dmgA, b);
      this.applyDamage(b, dmgB, a);
      a.lastImpact = Math.max(a.lastImpact, e.impact);
      b.lastImpact = Math.max(b.lastImpact, e.impact);
    } else {
      this.applyDamage(a, Math.max(0, e.impact - 9) * 0.9, null);
      a.lastImpact = Math.max(a.lastImpact, e.impact);
    }
    if (involvesPlayer && playing && e.impact > 5) {
      this.cameraRig.addShake(Math.min(0.9, e.impact * 0.035));
      if (e.impact > 8) this.hud.flashHit(Math.min(0.9, e.impact / 30));
    }
  }

  private applyDamage(v: Vehicle, dmg: number, other: Vehicle | null): void {
    if (dmg <= 0 || this.state !== 'playing') return;
    if (v.kind === 'civilian') return;
    // cops don't hurt each other as much as they hurt the player
    if (v !== this.player && other && other !== this.player && other.kind !== 'civilian') dmg *= 0.4;
    if (v === this.player && this.tuning.godMode) return;
    if (v === this.player) {
      dmg = Math.min(dmg, 35); // no single hit is an instant kill
      if (!other) this.dmgLog.wall += dmg;
      else if (other.kind === 'civilian') this.dmgLog.civ += dmg;
      else this.dmgLog.cop += dmg;
    }
    v.damage(dmg);
  }

  /** Per-frame visual updates (not fixed-step). */
  private updateFrame(dt: number): void {
    const p = this.player;
    const playingish = this.state === 'playing' || this.state === 'over' || this.state === 'paused';
    const animDt = this.state === 'paused' ? 0 : dt;
    if (this.state !== 'title') p.syncVisual(animDt);
    for (const c of this.police.cops) c.v.syncVisual(animDt);
    for (const c of this.traffic.civs) c.v.syncVisual(animDt);
    this.city.update(this.elapsed);

    if (this.state !== 'paused') {
      // drift marks & tyre smoke
      if (this.state === 'playing' && !p.airborne && p.alive) {
        const slip = Math.abs(p.lateralSpeed);
        const drifting = slip > 4.2 || (p.input.handbrake && p.speed > 8);
        if (drifting) {
          this.skidDistance += p.speed * dt;
          if (this.skidDistance > 0.9) {
            this.skidDistance = 0;
            for (const side of [-1, 1]) {
              const ox = Math.cos(p.heading) * 0.82 * side - Math.sin(p.heading) * 1.4;
              const oz = -Math.sin(p.heading) * 0.82 * side - Math.cos(p.heading) * 1.4;
              this.effects.skid(p.position.x + ox, p.position.y, p.position.z + oz, Math.atan2(p.velocity.x, p.velocity.y));
            }
            if (this.rng() < 0.6) this.effects.puff(p.position.x - p.forwardX * 1.8, p.position.y + 0.4, p.position.z - p.forwardZ * 1.8, { size: 1.6, life: 1.2, vy: 0.8, color: '#c9ccd4', opacity: 0.35 });
          }
        }
        if (p.nitroActive && this.rng() < 0.9) {
          for (const side of [-0.45, 0.45]) {
            const bx = p.position.x - p.forwardX * 2.45 + Math.cos(p.heading) * side;
            const bz = p.position.z - p.forwardZ * 2.45 - Math.sin(p.heading) * side;
            this.effects.puff(bx, p.position.y + 0.4, bz, { fire: true, size: 0.55, life: 0.18, vx: -p.velocity.x * 0.2, vy: 0, vz: -p.velocity.y * 0.2 });
          }
        }
      }
      // damage smoke & fire
      const smokeFrom = (v: Vehicle) => {
        const frac = v.health / v.spec.health;
        if (frac > 0.45 && v.alive) return;
        const chance = v.alive ? (frac < 0.2 ? 0.5 : 0.2) : 0.45;
        if (this.rng() > chance) return;
        const hx = v.position.x + v.forwardX * v.spec.halfLength * 0.8;
        const hz = v.position.z + v.forwardZ * v.spec.halfLength * 0.8;
        const fire = !v.alive || frac < 0.2;
        if (fire && this.rng() < 0.5) this.effects.puff(hx, v.position.y + 1.1, hz, { fire: true, size: 1.2, life: 0.5, vy: 2 });
        this.effects.puff(hx, v.position.y + 1.3, hz, { size: 1.4, life: 1.8, vy: 2.2, color: fire ? '#2a2a2e' : '#7a7d86', opacity: 0.55 });
      };
      if (this.state !== 'title') smokeFrom(p);
      for (const c of this.police.cops) if (c.v.position.distanceToSquared(p.position) < 160 * 160) smokeFrom(c.v);
      this.effects.update(dt);
    }

    // camera
    if (this.state === 'title') this.cameraRig.orbit(this.elapsed, this.titleCenter);
    else if (this.state !== 'paused') this.cameraRig.update(dt, p, p.nitroActive, this.intent.lookBack && this.state === 'playing', this.reducedMotion);

    // moon shadow follows the action
    const focus = this.state === 'title' ? this.titleCenter : p.position;
    this.moon.position.set(focus.x - 90, focus.y + 160, focus.z - 60);
    this.moon.target.position.copy(focus);
    this.moon.target.updateMatrixWorld();

    if (playingish) {
      const frac = Math.max(0, p.health / p.spec.health);
      this.hud.update({
        time: this.runTime,
        score: Math.floor(this.score),
        cash: this.cash,
        takedowns: this.takedowns,
        stars: this.stars,
        heatLabel: this.police.spotted ? HEAT_LEVELS[this.stars - 1].label : hiddenFromAir(this.layout, p.position.x, p.position.y, p.position.z) ? '은신 중 — 헬기가 볼 수 없다' : '경찰이 마지막 목격 지점을 수색 중',
        evading: !this.police.spotted,
        health: frac,
        nitro: this.nitro,
        speedKmh: p.speed * 3.6,
        boosting: p.nitroActive,
        busted: Math.min(1, this.bustedTimer / BUSTED.seconds),
      });
      if (this.frame % 3 === 0) {
        const items = this.pickups.items.filter((i) => i.active).map((i) => ({ x: i.group.position.x, z: i.group.position.z, type: i.type }));
        this.hud.drawMap(p, this.police.cops, this.police.helis, this.police.spikes, items, this.elapsed);
      }
    }
    if (this.state === 'playing') {
      this.audio.update(dt, {
        speed: p.speed,
        throttle: p.input.throttle,
        sirenDist: this.police.nearestDistance(p.position),
        heliDist: this.police.nearestHeliDistance(p.position),
        skid: !p.airborne ? Math.max(0, Math.abs(p.lateralSpeed) - 3) : 0,
        nitro: p.nitroActive,
        stars: this.stars,
      });
    }
  }

  private render(): void {
    this.renderer.info.reset();
    // moving shadows refreshed at half rate: halves the shadow pass, 1-frame lag is invisible
    this.renderer.shadowMap.needsUpdate = this.tier < 2 && this.frame % 2 === 0;
    if (this.tier >= 1) this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }

  // -------------------------------------------------------------- testing

  private simulate(seconds: number): void {
    const steps = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < steps; i += 1) {
      this.step(FIXED_DT);
      if (i % 3 === 0) this.updateFrame(FIXED_DT * 3);
    }
    this.updateFrame(FIXED_DT);
  }

  private installTestHooks(): void {
    const states = ['title', 'active-play', 'heat-3', 'heat-5', 'tunnel', 'underpass', 'game-over', 'paused', 'garage'];
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.rng = createSeededRandom(value);
      },
      setState: (name: string) => {
        if (!states.includes(name)) throw new Error(`Unknown test state: ${name}`);
        const wasPaused = this.pausedForScreenshot;
        this.pausedForScreenshot = false;
        this.autopilot = false;
        this.showcase = false;
        this.heldThrottle = null;
        if (name === 'garage') {
          this.startRun();
          this.hud.clearToasts();
          this.hud.show(false);
          this.police.reset();
          this.player.place(14, 0, 4, Math.PI * 0.62);
          const kinds = ['patrol', 'interceptor', 'swat', 'apc'] as const;
          kinds.forEach((k, i) => this.police.spawnCop(k, 24 + i * 8.5, 5 + (i % 2) * 0.5, Math.PI * 0.62, 'parked'));
          const h = this.police.helis[0];
          h.spawn(40, 30, 0);
          h.position.set(44, 22, 26);
          h.update(0.016, this.player.position, this.player.velocity, 1, this.elapsed, this.layout);
          h.position.set(44, 22, 26);
          h.visual.root.position.copy(h.position);
          for (const c of this.police.cops) c.v.syncVisual(0.016);
          this.player.syncVisual(0.016);
          this.camera.position.set(30, 4.2, -12);
          this.camera.lookAt(34, 2.4, 6);
          this.camera.fov = 55;
          this.camera.updateProjectionMatrix();
          this.showcase = true;
          this.render();
          this.publishDiagnostics();
          return { state: name };
        }
        if (name === 'title') {
          this.toTitle();
          this.simulate(1);
        } else {
          this.startRun();
          this.hud.clearToasts();
          this.autopilot = true;
          this.autoGoal = -1;
          if (name === 'tunnel') {
            this.player.place(HILL.x0 + 30, 0, HILL.tunnelZ - 3.6, Math.PI / 2);
            this.player.velocity.set(30, 0);
            this.police.reset();
            this.police.spawnOpening(this.player);
          }
          if (name === 'underpass') {
            this.player.place(-40, 0, HIGHWAY.z - 4.5, Math.PI / 2);
            this.player.velocity.set(30, 0);
            this.police.reset();
            this.police.spawnOpening(this.player);
          }
          if (name === 'heat-3') this.heat = HEAT_LEVELS[2].threshold + 1;
          if (name === 'heat-5') this.heat = HEAT_LEVELS[4].threshold + 1;
          this.updateStars();
          this.hud.clearToasts();
          const secs = name === 'heat-3' || name === 'heat-5' ? 7 : name === 'tunnel' || name === 'underpass' ? 1.2 : 2.5;
          this.simulate(secs);
          this.cameraRig.snap(this.player);
          this.simulate(0.5);
          if (name === 'game-over') {
            this.endRun('busted');
            this.els.over.classList.remove('hidden');
          }
          if (name === 'paused') this.setPaused(true);
          this.autopilot = false;
        }
        this.pausedForScreenshot = wasPaused;
        this.render();
        this.publishDiagnostics();
        return { state: name };
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
      },
      setReducedMotion: (enabled: boolean) => {
        this.reducedMotion = enabled;
      },
      hideDebugUi: (hidden: boolean) => {
        this.debug.setHidden(hidden);
      },
      advance: (seconds: number) => {
        const steps = Math.round(seconds / FIXED_DT);
        for (let i = 0; i < steps && this.state === 'playing'; i += 1) this.step(FIXED_DT);
        this.publishDiagnostics();
        return window.__THREE_GAME_DIAGNOSTICS__;
      },
      viewFrom: (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
        this.showcase = true;
        this.hud.show(false);
        this.camera.position.set(px, py, pz);
        this.camera.lookAt(tx, ty, tz);
        this.camera.fov = 60;
        this.camera.updateProjectionMatrix();
        this.moon.position.set(tx - 90, 160, tz - 60);
        this.moon.target.position.set(tx, 0, tz);
        this.moon.target.updateMatrixWorld();
        this.render();
      },
      teleport: (x: number, z: number, heading: number, speed: number, throttle = 1) => {
        this.autopilot = false;
        this.player.place(x, this.layout.groundAt(x, z, 0.5), z, heading);
        this.player.velocity.set(Math.sin(heading) * speed, Math.cos(heading) * speed);
        this.player.input.throttle = throttle;
        this.player.input.steer = 0;
        this.police.reset();
        this.heldThrottle = throttle;
      },
      track: (seconds: number) => {
        const out: { t: number; x: number; y: number; z: number; spd: number; air: boolean; hp: number; state: string }[] = [];
        const steps = Math.round(seconds / FIXED_DT);
        for (let i = 0; i < steps && this.state === 'playing'; i += 1) {
          this.step(FIXED_DT);
          if (i % 15 === 0) out.push({ t: +(i * FIXED_DT).toFixed(2), x: +this.player.position.x.toFixed(1), y: +this.player.position.y.toFixed(2), z: +this.player.position.z.toFixed(1), spd: +this.player.speed.toFixed(1), air: this.player.airborne, hp: Math.round(this.player.health), state: this.state });
        }
        out.push({ t: seconds, x: +this.player.position.x.toFixed(1), y: +this.player.position.y.toFixed(2), z: +this.player.position.z.toFixed(1), spd: +this.player.speed.toFixed(1), air: this.player.airborne, hp: Math.round(this.player.health), state: this.state });
        return out;
      },
      setAutopilot: (on: boolean) => {
        this.autopilot = on;
        this.autoGoal = -1;
      },
    } as ThreeGameTestHooks;
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    const p = this.player;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.runTime,
      score: Math.floor(this.score),
      targetScore: 0,
      complete: this.state === 'over',
      state: this.state,
      stars: this.stars,
      heat: this.heat,
      health: p.health,
      cops: this.police.cops.filter((c) => c.mode !== 'wreck').length,
      helicopters: this.police.helis.filter((h) => h.active).length,
      spotted: this.police.spotted,
      takedowns: this.takedowns,
      fps: Math.round(this.fpsAvg),
      tier: this.tier,
      programs: this.renderer.info.programs?.length ?? 0,
      overReason: this.overReason,
      dmg: { ...this.dmgLog },
      stalled: { cops: this.police.cops.filter((c) => c.mode === 'chase' && c.v.speed < 1).length, civs: this.traffic.civs.filter((c) => c.v.speed < 0.5).length },
      player: {
        position: { x: p.position.x, y: p.position.y, z: p.position.z },
        speed: p.speed,
      },
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, this.dprCap),
      },
    };
  }
}
