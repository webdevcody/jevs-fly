// Wandering storybook goblin with a glowing wand and harmless sparkle spells.
import * as THREE from "three";
import { terrainHeight, PLAY_HALF, START_FLOWER } from "./terrain.js";

const COLORS = [0x6edc75, 0x97d65c, 0x55c99e, 0xb3df6b];

function makeGoblin(num) {
  const root = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: COLORS[num % COLORS.length], roughness: 0.68 });
  const tunic = new THREE.MeshStandardMaterial({ color: [0x8f63c7, 0xe69a64, 0x5b8aca][num % 3], roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x30243e, roughness: 0.7 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const glow = new THREE.MeshBasicMaterial({ color: 0xffd56c });
  const add = (parent, geo, mat, x, y, z) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const torso = add(root, new THREE.CapsuleGeometry(0.66, 0.95, 5, 12), tunic, 0, 1.35, 0);
  torso.scale.z = 0.8;
  add(root, new THREE.SphereGeometry(0.64, 20, 16), skin, 0, 2.42, -0.11);
  for (const side of [-1, 1]) {
    const ear = add(root, new THREE.ConeGeometry(0.25, 0.72, 8), skin, side * 0.68, 2.52, -0.02);
    ear.rotation.z = -side * Math.PI / 2;
    const eye = add(root, new THREE.SphereGeometry(0.11, 12, 8), white, side * 0.24, 2.57, -0.65);
    eye.scale.z = 0.5;
    add(root, new THREE.SphereGeometry(0.055, 10, 8), dark, side * 0.24, 2.57, -0.71);
    const foot = add(root, new THREE.SphereGeometry(0.29, 12, 8), dark, side * 0.34, 0.3, -0.2);
    foot.scale.set(0.8, 0.55, 1.35);
  }
  const nose = add(root, new THREE.SphereGeometry(0.18, 12, 8), skin, 0, 2.25, -0.7);
  nose.scale.set(0.7, 0.65, 1.25);
  const hat = add(root, new THREE.ConeGeometry(0.73, 1.45, 12), tunic, 0, 3.32, 0.08);
  hat.rotation.z = 0.13;
  const brim = add(root, new THREE.CylinderGeometry(0.84, 0.84, 0.1, 16), dark, 0, 2.75, 0.08);
  brim.scale.z = 0.8;
  const arm = new THREE.Group();
  arm.position.set(0.7, 1.98, 0);
  root.add(arm);
  const sleeve = add(arm, new THREE.CapsuleGeometry(0.16, 0.45, 4, 8), tunic, 0.1, -0.28, -0.08);
  sleeve.rotation.z = -0.45;
  add(arm, new THREE.SphereGeometry(0.19, 10, 8), skin, 0.23, -0.55, -0.12);
  const wand = add(arm, new THREE.CylinderGeometry(0.035, 0.055, 1.25, 8), dark, 0.29, -0.15, -0.38);
  wand.rotation.x = -0.65;
  const tip = add(arm, new THREE.SphereGeometry(0.13, 12, 8), glow, 0.29, 0.22, -0.78);
  const leftArm = add(root, new THREE.CapsuleGeometry(0.16, 0.45, 4, 8), tunic, -0.8, 1.65, 0);
  leftArm.rotation.z = -0.4;
  root.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  return { root, arm, tip };
}

export class Goblin {
  constructor(scene, world, num, x, z) {
    this.scene = scene;
    this.world = world;
    this.id = `goblin_${num}`;
    this.label = `GOBLIN ${num}`;
    this.model = makeGoblin(num);
    scene.add(this.model.root);
    this.x = x;
    this.z = z;
    this.y = terrainHeight(x, z);
    this.heading = Math.random() * Math.PI * 2;
    this.speed = 0;
    this.maxSpeed = 3.4 + Math.random() * 1.5;
    this.alive = true;
    this.castingAtFly = false;
    this.spellCooldown = 2 + Math.random() * 2;
    this.gait = 0;
    this.pickWaypoint();
    this.model.root.position.set(x, this.y, z);
  }

  center(out = new THREE.Vector3()) {
    return out.set(this.x, this.y + 1.9, this.z);
  }

  velocity(out = new THREE.Vector3()) {
    return out.set(-Math.sin(this.heading) * this.speed, 0, -Math.cos(this.heading) * this.speed);
  }

  pickWaypoint() {
    if (this.home) {
      const a = Math.random() * Math.PI * 2;
      this.wp = { x: this.home.x + Math.cos(a) * this.home.r, z: this.home.z + Math.sin(a) * this.home.r };
      return;
    }
    for (let i = 0; i < 30; i++) {
      const x = (Math.random() * 2 - 1) * (PLAY_HALF - 30);
      const z = (Math.random() * 2 - 1) * (PLAY_HALF - 30);
      if (Math.hypot(x - START_FLOWER.x, z - START_FLOWER.z) < 65) continue;
      this.wp = { x, z };
      return;
    }
    this.wp = { x: 0, z: 0 };
  }

  update(dt, { effects, fly, audio, onFlySpark, magic = true }) {
    if (!this.alive) return;
    const dx = this.wp.x - this.x, dz = this.wp.z - this.z;
    if (Math.hypot(dx, dz) < 7) this.pickWaypoint();
    let sx = dx, sz = dz;
    const near = this.world.queryObstacles(this.x, this.z, 10, this._near || (this._near = []));
    for (const o of [...near, ...this.world.rocks]) {
      const ox = o.x - this.x, oz = o.z - this.z;
      const d = Math.hypot(ox, oz);
      const r = (o.trunkR ?? o.radius ?? 2) + 2;
      if (d > r + 5 || d < 0.01) continue;
      const push = ((r + 5 - d) / 5) ** 2 * 15;
      sx -= ox / d * push;
      sz -= oz / d * push;
    }
    const desired = Math.atan2(-sx, -sz);
    let turn = Math.atan2(Math.sin(desired - this.heading), Math.cos(desired - this.heading));
    this.heading += THREE.MathUtils.clamp(turn, -1.5 * dt, 1.5 * dt);
    const goalSpeed = this.maxSpeed * (1 - Math.min(0.7, Math.abs(turn) / 2));
    this.speed += THREE.MathUtils.clamp(goalSpeed - this.speed, -5 * dt, 5 * dt);
    const nx = this.x - Math.sin(this.heading) * this.speed * dt;
    const nz = this.z - Math.cos(this.heading) * this.speed * dt;
    const blocked = near.some((o) => Math.hypot(o.x - nx, o.z - nz) < (o.trunkR ?? 1) + 1.2);
    if (blocked || Math.abs(nx) > PLAY_HALF + 20 || Math.abs(nz) > PLAY_HALF + 20) {
      this.speed = 0;
      this.pickWaypoint();
    } else { this.x = nx; this.z = nz; }
    this.y = terrainHeight(this.x, this.z);
    this.model.root.position.set(this.x, this.y + Math.sin(this.gait) * 0.08, this.z);
    this.model.root.rotation.y = this.heading;
    this.gait += dt * this.speed * 2.5;
    this.model.arm.rotation.x = Math.sin(this.gait * 0.6) * 0.2;
    this.castingAtFly = false;
    if (!magic || !fly?.alive || fly.state !== "flying") return;
    const dist = fly.pos.distanceTo(this.center());
    if (dist > 75) return;
    this.castingAtFly = true;
    this.spellCooldown -= dt;
    if (this.spellCooldown > 0) return;
    this.spellCooldown = 1.4 + Math.random() * 1.5;
    const start = this.model.tip.getWorldPosition(new THREE.Vector3());
    const end = fly.pos.clone();
    end.x += (Math.random() - 0.5) * dist * 0.13;
    end.y += (Math.random() - 0.5) * dist * 0.1;
    effects.magicBolt(start, end);
    audio?.spell(start);
    if (end.distanceTo(fly.pos) < 1.5) onFlySpark?.(this, 12 + Math.random() * 8);
  }

  pop() {
    this.alive = false;
    this.speed = 0;
    this.scene.remove(this.model.root);
  }
}
