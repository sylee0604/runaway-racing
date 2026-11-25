import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type VehicleKind = 'player' | 'patrol' | 'interceptor' | 'swat' | 'apc' | 'civilian';

export interface VehicleVisual {
  root: THREE.Group;
  body: THREE.Group; // tilts/rolls independently of root yaw
  wheels: THREE.Object3D[]; // spin around local x
  frontWheels: THREE.Object3D[]; // steer around y
  brakeMat: THREE.MeshBasicMaterial;
  headMat: THREE.MeshBasicMaterial;
  sirenRed: THREE.Object3D[];
  sirenBlue: THREE.Object3D[];
  sirenMats: THREE.MeshBasicMaterial[];
  paint: THREE.MeshStandardMaterial;
  height: number;
}

const shared = new Map<string, THREE.Material>();

/** Free per-instance GPU resources (shared materials are kept). */
export function disposeVehicleVisual(root: THREE.Object3D): void {
  const sharedSet = new Set(shared.values());
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !m.userData.sharedGeometry) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      if (sharedSet.has(mat)) continue;
      const mm = mat as THREE.MeshBasicMaterial;
      if (mm.map && mm.map !== glowTexCache.tex) mm.map.dispose();
      mat.dispose();
    }
  });
}
function sharedMat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = shared.get(key);
  if (!m) {
    m = make();
    shared.set(key, m);
  }
  return m as T;
}

const glowTexCache: { tex?: THREE.Texture } = {};
function glowTex(): THREE.Texture {
  if (glowTexCache.tex) return glowTexCache.tex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  glowTexCache.tex = t;
  return t;
}

function textDecal(text: string, fg: string, bg = 'rgba(0,0,0,0)'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 256, 64);
  ctx.font = 'bold 44px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fg;
  ctx.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Extrude a side profile (x = forward, y = up) across the car width, centered. */
function profileBody(points: [number, number][], width: number, bevel = 0.08): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 2,
    curveSegments: 4,
  });
  geo.rotateY(-Math.PI / 2);
  geo.translate((width - bevel * 2) / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

function coloredGeo(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g !== geo) g.dispose();
  return geo;
}

const wheelCache = new Map<string, THREE.BufferGeometry>();
function wheel(radius: number, width: number): THREE.Mesh {
  const key = `${radius}:${width}`;
  let geo = wheelCache.get(key);
  if (!geo) {
    const tire = coloredGeo(new THREE.CylinderGeometry(radius, radius, width, 18).rotateZ(Math.PI / 2), '#111113');
    const rim = coloredGeo(new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, width + 0.02, 10).rotateZ(Math.PI / 2), '#b8bcc4');
    const spoke = coloredGeo(new THREE.BoxGeometry(width + 0.04, radius * 1.1, 0.12), '#4a4e56');
    geo = mergeGeometries([tire, rim, spoke])!;
    wheelCache.set(key, geo);
  }
  const m = new THREE.Mesh(
    geo,
    sharedMat('wheel', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.5 })),
  );
  m.castShadow = true;
  m.userData.sharedGeometry = true;
  return m;
}

/** Merge static body meshes that share a material into one mesh each (fewer draw calls). */
function mergeByMaterial(group: THREE.Group, keep: Set<THREE.Object3D>): void {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const remove: THREE.Mesh[] = [];
  for (const child of group.children) {
    const m = child as THREE.Mesh;
    if (!m.isMesh || keep.has(m) || Array.isArray(m.material)) continue;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const list = buckets.get(m.material as THREE.Material) ?? [];
    list.push(g);
    buckets.set(m.material as THREE.Material, list);
    remove.push(m);
  }
  for (const m of remove) {
    group.remove(m);
    m.geometry.dispose();
  }
  for (const [mat, geos] of buckets) {
    const merged = mergeGeometries(geos);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function glowSprite(color: THREE.Color, size: number): THREE.Sprite {
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  );
  s.scale.set(size, size, size);
  return s;
}

const CIVILIAN_COLORS = ['#b8282e', '#2a5fb8', '#e8e8ea', '#3a3d44', '#1f6b4a', '#8a6a3a', '#6a2a8a', '#c4c8cc', '#d47a1f'];

export function createVehicleModel(kind: VehicleKind, variant = 0): VehicleVisual {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const wheels: THREE.Object3D[] = [];
  const frontWheels: THREE.Object3D[] = [];
  const sirenRed: THREE.Object3D[] = [];
  const sirenBlue: THREE.Object3D[] = [];
  const sirenMats: THREE.MeshBasicMaterial[] = [];

  let color = '#f2c200';
  let L = 4.5;
  let W = 2.0;
  let wheelR = 0.42;
  let profile: [number, number][];
  let cabin: [number, number][];
  let height = 1.5;

  switch (kind) {
    case 'player':
      color = '#f5c000';
      L = 4.5;
      W = 2.02;
      profile = [[-2.25, 0.32], [2.25, 0.32], [2.3, 0.62], [1.6, 0.86], [0.7, 0.98], [-1.7, 1.02], [-2.28, 1.0], [-2.3, 0.6]];
      cabin = [[-1.45, 0.98], [-0.55, 1.38], [0.45, 1.38], [1.05, 0.98]];
      height = 1.4;
      break;
    case 'patrol':
      color = '#121318';
      L = 4.8;
      W = 2.0;
      profile = [[-2.4, 0.32], [2.4, 0.32], [2.42, 0.7], [1.7, 0.92], [-1.9, 0.98], [-2.42, 0.94], [-2.42, 0.55]];
      cabin = [[-1.6, 0.96], [-0.9, 1.5], [0.6, 1.5], [1.2, 0.94]];
      height = 1.7;
      break;
    case 'interceptor':
      color = '#24262b';
      L = 4.7;
      W = 2.04;
      profile = [[-2.35, 0.3], [2.35, 0.3], [2.4, 0.6], [1.7, 0.84], [0.6, 0.96], [-1.8, 1.0], [-2.38, 0.98], [-2.4, 0.55]];
      cabin = [[-1.5, 0.96], [-0.6, 1.36], [0.4, 1.36], [1.05, 0.96]];
      height = 1.4;
      break;
    case 'swat':
      color = '#1a2233';
      L = 6.2;
      W = 2.45;
      wheelR = 0.58;
      profile = [[-3.1, 0.45], [3.1, 0.45], [3.15, 1.4], [2.3, 1.7], [2.2, 2.85], [-3.1, 2.85]];
      cabin = [[1.2, 1.7], [1.45, 2.5], [2.15, 2.5], [2.25, 1.7]];
      height = 2.9;
      break;
    case 'apc':
      color = '#4a5230';
      L = 7.0;
      W = 2.8;
      wheelR = 0.72;
      profile = [[-3.4, 0.6], [3.0, 0.6], [3.55, 1.5], [2.4, 2.25], [-3.3, 2.3], [-3.5, 1.4]];
      cabin = [[1.6, 2.1], [1.8, 2.45], [2.3, 2.45], [2.45, 2.1]];
      height = 3.2;
      break;
    default: {
      color = CIVILIAN_COLORS[variant % CIVILIAN_COLORS.length];
      const van = variant % 4 === 3;
      L = van ? 5 : 4.4;
      W = van ? 2.05 : 1.9;
      profile = van
        ? [[-2.5, 0.35], [2.5, 0.35], [2.55, 0.9], [1.9, 1.2], [1.4, 2.1], [-2.5, 2.1]]
        : [[-2.2, 0.32], [2.2, 0.32], [2.22, 0.7], [1.5, 0.9], [-1.8, 0.96], [-2.2, 0.92], [-2.22, 0.55]];
      cabin = van ? [[0.6, 1.2], [0.8, 1.9], [1.35, 1.9], [1.75, 1.2]] : [[-1.4, 0.94], [-0.8, 1.45], [0.5, 1.45], [1.1, 0.92]];
      height = van ? 2.2 : 1.5;
    }
  }

  const paint = new THREE.MeshStandardMaterial({
    color,
    metalness: kind === 'apc' || kind === 'swat' ? 0.25 : 0.6,
    roughness: kind === 'apc' ? 0.8 : 0.32,
    envMapIntensity: 1,
  });
  const bodyMesh = new THREE.Mesh(profileBody(profile, W), paint);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  body.add(bodyMesh);

  const glass = sharedMat('glass', () => new THREE.MeshStandardMaterial({ color: '#0d1218', metalness: 0.9, roughness: 0.08 }));
  const cab = new THREE.Mesh(profileBody(cabin, W * (kind === 'swat' || kind === 'apc' ? 0.96 : 0.84), 0.06), glass);
  cab.castShadow = true;
  body.add(cab);
  // roof panel over glass for cars
  if (kind !== 'swat' && kind !== 'apc' && !(kind === 'civilian' && variant % 4 === 3)) {
    const roofY = cabin[1][1];
    const roofLen = cabin[2][0] - cabin[1][0];
    const roof = box(W * 0.8, 0.06, roofLen + 0.1, kind === 'patrol' ? sharedMat('white', () => new THREE.MeshStandardMaterial({ color: '#f2f2f2', metalness: 0.4, roughness: 0.35 })) : paint, 0, roofY + 0.02, (cabin[1][0] + cabin[2][0]) / 2);
    body.add(roof);
  }

  const dark = sharedMat('trim', () => new THREE.MeshStandardMaterial({ color: '#0b0b0d', roughness: 0.6, metalness: 0.4 }));
  const chrome = sharedMat('chrome', () => new THREE.MeshStandardMaterial({ color: '#d6d9de', roughness: 0.2, metalness: 1 }));
  // bumpers & grille
  body.add(box(W * 0.98, 0.26, 0.2, dark, 0, 0.45, L / 2 + 0.02));
  body.add(box(W * 0.98, 0.26, 0.2, dark, 0, 0.45, -L / 2 - 0.02));

  // lights
  const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.9, 2.5), toneMapped: false });
  const brakeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 0.05, 0.05), toneMapped: false });
  const lightY = kind === 'swat' ? 1.2 : kind === 'apc' ? 1.5 : 0.68;
  for (const side of [-1, 1]) {
    const hx = side * W * 0.34;
    body.add(box(0.46, 0.16, 0.08, headMat, hx, lightY, L / 2 + 0.11 + (kind === 'apc' ? 0.1 : 0)));
    body.add(box(0.5, 0.16, 0.08, brakeMat, hx, lightY + 0.08, -L / 2 - 0.11));
    const bs = glowSprite(new THREE.Color(1, 0.08, 0.05), 0.9);
    bs.position.set(hx, lightY + 0.08, -L / 2 - 0.2);
    body.add(bs);
    const hs = glowSprite(new THREE.Color(1, 0.95, 0.8), 1.4);
    hs.position.set(hx, lightY, L / 2 + 0.3);
    body.add(hs);
  }

  // wheels
  const axle = L / 2 - (kind === 'apc' ? 1.0 : kind === 'swat' ? 1.05 : 0.82);
  const axles = kind === 'apc' ? [axle, 0, -axle] : [axle, -axle];
  for (const az of axles) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * (W / 2 - 0.12), wheelR, az);
      const w = wheel(wheelR, kind === 'apc' ? 0.5 : 0.32);
      pivot.add(w);
      root.add(pivot);
      wheels.push(w);
      if (az === axle) frontWheels.push(pivot);
    }
  }

  // kind-specific details
  if (kind === 'player') {
    const stripe = sharedMat('stripe', () => new THREE.MeshStandardMaterial({ color: '#111', metalness: 0.5, roughness: 0.4 }));
    for (const sx of [-0.28, 0.28]) {
      body.add(box(0.22, 0.02, 1.6, stripe, sx, 0.99, 1.4));
      body.add(box(0.22, 0.02, 0.6, stripe, sx, 1.03, -1.95));
    }
    // spoiler
    body.add(box(W * 0.9, 0.06, 0.38, stripe, 0, 1.32, -2.05));
    for (const sx of [-0.7, 0.7]) body.add(box(0.08, 0.3, 0.2, stripe, sx, 1.15, -2.0));
    // exhausts
    for (const sx of [-0.45, 0.45]) {
      const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.25, 8), chrome);
      ex.rotation.x = Math.PI / 2;
      ex.position.set(sx, 0.38, -L / 2 - 0.12);
      body.add(ex);
    }
  }

  if (kind === 'patrol' || kind === 'interceptor' || kind === 'swat') {
    const white = sharedMat('white', () => new THREE.MeshStandardMaterial({ color: '#f2f2f2', metalness: 0.4, roughness: 0.35 }));
    if (kind === 'patrol') {
      for (const side of [-1, 1]) body.add(box(0.04, 0.42, 2.2, white, side * (W / 2 + 0.005), 0.66, 0.05));
    }
    // POLICE / SWAT side decals
    const label = kind === 'swat' ? 'SWAT' : 'POLICE';
    const decal = new THREE.MeshBasicMaterial({ map: textDecal(label, kind === 'patrol' ? '#13161c' : '#e9eef6'), transparent: true, depthWrite: false });
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(kind === 'swat' ? 3.2 : 1.9, kind === 'swat' ? 0.8 : 0.48), decal);
      p.position.set(side * (W / 2 + 0.03), kind === 'swat' ? 2.0 : 0.66, kind === 'swat' ? -0.6 : 0.05);
      p.rotation.y = side * Math.PI / 2;
      body.add(p);
    }
    // push bar
    body.add(box(W * 0.75, 0.5, 0.14, dark, 0, kind === 'swat' ? 1.0 : 0.62, L / 2 + 0.2));
  }

  const addSiren = (x: number, y: number, z: number, red: boolean, size = 0.36) => {
    const m = new THREE.MeshBasicMaterial({ color: red ? new THREE.Color(4, 0.1, 0.1) : new THREE.Color(0.15, 0.4, 4), toneMapped: false });
    sirenMats.push(m);
    const b = box(size * 1.6, 0.14, size, m, x, y, z);
    b.castShadow = false;
    body.add(b);
    const glow = glowSprite(red ? new THREE.Color(1, 0.1, 0.1) : new THREE.Color(0.2, 0.45, 1), 3.2);
    glow.position.set(x, y + 0.1, z);
    body.add(glow);
    (red ? sirenRed : sirenBlue).push(b, glow);
  };

  if (kind === 'patrol') {
    body.add(box(1.5, 0.08, 0.36, dark, 0, cabin[1][1] + 0.08, -0.15));
    addSiren(-0.42, cabin[1][1] + 0.18, -0.15, true);
    addSiren(0.42, cabin[1][1] + 0.18, -0.15, false);
  }
  if (kind === 'interceptor') {
    addSiren(-0.4, 0.72, L / 2 + 0.12, true, 0.22);
    addSiren(0.4, 0.72, L / 2 + 0.12, false, 0.22);
    addSiren(-0.3, 1.3, 0.55, true, 0.2);
    addSiren(0.3, 1.3, 0.55, false, 0.2);
  }
  if (kind === 'swat') {
    addSiren(-0.7, 2.95, 2.0, true);
    addSiren(0.7, 2.95, 2.0, false);
    addSiren(-0.9, 2.95, -2.9, true, 0.25);
    addSiren(0.9, 2.95, -2.9, false, 0.25);
    // ram plate
    body.add(box(W * 1.0, 0.9, 0.25, sharedMat('ram', () => new THREE.MeshStandardMaterial({ color: '#2b2d31', metalness: 0.8, roughness: 0.4 })), 0, 0.9, L / 2 + 0.28));
    // side windows (slits)
    for (const side of [-1, 1]) body.add(box(0.03, 0.25, 2.4, glass, side * (W / 2 + 0.02), 2.35, -0.9));
  }
  if (kind === 'apc') {
    const armor = paint;
    // turret
    const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.0, 0.6, 8), armor);
    turret.position.set(0, 2.6, -0.4);
    turret.castShadow = true;
    body.add(turret);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 2.4, 8), dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 2.7, 0.9);
    body.add(barrel);
    for (const side of [-1, 1]) body.add(box(0.12, 0.5, 6.0, armor, side * (W / 2 + 0.05), 1.15, -0.2));
    addSiren(-0.5, 2.38, 2.3, true, 0.25);
    addSiren(0.5, 2.38, 2.3, false, 0.25);
    const star = new THREE.MeshBasicMaterial({ map: textDecal('★ ARMY', '#d8d4b0'), transparent: true, depthWrite: false });
    for (const side of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), star);
      p.position.set(side * (W / 2 + 0.13), 1.7, -0.9);
      p.rotation.y = side * Math.PI / 2;
      body.add(p);
    }
  }

  mergeByMaterial(body, new Set([...sirenRed, ...sirenBlue]));
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.receiveShadow = true;
  });
  if (kind === 'civilian') {
    root.traverse((o) => {
      o.castShadow = false;
    });
  }

  return { root, body, wheels, frontWheels, brakeMat, headMat, sirenRed, sirenBlue, sirenMats, paint, height };
}

export interface HelicopterVisual {
  root: THREE.Group;
  rotor: THREE.Object3D;
  tailRotor: THREE.Object3D;
  lightPivot: THREE.Object3D;
  beacon: THREE.Object3D;
}

export function createHelicopterModel(): HelicopterVisual {
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: '#1b1e26', metalness: 0.6, roughness: 0.35 });
  const white = new THREE.MeshStandardMaterial({ color: '#e9ecf1', metalness: 0.4, roughness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({ color: '#0b1a28', metalness: 0.9, roughness: 0.05 });
  const fuselage = new THREE.Mesh(new THREE.SphereGeometry(1.6, 18, 12), paint);
  fuselage.scale.set(1, 0.85, 1.9);
  fuselage.castShadow = true;
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.25, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  canopy.scale.set(1, 0.9, 1.3);
  canopy.position.set(0, 0.1, 1.4);
  canopy.rotation.x = 0.5;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(1.62, 1.62, 0.5, 18, 1, true), white);
  band.scale.set(1, 1, 1.9);
  band.rotation.x = Math.PI / 2;
  band.rotation.z = Math.PI / 2;
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.45, 5.5, 10), paint);
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 0.4, -4.4);
  boom.castShadow = true;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.6, 0.9), paint);
  fin.position.set(0, 1.1, -6.9);
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.2, 1.2, -6.9);
  const tb = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 0.16), paint);
  tailRotor.add(tb);
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.55, 0);
  for (let k = 0; k < 4; k += 1) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.05, 6.2), paint);
    blade.position.z = 3.1;
    const arm = new THREE.Group();
    arm.rotation.y = (k * Math.PI) / 2;
    arm.add(blade);
    rotor.add(arm);
  }
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(6.2, 32),
    new THREE.MeshBasicMaterial({ color: '#8090a0', transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide }),
  );
  disc.rotation.x = -Math.PI / 2;
  rotor.add(disc);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.6, 8), paint);
  mast.position.set(0, 1.25, 0);
  const skidMat = new THREE.MeshStandardMaterial({ color: '#2a2d33', metalness: 0.8, roughness: 0.3 });
  for (const side of [-1, 1]) {
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 4, 8), skidMat);
    skid.rotation.x = Math.PI / 2;
    skid.position.set(side * 1.2, -1.55, 0);
    root.add(skid);
    for (const z of [-0.9, 0.9]) {
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.8, 6), skidMat);
      strut.position.set(side * 1.05, -1.2, z);
      strut.rotation.z = side * 0.3;
      root.add(strut);
    }
  }
  const decal = new THREE.MeshBasicMaterial({ map: textDecal('POLICE', '#13161c'), transparent: true, depthWrite: false });
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), decal);
    p.position.set(side * 1.64, 0, -0.2);
    p.rotation.y = side * Math.PI / 2;
    root.add(p);
  }
  const lightPivot = new THREE.Group();
  lightPivot.position.set(0, -1.2, 1.6);
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.32, 0.5, 10), skidMat);
  lamp.rotation.x = Math.PI / 2;
  lightPivot.add(lamp);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.1, 0.1), toneMapped: false }));
  beacon.position.set(0, -1.35, -0.5);
  root.add(fuselage, band, canopy, boom, fin, tailRotor, rotor, mast, lightPivot, beacon);
  return { root, rotor, tailRotor, lightPivot, beacon };
}
