import * as THREE from 'three';
import { glowTexture, smokeTexture } from '../world/textures';

interface Puff {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  grow: number;
  fade: number;
  active: boolean;
}

const SPARKS = 500;
const PUFFS = 160;
const SKIDS = 700;

/** Pooled particles: sparks, smoke, fire, explosion flash, tyre marks. */
export class Effects {
  readonly group = new THREE.Group();
  private readonly sparkPos = new Float32Array(SPARKS * 3);
  private readonly sparkCol = new Float32Array(SPARKS * 3);
  private readonly sparkVel = new Float32Array(SPARKS * 3);
  private readonly sparkLife = new Float32Array(SPARKS);
  private sparkCursor = 0;
  private readonly sparkGeo = new THREE.BufferGeometry();
  private readonly puffs: Puff[] = [];
  private puffCursor = 0;
  private readonly smokeMat: THREE.SpriteMaterial;
  private readonly fireMat: THREE.SpriteMaterial;
  private readonly flash = new THREE.PointLight('#ffae5a', 0, 60, 1.6);
  private flashLevel = 0;
  private readonly skids: THREE.InstancedMesh;
  private skidCursor = 0;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(private readonly rand: () => number) {
    this.sparkGeo.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3));
    this.sparkGeo.setAttribute('color', new THREE.BufferAttribute(this.sparkCol, 3));
    const sparkMat = new THREE.PointsMaterial({
      size: 0.35,
      map: glowTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const points = new THREE.Points(this.sparkGeo, sparkMat);
    points.frustumCulled = false;
    this.group.add(points);
    for (let i = 0; i < SPARKS; i += 1) this.sparkPos[i * 3 + 1] = -999;

    const smoke = smokeTexture();
    this.smokeMat = new THREE.SpriteMaterial({ map: smoke, color: '#8a8d96', transparent: true, depthWrite: false, opacity: 0.7 });
    this.fireMat = new THREE.SpriteMaterial({ map: smoke, color: new THREE.Color(3.2, 1.4, 0.4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    for (let i = 0; i < PUFFS; i += 1) {
      const sprite = new THREE.Sprite(this.smokeMat.clone());
      sprite.visible = false;
      this.group.add(sprite);
      this.puffs.push({ sprite, vel: new THREE.Vector3(), life: 0, maxLife: 1, grow: 1, fade: 1, active: false });
    }
    this.group.add(this.flash);

    const skidGeo = new THREE.PlaneGeometry(0.34, 1.2);
    skidGeo.rotateX(-Math.PI / 2);
    this.skids = new THREE.InstancedMesh(
      skidGeo,
      new THREE.MeshBasicMaterial({ color: '#050505', transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
      SKIDS,
    );
    this.skids.frustumCulled = false;
    const hidden = new THREE.Matrix4().makeTranslation(0, -999, 0);
    for (let i = 0; i < SKIDS; i += 1) this.skids.setMatrixAt(i, hidden);
    this.skids.renderOrder = 2;
    this.group.add(this.skids);
  }

  sparks(x: number, y: number, z: number, count: number, power = 1, color = new THREE.Color(4, 2.4, 0.8)): void {
    for (let k = 0; k < count; k += 1) {
      const i = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % SPARKS;
      this.sparkPos[i * 3] = x;
      this.sparkPos[i * 3 + 1] = y;
      this.sparkPos[i * 3 + 2] = z;
      const a = this.rand() * Math.PI * 2;
      const sp = (3 + this.rand() * 9) * power;
      this.sparkVel[i * 3] = Math.cos(a) * sp;
      this.sparkVel[i * 3 + 1] = 2 + this.rand() * 6 * power;
      this.sparkVel[i * 3 + 2] = Math.sin(a) * sp;
      this.sparkLife[i] = 0.35 + this.rand() * 0.5;
      this.sparkCol[i * 3] = color.r;
      this.sparkCol[i * 3 + 1] = color.g;
      this.sparkCol[i * 3 + 2] = color.b;
    }
  }

  puff(x: number, y: number, z: number, opts: { fire?: boolean; size?: number; life?: number; vx?: number; vy?: number; vz?: number; color?: string; opacity?: number } = {}): void {
    const p = this.puffs[this.puffCursor];
    this.puffCursor = (this.puffCursor + 1) % PUFFS;
    const src = opts.fire ? this.fireMat : this.smokeMat;
    const mat = p.sprite.material as THREE.SpriteMaterial;
    mat.color.copy(src.color);
    if (opts.color) mat.color.set(opts.color);
    mat.blending = src.blending;
    mat.toneMapped = src.toneMapped;
    mat.opacity = opts.opacity ?? (opts.fire ? 1 : 0.6);
    p.fade = mat.opacity;
    mat.needsUpdate = true;
    p.sprite.position.set(x, y, z);
    const size = opts.size ?? 1.5;
    p.sprite.scale.set(size, size, size);
    p.sprite.material.rotation = this.rand() * 6.28;
    p.vel.set(opts.vx ?? (this.rand() - 0.5), opts.vy ?? 1.5, opts.vz ?? (this.rand() - 0.5));
    p.life = 0;
    p.maxLife = opts.life ?? 1.4;
    p.grow = opts.fire ? 1.6 : 2.4;
    p.active = true;
    p.sprite.visible = true;
  }

  explosion(x: number, y: number, z: number): void {
    this.flash.position.set(x, y + 2, z);
    this.flashLevel = 1;
    this.sparks(x, y + 1, z, 70, 1.8);
    for (let k = 0; k < 14; k += 1) {
      this.puff(x + (this.rand() - 0.5) * 2, y + 1 + this.rand() * 1.5, z + (this.rand() - 0.5) * 2, {
        fire: true,
        size: 2.5 + this.rand() * 2.5,
        life: 0.6 + this.rand() * 0.4,
        vx: (this.rand() - 0.5) * 6,
        vy: 2 + this.rand() * 5,
        vz: (this.rand() - 0.5) * 6,
      });
    }
    for (let k = 0; k < 10; k += 1) {
      this.puff(x, y + 2, z, { size: 3 + this.rand() * 3, life: 2.5 + this.rand(), vx: (this.rand() - 0.5) * 3, vy: 3 + this.rand() * 2, vz: (this.rand() - 0.5) * 3, color: '#2c2c30', opacity: 0.75 });
    }
  }

  splash(x: number, y: number, z: number): void {
    for (let k = 0; k < 16; k += 1) {
      this.puff(x + (this.rand() - 0.5) * 3, y, z + (this.rand() - 0.5) * 3, {
        size: 2 + this.rand() * 2,
        life: 1.2,
        vx: (this.rand() - 0.5) * 5,
        vy: 5 + this.rand() * 6,
        vz: (this.rand() - 0.5) * 5,
        color: '#bfe6ff',
        opacity: 0.7,
      });
    }
  }

  skid(x: number, y: number, z: number, heading: number): void {
    const i = this.skidCursor;
    this.skidCursor = (this.skidCursor + 1) % SKIDS;
    this.q.setFromAxisAngle(this.v.set(0, 1, 0), heading);
    this.m4.compose(this.v.set(x, y + 0.04, z), this.q, this.s.set(1, 1, 1));
    this.skids.setMatrixAt(i, this.m4);
    this.skids.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    for (let i = 0; i < SPARKS; i += 1) {
      if (this.sparkLife[i] <= 0) continue;
      this.sparkLife[i] -= dt;
      if (this.sparkLife[i] <= 0) {
        this.sparkPos[i * 3 + 1] = -999;
        continue;
      }
      this.sparkVel[i * 3 + 1] -= 22 * dt;
      this.sparkPos[i * 3] += this.sparkVel[i * 3] * dt;
      this.sparkPos[i * 3 + 1] += this.sparkVel[i * 3 + 1] * dt;
      this.sparkPos[i * 3 + 2] += this.sparkVel[i * 3 + 2] * dt;
      if (this.sparkPos[i * 3 + 1] < 0.05 && this.sparkPos[i * 3 + 1] > -50) {
        this.sparkPos[i * 3 + 1] = 0.05;
        this.sparkVel[i * 3 + 1] *= -0.3;
      }
      const fade = Math.min(1, this.sparkLife[i] * 3);
      this.sparkCol[i * 3] *= 0.985 + fade * 0.015;
    }
    (this.sparkGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.sparkGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    for (const p of this.puffs) {
      if (!p.active) continue;
      p.life += dt;
      const t = p.life / p.maxLife;
      if (t >= 1) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - dt * 1.5);
      const s = p.sprite.scale.x * (1 + p.grow * dt * (1 - t));
      p.sprite.scale.set(s, s, s);
      (p.sprite.material as THREE.SpriteMaterial).opacity = p.fade * (1 - t) * (1 - t);
    }

    if (this.flashLevel > 0) {
      this.flashLevel = Math.max(0, this.flashLevel - dt * 2.2);
      this.flash.intensity = this.flashLevel * this.flashLevel * 9000;
    } else this.flash.intensity = 0;
  }

  clear(): void {
    for (const p of this.puffs) {
      p.active = false;
      p.sprite.visible = false;
    }
    this.sparkLife.fill(0);
    for (let i = 0; i < SPARKS; i += 1) this.sparkPos[i * 3 + 1] = -999;
    const hidden = new THREE.Matrix4().makeTranslation(0, -999, 0);
    for (let i = 0; i < SKIDS; i += 1) this.skids.setMatrixAt(i, hidden);
    this.skids.instanceMatrix.needsUpdate = true;
    this.flashLevel = 0;
  }
}
