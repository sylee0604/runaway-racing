import * as THREE from 'three';
import type { CityLayout } from '../world/CityLayout';
import { glowTexture } from '../world/textures';

export type PickupType = 'cash' | 'repair' | 'nitro';

interface Pickup {
  type: PickupType;
  group: THREE.Group;
  icon: THREE.Object3D;
  active: boolean;
  respawn: number;
}

const COUNTS: Record<PickupType, number> = { cash: 7, repair: 3, nitro: 4 };
const MIN_SPACING = 32;
const COLORS: Record<PickupType, THREE.Color> = {
  cash: new THREE.Color(0.3, 2.6, 0.6),
  repair: new THREE.Color(2.8, 0.5, 0.4),
  nitro: new THREE.Color(0.4, 1.4, 3.2),
};

function iconTexture(type: PickupType): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = type === 'cash' ? '#1f8f3a' : type === 'repair' ? '#c0392b' : '#1e5fd6';
  ctx.beginPath();
  ctx.arc(64, 64, 58, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 76px "Arial Black", Arial, sans-serif';
  ctx.fillText(type === 'cash' ? '$' : type === 'repair' ? '+' : 'N', 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Floating cash / repair / nitro pickups spawned on roads near the player. */
export class PickupSystem {
  readonly items: Pickup[] = [];
  private readonly beamTex = glowTexture();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly layout: CityLayout,
    private readonly rand: () => number,
  ) {
    const tex: Record<PickupType, THREE.Texture> = { cash: iconTexture('cash'), repair: iconTexture('repair'), nitro: iconTexture('nitro') };
    (Object.keys(COUNTS) as PickupType[]).forEach((type) => {
      for (let i = 0; i < COUNTS[type]; i += 1) {
        const group = new THREE.Group();
        const icon = new THREE.Mesh(
          new THREE.CylinderGeometry(0.9, 0.9, 0.22, 24),
          [
            new THREE.MeshStandardMaterial({ color: '#dfe3ea', metalness: 0.9, roughness: 0.2 }),
            new THREE.MeshBasicMaterial({ map: tex[type], toneMapped: false, color: new THREE.Color(1.5, 1.5, 1.5) }),
            new THREE.MeshBasicMaterial({ map: tex[type], toneMapped: false, color: new THREE.Color(1.5, 1.5, 1.5) }),
          ],
        );
        icon.rotation.x = Math.PI / 2;
        const holder = new THREE.Group();
        holder.add(icon);
        holder.position.y = 1.5;
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.5, 1.1, 14, 12, 1, true),
          new THREE.MeshBasicMaterial({ color: COLORS[type], transparent: true, opacity: 0.09, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide }),
        );
        beam.position.y = 7;
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.beamTex, color: COLORS[type], transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
        halo.scale.set(4, 4, 4);
        halo.position.y = 1.5;
        group.add(holder, beam, halo);
        group.visible = false;
        this.scene.add(group);
        this.items.push({ type, group, icon: holder, active: false, respawn: 0 });
      }
    });
  }

  reset(px: number, pz: number): void {
    for (const it of this.items) {
      it.active = false;
      it.group.visible = false;
    }
    for (const it of this.items) this.place(it, px, pz, 30, 220);
  }

  private place(it: Pickup, px: number, pz: number, minD: number, maxD: number): void {
    for (let tries = 0; tries < 80; tries += 1) {
      const pt = this.layout.randomRoadPoint(this.rand);
      const d = Math.hypot(pt.x - px, pt.z - pz);
      if (d < minD || d > maxD) continue;
      const lane = (this.rand() - 0.5) * 9;
      const x = pt.x - pt.dirZ * lane;
      const z = pt.z + pt.dirX * lane;
      // keep pickups apart and out of solids (pillars, props)
      let crowded = false;
      for (const o of this.items) {
        if (o === it || !o.active) continue;
        if (Math.hypot(o.group.position.x - x, o.group.position.z - z) < MIN_SPACING) crowded = true;
      }
      if (crowded || this.layout.isBlocked(x, z, 0, 1.5)) continue;
      it.group.position.set(x, 0, z);
      it.group.visible = true;
      it.active = true;
      return;
    }
    it.respawn = 2; // no free spot right now: try again shortly
  }

  update(dt: number, elapsed: number, player: THREE.Vector3, onPick: (type: PickupType, at: THREE.Vector3) => void): void {
    for (const it of this.items) {
      if (!it.active) {
        it.respawn -= dt;
        if (it.respawn <= 0) this.place(it, player.x, player.z, 60, 220);
        continue;
      }
      it.icon.rotation.y = elapsed * 2.4;
      it.icon.position.y = 1.5 + Math.sin(elapsed * 3 + it.group.position.x) * 0.25;
      const dx = it.group.position.x - player.x;
      const dz = it.group.position.z - player.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 3.4 * 3.4 && player.y < 3) {
        it.active = false;
        it.group.visible = false;
        it.respawn = 6;
        onPick(it.type, it.group.position);
      } else if (d2 > 300 * 300) {
        this.place(it, player.x, player.z, 60, 220);
      }
    }
  }
}
