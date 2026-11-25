import * as THREE from 'three';
import { CITY_HALF, GRID, HIGHWAYS, HILL, RIVER, ROUNDABOUT } from '../game/config';
import { createSeededRandom } from '../utils/random';
import { Batch, type V3 } from './Batch';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hwHeightAt, hwPoint, hwRect, type CityLayout } from './CityLayout';
import * as T from './textures';

const S = GRID.spacing;
const HR = GRID.roadWidth / 2;

const SIGN_WORDS: [string, string][] = [
  ['HOTEL', '#ff4fa3'],
  ['BAR', '#4ff0ff'],
  ['24H', '#ffe04f'],
  ['노래방', '#ff5fd0'],
  ['PC방', '#5fa8ff'],
  ['치킨', '#ffb347'],
  ['CLUB', '#b46bff'],
  ['MOTEL', '#ff4060'],
  ['편의점', '#4fff9a'],
  ['NOODLE', '#ff7a3d'],
  ['CAFE', '#ffd6a0'],
  ['PIZZA', '#ff5f5f'],
];

/** Builds all static city visuals from a CityLayout. */
export class CityBuilder {
  readonly group = new THREE.Group();
  private readonly rng = createSeededRandom(2024);
  private water: THREE.Mesh | null = null;
  private waterNormal: THREE.Texture | null = null;
  private antennaLights: THREE.InstancedMesh | null = null;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly layout: CityLayout) {
    this.buildGround();
    this.buildRoads();
    this.buildSidewalks();
    this.buildBuildings();
    for (let i = 0; i < HIGHWAYS.length; i += 1) this.buildHighway(i);
    this.buildRoundabouts();
    this.buildParkingLots();
    this.buildRiver();
    this.buildHill();
    this.buildPlaza();
    this.buildRails();
    this.buildLamps();
    this.buildTrees();
    this.buildSkyline();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.matrixAutoUpdate = false;
        m.updateMatrix();
      }
    });
  }

  update(elapsed: number): void {
    if (this.waterNormal) {
      this.waterNormal.offset.set(elapsed * 0.02, elapsed * 0.05);
    }
    if (this.antennaLights) {
      const m = this.antennaLights.material as THREE.MeshBasicMaterial;
      m.color.setRGB(Math.sin(elapsed * 3) > 0.2 ? 3 : 0.3, 0.05, 0.05);
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
  }

  // ------------------------------------------------------------ helpers

  private mat<T extends THREE.Material>(m: T): T {
    this.disposables.push(m);
    return m;
  }

  private tex<T extends THREE.Texture>(t: T): T {
    this.disposables.push(t);
    return t;
  }

  private add(geo: THREE.BufferGeometry, material: THREE.Material, opts: { cast?: boolean; receive?: boolean } = {}): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = opts.cast ?? false;
    mesh.receiveShadow = opts.receive ?? true;
    this.group.add(mesh);
    return mesh;
  }

  // ------------------------------------------------------------ ground

  private buildGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000),
      this.mat(new THREE.MeshStandardMaterial({ color: '#141418', roughness: 1 })),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.06;
    ground.receiveShadow = true;
    this.group.add(ground);
  }

  // ------------------------------------------------------------- roads

  private buildRoads(): void {
    const roadTex = this.tex(T.roadTexture());
    const roadMat = this.mat(new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.82, metalness: 0.05 }));
    const interTex = this.tex(T.intersectionTexture());
    const interMat = this.mat(new THREE.MeshStandardMaterial({ map: interTex, roughness: 0.85 }));
    const roads = new Batch();
    const inter = new Batch();

    const nodeKey = (x: number, z: number) => `${Math.round(x)}:${Math.round(z)}`;
    const groundNodes = new Set(this.layout.nodes.filter((n) => n.level === 'ground' && n.edges.length).map((n) => nodeKey(n.x, n.z)));
    const rbNodes = new Set(this.layout.roundabouts.map((r) => nodeKey(r.x, r.z)));
    const trimAt = (x: number, z: number) => (rbNodes.has(nodeKey(x, z)) ? ROUNDABOUT.outer - 1 : groundNodes.has(nodeKey(x, z)) ? HR : 0);

    for (const seg of this.layout.roads) {
      const dx = seg.bx - seg.ax;
      const dz = seg.bz - seg.az;
      const len = Math.hypot(dx, dz);
      const ux = dx / len;
      const uz = dz / len;
      const px = -uz;
      const pz = ux;
      const hw = seg.width / 2;
      let t0 = 0;
      let t1 = len;
      if (seg.y0 === 0 && seg.y1 === 0) {
        t0 = trimAt(seg.ax, seg.az);
        t1 = len - trimAt(seg.bx, seg.bz);
      }
      const lift = seg.kind === 'highway' || seg.kind === 'ramp' ? 0.03 : 0.02;
      const y0 = seg.y0 + (seg.y1 - seg.y0) * (t0 / len) + lift;
      const y1 = seg.y0 + (seg.y1 - seg.y0) * (t1 / len) + lift;
      const sx = seg.ax + ux * t0;
      const sz = seg.az + uz * t0;
      const ex = seg.ax + ux * t1;
      const ez = seg.az + uz * t1;
      const v0 = t0 / 16;
      const v1 = t1 / 16;
      roads.upQuad(
        [sx + px * hw, y0, sz + pz * hw],
        [sx - px * hw, y0, sz - pz * hw],
        [ex - px * hw, y1, ez - pz * hw],
        [ex + px * hw, y1, ez + pz * hw],
        [[0, v0], [1, v0], [1, v1], [0, v1]],
      );
    }
    for (const n of this.layout.nodes) {
      if (n.level !== 'ground' || n.edges.length === 0 || n.roundabout) continue;
      inter.upQuad([n.x - HR, 0.025, n.z + HR], [n.x + HR, 0.025, n.z + HR], [n.x + HR, 0.025, n.z - HR], [n.x - HR, 0.025, n.z - HR]);
    }
    this.add(roads.build(), roadMat);
    this.add(inter.build(), interMat);
  }

  private buildSidewalks(): void {
    const tex = this.tex(T.sidewalkTexture());
    const mat = this.mat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    const curbMat = this.mat(new THREE.MeshStandardMaterial({ color: '#8d8d92', roughness: 0.8 }));
    const walks = new Batch();
    const curbs = new Batch();
    for (const b of this.layout.blocks) {
      if (b.type === 'city' || b.type === 'park' || b.type === 'plaza' || b.type === 'lot') {
        if (b.type === 'city') walks.box(b.x0, 0, b.z0, b.x1, 0.14, b.z1, { uScale: 4, vScale: 4, sides: false, topScale: 4 });
        curbs.box(b.x0, 0, b.z0, b.x1, 0.15, b.z0 + 0.3, { top: true });
        curbs.box(b.x0, 0, b.z1 - 0.3, b.x1, 0.15, b.z1, { top: true });
        curbs.box(b.x0, 0, b.z0, b.x0 + 0.3, 0.15, b.z1, { top: true });
        curbs.box(b.x1 - 0.3, 0, b.z0, b.x1, 0.15, b.z1, { top: true });
      }
      if (b.type === 'river') {
        walks.box(b.x0, 0, b.z0, RIVER.x - RIVER.halfWidth, 0.1, b.z1, { sides: false, topScale: 4 });
        walks.box(RIVER.x + RIVER.halfWidth, 0, b.z0, b.x1, 0.1, b.z1, { sides: false, topScale: 4 });
      }
    }
    this.add(walks.build(), mat);
    this.add(curbs.build(), curbMat);
  }

  // --------------------------------------------------------- buildings

  private storefrontTexture(): THREE.CanvasTexture[] {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    const e = document.createElement('canvas');
    e.width = 512;
    e.height = 128;
    const ectx = e.getContext('2d')!;
    ctx.fillStyle = '#2a2a2e';
    ctx.fillRect(0, 0, 512, 128);
    ectx.fillStyle = '#000';
    ectx.fillRect(0, 0, 512, 128);
    const colors = ['#ffcf8a', '#ffe9c0', '#9fe0ff', '#ff9fd8', '#c8ffb0'];
    for (let k = 0; k < 4; k += 1) {
      const x = k * 128 + 8;
      ctx.fillStyle = '#121418';
      ctx.fillRect(x, 30, 112, 92);
      const col = colors[Math.floor(this.rng() * colors.length)];
      if (this.rng() < 0.75) {
        const g = ectx.createLinearGradient(0, 30, 0, 122);
        g.addColorStop(0, col);
        g.addColorStop(1, '#3a2a1a');
        ectx.fillStyle = g;
        ectx.globalAlpha = 0.65;
        ectx.fillRect(x + 4, 34, 104, 84);
        ectx.globalAlpha = 1;
        ectx.fillStyle = 'rgba(0,0,0,0.6)';
        for (let s = 0; s < 3; s += 1) ectx.fillRect(x + 10 + this.rng() * 80, 70 + this.rng() * 20, 8 + this.rng() * 14, 30);
      }
      // awning
      const awn = ['#8b1e2b', '#1e4f8b', '#2b6b3a', '#6b4a1e'][Math.floor(this.rng() * 4)];
      ctx.fillStyle = awn;
      ctx.fillRect(x - 4, 6, 120, 20);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (let s = 0; s < 120; s += 16) ctx.fillRect(x - 4 + s, 6, 8, 20);
      ectx.fillStyle = awn;
      ectx.globalAlpha = 0.15;
      ectx.fillRect(x - 4, 6, 120, 20);
      ectx.globalAlpha = 1;
    }
    const t1 = new THREE.CanvasTexture(c);
    const t2 = new THREE.CanvasTexture(e);
    for (const t of [t1, t2]) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      this.tex(t);
    }
    return [t1, t2];
  }

  private buildBuildings(): void {
    const facades = Array.from({ length: T.FACADE_COUNT }, (_, i) => T.facadeTextures(i));
    const batches = facades.map(() => new Batch());
    const roofs = new Batch();
    const props = new Batch();
    const shops = new Batch();
    const antennas: THREE.Vector3[] = [];
    const signs: { pos: THREE.Vector3; rotY: number; word: number; w: number; h: number; vertical: boolean }[] = [];
    const store = this.storefrontTexture();

    const facesRoad = (v: number) => {
      const d = Math.abs(v - Math.round(v / S) * S);
      return d < 13;
    };

    for (const lot of this.layout.lots) {
      const style = lot.style;
      const f = facades[style];
      const b = batches[style];
      let x0 = lot.x0;
      let x1 = lot.x1;
      let z0 = lot.z0;
      let z1 = lot.z1;
      const shopH = 4.4;
      // storefront band
      shops.box(x0, 0, z0, x1, shopH, z1, { uScale: 16, vScale: shopH, top: false });
      let base = shopH;
      const tierH = (lot.height - shopH) / lot.tiers;
      for (let t = 0; t < lot.tiers; t += 1) {
        const top = base + tierH;
        b.box(x0, base, z0, x1, top, z1, { uScale: f.tileW, vScale: f.tileH, top: false });
        roofs.box(x0 - 0.4, top, z0 - 0.4, x1 + 0.4, top + 0.6, z1 + 0.4, { uScale: 8, topScale: 12 });
        base = top + 0.6;
        const shrink = Math.min(x1 - x0, z1 - z0) * (0.12 + this.rng() * 0.08);
        x0 += shrink;
        x1 -= shrink;
        z0 += shrink;
        z1 -= shrink;
      }
      // rooftop clutter
      const rx0 = x0;
      const rz0 = z0;
      const rw = x1 - x0;
      const rd = z1 - z0;
      const nProps = 1 + Math.floor(this.rng() * 3);
      for (let k = 0; k < nProps; k += 1) {
        const w = 2 + this.rng() * 4;
        const d = 2 + this.rng() * 4;
        const px = rx0 + 1 + this.rng() * Math.max(0.1, rw - w - 2);
        const pz = rz0 + 1 + this.rng() * Math.max(0.1, rd - d - 2);
        props.box(px, base, pz, px + w, base + 1.2 + this.rng() * 2.5, pz + d, { uScale: 3 });
      }
      if (lot.height > 50 && this.rng() < 0.7) {
        const ax = (x0 + x1) / 2;
        const az = (z0 + z1) / 2;
        const ah = 6 + this.rng() * 10;
        props.box(ax - 0.15, base, az - 0.15, ax + 0.15, base + ah, az + 0.15, { uScale: 1 });
        antennas.push(new THREE.Vector3(ax, base + ah, az));
      }
      // neon sign on a road-facing wall
      if (this.rng() < 0.42) {
        const opts: { pos: THREE.Vector3; rotY: number }[] = [];
        const midX = (lot.x0 + lot.x1) / 2;
        const midZ = (lot.z0 + lot.z1) / 2;
        if (facesRoad(lot.x1)) opts.push({ pos: new THREE.Vector3(lot.x1 + 0.25, 0, midZ), rotY: Math.PI / 2 });
        if (facesRoad(lot.x0)) opts.push({ pos: new THREE.Vector3(lot.x0 - 0.25, 0, midZ), rotY: -Math.PI / 2 });
        if (facesRoad(lot.z1)) opts.push({ pos: new THREE.Vector3(midX, 0, lot.z1 + 0.25), rotY: 0 });
        if (facesRoad(lot.z0)) opts.push({ pos: new THREE.Vector3(midX, 0, lot.z0 - 0.25), rotY: Math.PI });
        if (opts.length) {
          const o = opts[Math.floor(this.rng() * opts.length)];
          const vertical = this.rng() < 0.4 && lot.height > 22;
          o.pos.y = vertical ? 9 + this.rng() * 6 : 5.6 + this.rng() * 1.2;
          signs.push({ ...o, word: Math.floor(this.rng() * SIGN_WORDS.length), w: vertical ? 2.2 : 7, h: vertical ? 8 : 1.8, vertical });
        }
      }
    }

    facades.forEach((f, i) => {
      const m = this.mat(
        new THREE.MeshStandardMaterial({
          map: this.tex(f.map),
          emissiveMap: this.tex(f.emissive),
          emissive: new THREE.Color('#ffffff'),
          emissiveIntensity: 0.95,
          roughness: 0.88,
          metalness: 0.05,
        }),
      );
      if (!batches[i].empty) this.add(batches[i].build(), m, { cast: true, receive: true });
    });
    const roofMat = this.mat(new THREE.MeshStandardMaterial({ map: this.tex(T.roofTexture()), roughness: 0.95 }));
    this.add(roofs.build(), roofMat, { cast: true });
    const propMat = this.mat(new THREE.MeshStandardMaterial({ color: '#4c4e55', roughness: 0.7, metalness: 0.3 }));
    this.add(props.build(), propMat, { cast: true });
    const shopMat = this.mat(
      new THREE.MeshStandardMaterial({ map: store[0], emissiveMap: store[1], emissive: new THREE.Color('#ffffff'), emissiveIntensity: 1.05, roughness: 0.85 }),
    );
    this.add(shops.build(), shopMat, { cast: true });

    // blinking aircraft warning lights
    const aGeo = new THREE.SphereGeometry(0.35, 8, 6);
    const aMat = this.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.05, 0.05), toneMapped: false }));
    this.antennaLights = new THREE.InstancedMesh(aGeo, aMat, Math.max(1, antennas.length));
    const m4 = new THREE.Matrix4();
    antennas.forEach((p, i) => this.antennaLights!.setMatrixAt(i, m4.makeTranslation(p.x, p.y, p.z)));
    this.antennaLights.count = antennas.length;
    this.group.add(this.antennaLights);

    // neon signs grouped by word texture
    const signTex = SIGN_WORDS.map(([w, c]) => this.tex(T.neonSignTexture(w, c)));
    const byWord = new Map<number, Batch>();
    for (const s of signs) {
      let bt = byWord.get(s.word);
      if (!bt) {
        bt = new Batch();
        byWord.set(s.word, bt);
      }
      const hw = s.w / 2;
      const hh = s.h / 2;
      const c = Math.cos(s.rotY);
      const sn = Math.sin(s.rotY);
      // local right axis for a plane facing +z rotated by rotY
      const rx = c;
      const rz = -sn;
      const p = s.pos;
      const corner = (u: number, v: number): V3 => [p.x + rx * u, p.y + v, p.z + rz * u];
      const uvs: [number, number][] = s.vertical
        ? [[0, 1], [0, 0], [1, 0], [1, 1]]
        : [[0, 0], [1, 0], [1, 1], [0, 1]];
      bt.quad(corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh), uvs);
    }
    byWord.forEach((bt, word) => {
      const m = this.mat(new THREE.MeshBasicMaterial({ map: signTex[word], toneMapped: false, color: new THREE.Color(1.6, 1.6, 1.6) }));
      this.add(bt.build(), m, { receive: false });
    });
    for (const f of facades) {
      void f;
    }
  }

  // ----------------------------------------------------------- highway

  private buildHighway(index: number): void {
    const hw = HIGHWAYS[index];
    const concrete = this.tex(T.concreteTexture());
    const cMat = this.mat(new THREE.MeshStandardMaterial({ map: concrete, roughness: 1, color: '#6f6f74', side: THREE.DoubleSide }));
    const barrierMat = this.mat(new THREE.MeshStandardMaterial({ color: '#8c8a84', roughness: 0.95 }));
    const deck = new Batch();
    const barriers = new Batch();
    const hw2 = hw.width / 2 + 0.8;
    const h = hw.height;
    const L = hw.deckHalf;
    const R = hw.rampEnd;
    const box = (u0: number, u1: number, v0: number, v1: number, y0: number, y1: number, b: Batch, opts: Parameters<Batch['box']>[6] = {}) => {
      const r = hwRect(hw, u0, u1, v0, v1);
      b.box(r.x0, y0, r.z0, r.x1, y1, r.z1, opts);
    };
    // deck slab + girders
    box(-L, L, -hw2, hw2, h - 1.2, h, deck, { uScale: 8, vScale: 4, top: false, bottom: true });
    for (const side of [-1, 1]) box(-L, L, side * 5 - 0.6, side * 5 + 0.6, h - 2.2, h - 1.2, deck, { uScale: 8, top: false, bottom: true });
    // ramps as sloped slabs, built in short steps
    const steps = 14;
    for (const dir of [-1, 1]) {
      for (let k = 0; k < steps; k += 1) {
        const ua = dir * (L + ((R - L) * k) / steps);
        const ub = dir * (L + ((R - L) * (k + 1)) / steps);
        const ya = hwHeightAt(hw, ua) ?? 0;
        const yb = hwHeightAt(hw, ub) ?? 0;
        const top = Math.max(ya, yb);
        box(ua, ub, -hw2, hw2, Math.max(0, top - 1.2), top - 0.05, deck, { uScale: 8, vScale: 4, top: false, bottom: true });
        for (const side of [-1, 1]) {
          const r = hwRect(hw, ua, ub, side * (hw.width / 2 + 0.05), side * (hw.width / 2 + 0.75));
          barriers.box(r.x0, Math.min(ya, yb) - 0.2, r.z0, r.x1, top + 1.1, r.z1, { uScale: 4, vScale: 1.1 });
        }
      }
    }
    // pillars (from the collision layout) with cap beams
    for (const b of this.layout.boxes) {
      if (b.kind !== 'pillar') continue;
      const cx = (b.x0 + b.x1) / 2;
      const cz = (b.z0 + b.z1) / 2;
      const onThis = hw.axis === 'x' ? Math.abs(cz - hw.line) < 2 : Math.abs(cx - hw.line) < 2;
      if (!onThis) continue;
      deck.box(b.x0, -0.1, b.z0, b.x1, b.y1 - 1, b.z1, { uScale: 3, vScale: 4, top: false });
      const capV = hw.width / 2 - 1.5;
      const r = hw.axis === 'x' ? { x0: cx - 1.8, x1: cx + 1.8, z0: cz - capV, z1: cz + capV } : { x0: cx - capV, x1: cx + capV, z0: cz - 1.8, z1: cz + 1.8 };
      deck.box(r.x0, b.y1 - 1, r.z0, r.x1, b.y1, r.z1, { uScale: 4, vScale: 2, bottom: true, top: false });
    }
    // jersey barriers on the deck
    for (const side of [-1, 1]) box(-L, L, side * (hw.width / 2 + 0.05), side * (hw.width / 2 + 0.75), h, h + 1.1, barriers, { uScale: 4, vScale: 1.1 });
    this.add(deck.build(), cMat, { cast: true, receive: true });
    this.add(barriers.build(), barrierMat, { cast: true, receive: true });

    // overhead gantry signs (posts are solid in the layout)
    const gantryMat = this.mat(new THREE.MeshStandardMaterial({ color: '#3a3d44', metalness: 0.5, roughness: 0.6 }));
    const labels = index === 0 ? ['WEST ◀ RIVERSIDE', 'EAST ▶ HILL TUNNEL'] : ['SOUTH ▼ HARBOR', 'NORTH ▲ UPTOWN'];
    [-L * 0.45, L * 0.45].forEach((gu, gi) => {
      const g = new Batch();
      for (const side of [-1, 1]) box(gu - 0.3, gu + 0.3, side * (hw.width / 2 - 0.6), side * (hw.width / 2), h, h + 7, g, { uScale: 1 });
      box(gu - 0.4, gu + 0.4, -hw.width / 2, hw.width / 2, h + 6.4, h + 7.2, g, { uScale: 1 });
      this.add(g.build(), gantryMat, { cast: true });
      const signMat = this.mat(new THREE.MeshBasicMaterial({ map: this.tex(T.neonSignTexture(labels[gi], '#5dff8f')), toneMapped: false }));
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(12, 3), signMat);
      const p = hwPoint(hw, gu + (gu < 0 ? -0.45 : 0.45), 0);
      sign.position.set(p.x, h + 5.2, p.z);
      // face the traffic approaching the gantry from the deck centre
      const towardCentre = gu < 0 ? 1 : -1;
      sign.rotation.y = hw.axis === 'x' ? (towardCentre > 0 ? Math.PI / 2 : -Math.PI / 2) : towardCentre > 0 ? 0 : Math.PI;
      this.group.add(sign);
    });
  }

  // ------------------------------------------------------- roundabouts

  private buildRoundabouts(): void {
    const ringTex = (() => {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 64;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#26272b';
      ctx.fillRect(0, 0, 256, 64);
      for (let i = 0; i < 2200; i += 1) {
        const v = Math.random() * 50;
        ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
        ctx.fillRect(Math.random() * 256, Math.random() * 64, 2, 2);
      }
      ctx.fillStyle = '#d9d6cc';
      for (let x = 0; x < 256; x += 32) ctx.fillRect(x, 30, 18, 4); // dashed lane divider
      ctx.fillRect(0, 2, 256, 3);
      ctx.fillRect(0, 59, 256, 3);
      const t = new THREE.CanvasTexture(c);
      t.wrapS = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      return this.tex(t);
    })();
    ringTex.repeat.set(10, 1);
    const ringMat = this.mat(new THREE.MeshStandardMaterial({ map: ringTex, roughness: 0.85 }));
    const curbMat = this.mat(new THREE.MeshStandardMaterial({ color: '#b8b5ab', roughness: 0.8 }));
    const grassMat = this.mat(new THREE.MeshStandardMaterial({ map: this.tex(T.grassTexture()), roughness: 1 }));
    const stone = this.mat(new THREE.MeshStandardMaterial({ color: '#9c9486', roughness: 0.75 }));
    const beacon = this.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.2, 0.6), toneMapped: false }));
    const { island, outer } = ROUNDABOUT;
    const parts: THREE.Mesh[] = [];
    for (const r of this.layout.roundabouts) {
      // ring road: UVs run around the ring so the dashes follow it
      const geo = new THREE.RingGeometry(island, outer, 48, 1);
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i += 1) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const rad = Math.hypot(x, y);
        uv.setXY(i, (Math.atan2(y, x) / (Math.PI * 2) + 0.5), (rad - island) / (outer - island));
      }
      geo.rotateX(-Math.PI / 2);
      const ring = new THREE.Mesh(geo, ringMat);
      ring.position.set(r.x, 0.03, r.z);
      ring.receiveShadow = true;
      const curb = new THREE.Mesh(new THREE.CylinderGeometry(island, island + 0.2, 0.5, 40), curbMat);
      curb.position.set(r.x, 0.25, r.z);
      const lawn = new THREE.Mesh(new THREE.CylinderGeometry(island - 0.4, island - 0.4, 0.55, 40), grassMat);
      lawn.position.set(r.x, 0.28, r.z);
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.8, 1.4, 8), stone);
      plinth.position.set(r.x, 1.2, r.z);
      const obelisk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 1.1, 9, 4), stone);
      obelisk.position.set(r.x, 6.3, r.z);
      obelisk.rotation.y = Math.PI / 4;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), beacon);
      cap.position.set(r.x, 11, r.z);
      parts.push(ring, curb, lawn, plinth, obelisk, cap);
    }
    // merge all roundabouts into one mesh per material
    const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const m of parts) {
      m.updateMatrix();
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
      const list = byMat.get(m.material as THREE.Material) ?? [];
      list.push(g);
      byMat.set(m.material as THREE.Material, list);
      m.geometry.dispose();
    }
    for (const [mat, geos] of byMat) {
      const merged = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      if (merged) this.add(merged, mat, { cast: mat !== ringMat && mat !== beacon, receive: true });
    }
    // small trees on the island edges
    for (const r of this.layout.roundabouts) {
      for (let k = 0; k < 5; k += 1) {
        const a = (k / 5) * Math.PI * 2 + 0.4;
        this.layout.trees.push({ x: r.x + Math.cos(a) * 6, z: r.z + Math.sin(a) * 6, s: 0.7, y: 0.5 });
      }
    }
  }

  private buildParkingLots(): void {
    const lots = this.layout.blocks.filter((b) => b.type === 'lot');
    if (!lots.length) return;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#2a2b30';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4000; i += 1) {
      const v = Math.random() * 60;
      ctx.fillStyle = `rgba(${v},${v},${v},0.3)`;
      ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    const tex = this.tex(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const mat = this.mat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    const lines = new Batch();
    const ground = new Batch();
    for (const b of lots) {
      ground.upQuad([b.x0, 0.05, b.z0], [b.x1, 0.05, b.z0], [b.x1, 0.05, b.z1], [b.x0, 0.05, b.z1], [[0, 0], [4, 0], [4, 4], [0, 4]]);
      for (const rz of [b.z0 + 6, b.z0 + 17, b.z1 - 17, b.z1 - 6]) {
        for (let x = b.x0 + 2.3; x < b.x1 - 2; x += 3.4) lines.upQuad([x - 0.06, 0.07, rz - 2.6], [x + 0.06, 0.07, rz - 2.6], [x + 0.06, 0.07, rz + 2.6], [x - 0.06, 0.07, rz + 2.6]);
      }
    }
    this.add(ground.build(), mat);
    this.add(lines.build(), this.mat(new THREE.MeshBasicMaterial({ color: '#cfcab8' })));
    // parked cars: one instanced low-poly body + cabin with per-car colour
    const cars = this.layout.parkedCars;
    const bodyGeo = new THREE.BoxGeometry(1.9, 0.75, 4.3);
    bodyGeo.translate(0, 0.65, 0);
    const cabGeo = new THREE.BoxGeometry(1.6, 0.6, 2.2);
    cabGeo.translate(0, 1.3, -0.2);
    const palette = ['#b8282e', '#2a5fb8', '#e8e8ea', '#3a3d44', '#1f6b4a', '#8a6a3a', '#6a2a8a', '#c4c8cc', '#d47a1f'];
    const bodies = new THREE.InstancedMesh(bodyGeo, this.mat(new THREE.MeshStandardMaterial({ roughness: 0.6, metalness: 0.25 })), cars.length);
    const cabs = new THREE.InstancedMesh(cabGeo, this.mat(new THREE.MeshStandardMaterial({ color: '#10151c', roughness: 0.45, metalness: 0.4 })), cars.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    cars.forEach((car, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), car.rot);
      m4.compose(new THREE.Vector3(car.x, 0, car.z), q, new THREE.Vector3(1, 1, 1));
      bodies.setMatrixAt(i, m4);
      cabs.setMatrixAt(i, m4);
      bodies.setColorAt(i, col.set(palette[car.color % palette.length]));
    });
    bodies.castShadow = true;
    bodies.receiveShadow = true;
    cabs.castShadow = true;
    this.group.add(bodies, cabs);
  }

  // ------------------------------------------------------------- river

  private buildRiver(): void {
    const x0 = RIVER.x - RIVER.halfWidth;
    const x1 = RIVER.x + RIVER.halfWidth;
    const zA = -CITY_HALF - 10;
    const zB = CITY_HALF + 10;
    const concrete = this.tex(T.concreteTexture());
    const wallMat = this.mat(new THREE.MeshStandardMaterial({ map: concrete, color: '#5f6166', roughness: 1, side: THREE.DoubleSide }));
    const walls = new Batch();
    walls.quad([x0, -9, zA], [x0, -9, zB], [x0, 0, zB], [x0, 0, zA], [[0, 0], [100, 0], [100, 2], [0, 2]]);
    walls.quad([x1, -9, zB], [x1, -9, zA], [x1, 0, zA], [x1, 0, zB], [[0, 0], [100, 0], [100, 2], [0, 2]]);
    walls.upQuad([x0, -9, zA], [x1, -9, zA], [x1, -9, zB], [x0, -9, zB]);
    this.add(walls.build(), wallMat);

    this.waterNormal = this.tex(T.waterNormalTexture());
    this.waterNormal.repeat.set(3, 40);
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(x1 - x0, zB - zA),
      this.mat(
        new THREE.MeshStandardMaterial({
          color: '#0b2a3c',
          roughness: 0.08,
          metalness: 0.85,
          normalMap: this.waterNormal,
          normalScale: new THREE.Vector2(0.6, 0.6),
          transparent: true,
          opacity: 0.92,
        }),
      ),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(RIVER.x, RIVER.waterY, 0);
    this.water = water;
    this.group.add(water);

    // bridges: deck slab + arch ribs + lamp posts
    const steel = this.mat(new THREE.MeshStandardMaterial({ color: '#5b6f86', metalness: 0.7, roughness: 0.35 }));
    const bridge = new Batch();
    const ribs = new Batch();
    for (const j of RIVER.bridgeRows) {
      const bz = j * S;
      bridge.box(x0 - 1, -1.4, bz - HR - 0.6, x1 + 1, 0, bz + HR + 0.6, { uScale: 6, vScale: 2, bottom: true, top: false });
      for (const side of [-1, 1]) {
        const zz = bz + side * (HR + 0.2);
        const n = 14;
        for (let k = 0; k < n; k += 1) {
          const ta = k / n;
          const tb = (k + 1) / n;
          const xa = x0 + (x1 - x0) * ta;
          const xb = x0 + (x1 - x0) * tb;
          const ya = -1.4 - 5 * (1 - (2 * ta - 1) ** 2) * -1 - 6;
          const yb = -1.4 - 5 * (1 - (2 * tb - 1) ** 2) * -1 - 6;
          ribs.box(xa, Math.min(ya, yb) - 0.6, zz - 0.4, xb, Math.max(ya, yb), zz + 0.4, { uScale: 2 });
        }
        // vertical hangers from arch to deck
        for (let k = 1; k < 7; k += 1) {
          const t = k / 7;
          const xx = x0 + (x1 - x0) * t;
          const yy = -1.4 + 5 * (1 - (2 * t - 1) ** 2) - 6;
          ribs.box(xx - 0.12, yy, zz - 0.12, xx + 0.12, -1.4, zz + 0.12, { uScale: 1 });
        }
      }
    }
    this.add(bridge.build(), wallMat, { cast: true });
    this.add(ribs.build(), steel, { cast: true });
    void this.water;
  }

  // -------------------------------------------------------------- hill

  private buildHill(): void {
    const concrete = this.tex(T.concreteTexture());
    const wallMat = this.mat(new THREE.MeshStandardMaterial({ map: concrete, color: '#615e58', roughness: 1, side: THREE.DoubleSide }));
    const tz = HILL.tunnelZ;
    const wallH = 12;
    const walls = new Batch();
    const { x0, x1, z0, z1 } = HILL;
    // retaining walls (outer faces)
    walls.quad([x0, 0, z0], [x1, 0, z0], [x1, wallH, z0], [x0, wallH, z0], [[0, 0], [(x1 - x0) / 6, 0], [(x1 - x0) / 6, 2], [0, 2]]);
    walls.quad([x1, 0, z1], [x0, 0, z1], [x0, wallH, z1], [x1, wallH, z1], [[0, 0], [(x1 - x0) / 6, 0], [(x1 - x0) / 6, 2], [0, 2]]);
    for (const [xx, dir] of [[x0, -1], [x1, 1]] as [number, number][]) {
      // two wall pieces either side of the tunnel mouth + lintel above it
      const pieces: [number, number, number, number][] = [
        [z0, tz - HR - 1, 0, wallH],
        [tz + HR + 1, z1, 0, wallH],
        [tz - HR - 1, tz + HR + 1, 8.5, wallH],
      ];
      for (const [za, zb, ya, yb] of pieces) {
        if (dir < 0) walls.quad([xx, ya, za], [xx, ya, zb], [xx, yb, zb], [xx, yb, za], [[za / 6, ya / 6], [zb / 6, ya / 6], [zb / 6, yb / 6], [za / 6, yb / 6]]);
        else walls.quad([xx, ya, zb], [xx, ya, za], [xx, yb, za], [xx, yb, zb], [[za / 6, ya / 6], [zb / 6, ya / 6], [zb / 6, yb / 6], [za / 6, yb / 6]]);
      }
      // portal frame
      walls.box(xx - 1, 8.5, tz - HR - 2, xx + 1, 10, tz + HR + 2, { uScale: 4 });
      walls.box(xx - 1, 0, tz - HR - 2, xx + 1, 8.5, tz - HR - 0.6, { uScale: 4 });
      walls.box(xx - 1, 0, tz + HR + 0.6, xx + 1, 8.5, tz + HR + 2, { uScale: 4 });
    }
    // tunnel interior
    const tunnel = new Batch();
    tunnel.quad([x0, 0, tz - HR], [x1, 0, tz - HR], [x1, 8.5, tz - HR], [x0, 8.5, tz - HR], [[0, 0], [(x1 - x0) / 4, 0], [(x1 - x0) / 4, 2], [0, 2]]);
    tunnel.quad([x1, 0, tz + HR], [x0, 0, tz + HR], [x0, 8.5, tz + HR], [x1, 8.5, tz + HR], [[0, 0], [(x1 - x0) / 4, 0], [(x1 - x0) / 4, 2], [0, 2]]);
    tunnel.quad([x0, 8.5, tz + HR], [x1, 8.5, tz + HR], [x1, 8.5, tz - HR], [x0, 8.5, tz - HR], [[0, 0], [(x1 - x0) / 4, 0], [(x1 - x0) / 4, 4], [0, 4]]);
    const tileTex = this.tex(T.concreteTexture());
    const tunnelMat = this.mat(new THREE.MeshStandardMaterial({ map: tileTex, color: '#8f8a78', roughness: 0.95, side: THREE.DoubleSide }));
    this.add(tunnel.build(), tunnelMat);
    // sodium light strips and stripes
    const strips = new Batch();
    for (let x = x0 + 6; x < x1 - 4; x += 10) {
      strips.box(x, 8.3, tz - 0.4, x + 4, 8.5, tz + 0.4, { uScale: 1 });
      for (const side of [-1, 1]) strips.box(x, 1.0, tz + side * (HR - 0.06) - 0.05, x + 4, 1.25, tz + side * (HR - 0.06) + 0.05, { uScale: 1 });
    }
    this.add(strips.build(), this.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.5, 0.85, 0.3), toneMapped: false })), { receive: false });
    this.add(walls.build(), wallMat, { cast: true });

    // grassy mound on top with rock outcrops (vertex-coloured heightfield)
    const nx = 42;
    const nz = 28;
    const geo = new THREE.PlaneGeometry(x1 - x0, z1 - z0, nx, nz);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors: number[] = [];
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    for (let i = 0; i < pos.count; i += 1) {
      const lx = pos.getX(i) + cx;
      const lz = pos.getZ(i) + cz;
      const edge = Math.min(lx - x0, x1 - lx, lz - z0, z1 - lz);
      const bump = Math.min(1, edge / 30);
      const n = Math.sin(lx * 0.07) * Math.cos(lz * 0.09) * 4 + Math.sin(lx * 0.21 + lz * 0.13) * 1.6;
      const y = wallH + bump * bump * (16 + n);
      pos.setXYZ(i, lx, y, lz);
      const rock = n > 2.6 ? 1 : 0;
      const g = 0.12 + bump * 0.1 + this.rng() * 0.04;
      colors.push(rock ? 0.26 : 0.06, rock ? 0.25 : g, rock ? 0.23 : 0.05);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const hillMesh = new THREE.Mesh(geo, this.mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, map: this.tex(T.grassTexture()) })));
    hillMesh.receiveShadow = true;
    hillMesh.castShadow = true;
    this.group.add(hillMesh);
    // trees on the hill
    for (let k = 0; k < 70; k += 1) {
      const x = x0 + 6 + this.rng() * (x1 - x0 - 12);
      const z = z0 + 6 + this.rng() * (z1 - z0 - 12);
      const edge = Math.min(x - x0, x1 - x, z - z0, z1 - z);
      const bump = Math.min(1, edge / 30);
      const n = Math.sin(x * 0.07) * Math.cos(z * 0.09) * 4 + Math.sin(x * 0.21 + z * 0.13) * 1.6;
      this.layout.trees.push({ x, z, s: 1 + this.rng() * 0.8, y: wallH + bump * bump * (16 + n) - 0.4 } as { x: number; z: number; s: number });
    }
  }

  // ------------------------------------------------------------- plaza

  private buildPlaza(): void {
    const plaza = this.layout.blocks.find((b) => b.type === 'plaza');
    if (plaza) {
      const tex = this.tex(T.plazaTexture());
      const m = this.mat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }));
      const b = new Batch();
      b.upQuad([plaza.x0, 0.03, plaza.z0], [plaza.x1, 0.03, plaza.z0], [plaza.x1, 0.03, plaza.z1], [plaza.x0, 0.03, plaza.z1]);
      this.add(b.build(), m);
      const f = this.layout.fountain;
      const stone = this.mat(new THREE.MeshStandardMaterial({ color: '#b9ad98', roughness: 0.7 }));
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(f.r, f.r + 0.3, 0.9, 32), stone);
      basin.position.set(f.x, 0.45, f.z);
      basin.castShadow = true;
      const water = new THREE.Mesh(
        new THREE.CylinderGeometry(f.r - 0.4, f.r - 0.4, 0.1, 32),
        this.mat(new THREE.MeshStandardMaterial({ color: '#1d6f8f', emissive: '#0b4e6a', emissiveIntensity: 1.2, roughness: 0.1, metalness: 0.5 })),
      );
      water.position.set(f.x, 0.85, f.z);
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 3.2, 16), stone);
      column.position.set(f.x, 1.6, f.z);
      column.castShadow = true;
      const jet = new THREE.Mesh(
        new THREE.ConeGeometry(1.4, 2.6, 16, 1, true),
        this.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 1.4, 1.8), transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false })),
      );
      jet.position.set(f.x, 3.9, f.z);
      jet.rotation.x = Math.PI;
      this.group.add(basin, water, column, jet);
    }
    const park = this.layout.blocks.find((b) => b.type === 'park');
    if (park) {
      const m = this.mat(new THREE.MeshStandardMaterial({ map: this.tex(T.grassTexture()), roughness: 1 }));
      (m.map as THREE.Texture).repeat.set(8, 8);
      const b = new Batch();
      b.upQuad([park.x0, 0.04, park.z0], [park.x1, 0.04, park.z0], [park.x1, 0.04, park.z1], [park.x0, 0.04, park.z1], [[0, 0], [8, 0], [8, 8], [0, 8]]);
      this.add(b.build(), m);
      // dirt shortcut path along the diagonal
      const path = new Batch();
      const w = 3.5;
      path.upQuad([park.x0 + w, 0.05, park.z0], [park.x0, 0.05, park.z0 + w], [park.x1 - w, 0.05, park.z1], [park.x1, 0.05, park.z1 - w]);
      this.add(path.build(), this.mat(new THREE.MeshStandardMaterial({ color: '#5a4a38', roughness: 1 })));
    }
    // kicker ramps
    const chevron = this.tex(T.chevronTexture());
    const rampMat = this.mat(new THREE.MeshStandardMaterial({ map: chevron, roughness: 0.6, metalness: 0.2 }));
    const sideMat = this.mat(new THREE.MeshStandardMaterial({ color: '#2b2b30', roughness: 0.8 }));
    for (const s of this.layout.surfaces) {
      if (s.kind !== 'kicker') continue;
      const top = new Batch();
      const sides = new Batch();
      const y0 = s.h0;
      const y1 = s.h1;
      if (s.axis === 'z') {
        top.upQuad([s.x0, y0, s.z0], [s.x1, y0, s.z0], [s.x1, y1, s.z1], [s.x0, y1, s.z1], [[0, 0], [2, 0], [2, 3], [0, 3]]);
        const hiZ = y1 > y0 ? s.z1 : s.z0;
        const hi = Math.max(y0, y1);
        sides.box(s.x0, 0, hiZ - 0.05, s.x1, hi, hiZ + 0.05, { uScale: 2 });
        for (const x of [s.x0, s.x1]) {
          const lo: V3 = [x, 0, y1 > y0 ? s.z0 : s.z1];
          const hb: V3 = [x, 0, hiZ];
          const ht: V3 = [x, hi, hiZ];
          sides.quad(lo, hb, ht, ht);
          sides.quad(hb, lo, ht, ht);
        }
      } else {
        top.upQuad([s.x0, y0, s.z0], [s.x1, y1, s.z0], [s.x1, y1, s.z1], [s.x0, y0, s.z1], [[0, 0], [3, 0], [3, 2], [0, 2]]);
        const hiX = y1 > y0 ? s.x1 : s.x0;
        const hi = Math.max(y0, y1);
        sides.box(hiX - 0.05, 0, s.z0, hiX + 0.05, hi, s.z1, { uScale: 2 });
        for (const z of [s.z0, s.z1]) {
          const lo: V3 = [y1 > y0 ? s.x0 : s.x1, 0, z];
          const hb: V3 = [hiX, 0, z];
          const ht: V3 = [hiX, hi, z];
          sides.quad(lo, hb, ht, ht);
          sides.quad(hb, lo, ht, ht);
        }
      }
      this.add(top.build(), rampMat, { cast: true });
      this.add(sides.build(), sideMat, { cast: true });
    }
  }

  // ------------------------------------------------------------- rails

  private buildRails(): void {
    const railMat = this.mat(new THREE.MeshStandardMaterial({ color: '#9aa3ad', metalness: 0.75, roughness: 0.35 }));
    const postMat = this.mat(new THREE.MeshStandardMaterial({ color: '#3d434b', metalness: 0.5, roughness: 0.5 }));
    const rails = new Batch();
    const posts = new Batch();
    const bollardMat = this.mat(new THREE.MeshStandardMaterial({ color: '#d8d2c0', roughness: 0.6 }));
    const bollards = new Batch();
    for (const b of this.layout.boxes) {
      if (b.kind === 'rail' && b.y0 < 0 && b.y1 < 2) {
        const alongX = b.x1 - b.x0 > b.z1 - b.z0;
        const cx = (b.x0 + b.x1) / 2;
        const cz = (b.z0 + b.z1) / 2;
        if (alongX) {
          rails.box(b.x0, 0.85, cz - 0.08, b.x1, 1.05, cz + 0.08, { uScale: 4 });
          rails.box(b.x0, 0.45, cz - 0.05, b.x1, 0.55, cz + 0.05, { uScale: 4 });
          for (let x = b.x0; x <= b.x1; x += 2.5) posts.box(x - 0.07, 0, cz - 0.07, x + 0.07, 1.05, cz + 0.07, { uScale: 1 });
        } else {
          rails.box(cx - 0.08, 0.85, b.z0, cx + 0.08, 1.05, b.z1, { uScale: 4 });
          rails.box(cx - 0.05, 0.45, b.z0, cx + 0.05, 0.55, b.z1, { uScale: 4 });
          for (let z = b.z0; z <= b.z1; z += 2.5) posts.box(cx - 0.07, 0, z - 0.07, cx + 0.07, 1.05, z + 0.07, { uScale: 1 });
        }
      }
      if (b.kind === 'prop' && b.y1 < 2 && (b.x1 - b.x0) * (b.z1 - b.z0) < 9) bollards.box(b.x0 + 0.4, 0, b.z0 + 0.4, b.x1 - 0.4, b.y1, b.z1 - 0.4, { uScale: 1 });
      if (b.kind === 'wall') {
        rails.box(b.x0, 0, b.z0, b.x1, 5, b.z1, { uScale: 4 });
      }
    }
    this.add(rails.build(), railMat, { cast: true });
    this.add(posts.build(), postMat);
    if (!bollards.empty) this.add(bollards.build(), bollardMat, { cast: true });
  }

  // ------------------------------------------------------------- lamps

  private buildLamps(): void {
    const all = this.layout.lamps.map((l) => ({ ...l, y: l.y ?? 0 }));
    const poleGeo = new THREE.CylinderGeometry(0.1, 0.16, 7.2, 6);
    poleGeo.translate(0, 3.6, 0);
    const armGeo = new THREE.BoxGeometry(0.12, 0.12, 2.4);
    armGeo.translate(0, 7.1, 1.1);
    const headGeo = new THREE.BoxGeometry(0.5, 0.18, 1.0);
    headGeo.translate(0, 6.98, 2.2);
    const metal = this.mat(new THREE.MeshStandardMaterial({ color: '#2f3238', metalness: 0.7, roughness: 0.45 }));
    const headMat = this.mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 2.4, 1.4), toneMapped: false }));
    const poles = new THREE.InstancedMesh(poleGeo, metal, all.length);
    const arms = new THREE.InstancedMesh(armGeo, metal, all.length);
    const heads = new THREE.InstancedMesh(headGeo, headMat, all.length);
    // light pools on the ground
    const poolGeo = new THREE.PlaneGeometry(15, 15);
    poolGeo.rotateX(-Math.PI / 2);
    const poolMat = this.mat(
      new THREE.MeshBasicMaterial({
        map: this.tex(T.glowTexture('rgba(255,190,120,0.3)', 'rgba(255,150,80,0)')),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      }),
    );
    const pools = new THREE.InstancedMesh(poolGeo, poolMat, all.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const one = new THREE.Vector3(1, 1, 1);
    all.forEach((l, i) => {
      q.setFromAxisAngle(up, l.rot);
      m.compose(new THREE.Vector3(l.x, l.y, l.z), q, one);
      poles.setMatrixAt(i, m);
      arms.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      const fx = Math.sin(l.rot) * 2.4;
      const fz = Math.cos(l.rot) * 2.4;
      m.makeTranslation(l.x + fx, l.y + 0.06, l.z + fz);
      pools.setMatrixAt(i, m);
    });
    poles.castShadow = true;
    pools.renderOrder = 1;
    this.group.add(poles, arms, heads, pools);

    // traffic lights at alternating intersections
    const tl = this.layout.trafficLights;
    const tlPole = new THREE.CylinderGeometry(0.12, 0.12, 5, 6);
    tlPole.translate(0, 2.5, 0);
    const tlBox = new THREE.BoxGeometry(0.5, 1.5, 0.45);
    tlBox.translate(0, 4.6, 0);
    const poleM = new THREE.InstancedMesh(tlPole, metal, tl.length);
    const boxM = new THREE.InstancedMesh(tlBox, this.mat(new THREE.MeshStandardMaterial({ color: '#1a1b1e' })), tl.length);
    const bulbGeo = new THREE.SphereGeometry(0.16, 8, 6);
    const bulbs = new THREE.InstancedMesh(bulbGeo, this.mat(new THREE.MeshBasicMaterial({ toneMapped: false })), tl.length * 2);
    const colors = [new THREE.Color(4, 0.2, 0.15), new THREE.Color(0.2, 4, 0.8), new THREE.Color(4, 2.4, 0.1)];
    tl.forEach((t, i) => {
      m.makeTranslation(t.x, 0, t.z);
      poleM.setMatrixAt(i, m);
      boxM.setMatrixAt(i, m);
      const c = colors[i % 3];
      m.makeTranslation(t.x - 0.26, 4.6 + (i % 3 === 0 ? 0.45 : i % 3 === 2 ? 0 : -0.45), t.z);
      bulbs.setMatrixAt(i * 2, m);
      bulbs.setColorAt(i * 2, c);
      m.makeTranslation(t.x, 4.6 + (i % 3 === 0 ? 0.45 : i % 3 === 2 ? 0 : -0.45), t.z - 0.24);
      bulbs.setMatrixAt(i * 2 + 1, m);
      bulbs.setColorAt(i * 2 + 1, c);
    });
    this.group.add(poleM, boxM, bulbs);
  }

  private buildTrees(): void {
    const trees = this.layout.trees as { x: number; z: number; s: number; y?: number }[];
    const trunk = new THREE.CylinderGeometry(0.18, 0.28, 2.6, 6);
    trunk.translate(0, 1.3, 0);
    const crown = new THREE.IcosahedronGeometry(1.9, 1);
    crown.translate(0, 3.8, 0);
    const trunkM = new THREE.InstancedMesh(trunk, this.mat(new THREE.MeshStandardMaterial({ color: '#3b2a1f', roughness: 1 })), trees.length);
    const crownM = new THREE.InstancedMesh(crown, this.mat(new THREE.MeshStandardMaterial({ color: '#2c5a2c', roughness: 0.9, flatShading: true })), trees.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rng() * 6);
      m.compose(new THREE.Vector3(t.x, t.y ?? 0, t.z), q, new THREE.Vector3(t.s, t.s * (0.9 + this.rng() * 0.3), t.s));
      trunkM.setMatrixAt(i, m);
      crownM.setMatrixAt(i, m);
      c.setHSL(0.27 + this.rng() * 0.08, 0.45, 0.16 + this.rng() * 0.1);
      crownM.setColorAt(i, c);
    });
    trunkM.castShadow = true;
    crownM.castShadow = true;
    crownM.receiveShadow = true;
    this.group.add(trunkM, crownM);
  }

  // ------------------------------------------------------------ skyline

  private buildSkyline(): void {
    const facades = [0, 2, 4].map((i) => T.facadeTextures(i));
    const batches = facades.map(() => new Batch());
    for (let k = 0; k < 190; k += 1) {
      const a = (k / 190) * Math.PI * 2 + this.rng() * 0.02;
      const r = 430 + this.rng() * 280;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const w = 18 + this.rng() * 30;
      const d = 18 + this.rng() * 30;
      const h = 30 + this.rng() * 130 * (r < 560 ? 1 : 0.7);
      const i = k % 3;
      batches[i].box(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, { uScale: facades[i].tileW, vScale: facades[i].tileH, top: false });
    }
    facades.forEach((f, i) => {
      const mat = this.mat(
        new THREE.MeshStandardMaterial({
          map: this.tex(f.map),
          emissiveMap: this.tex(f.emissive),
          emissive: new THREE.Color('#ffffff'),
          emissiveIntensity: 1.1,
          roughness: 0.9,
        }),
      );
      this.add(batches[i].build(), mat, { receive: false });
    });
  }
}
