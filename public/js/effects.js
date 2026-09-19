// Billboard particle systems (instanced quads, so no point-size limits),
// colorful pops, sparkle spells and soft garden dust.
import * as THREE from "three";
import { terrainHeight } from "./terrain.js";

const VERT = /* glsl */ `
  attribute vec3 iOffset;
  attribute vec4 iColor;
  attribute vec2 iSizeRot;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vFog;
  varying float vNear;
  uniform float uFogNear;
  uniform float uFogFar;
  void main() {
    vUv = uv;
    vColor = iColor;
    vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
    float c = cos(iSizeRot.y), s = sin(iSizeRot.y);
    vec2 p = mat2(c, s, -s, c) * position.xy * iSizeRot.x;
    mv.xy += p;
    vFog = smoothstep(uFogNear, uFogFar, -mv.z);
    vNear = smoothstep(1.5, 10.0, -mv.z); // fade particles right in front of the lens
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uFogColor;
  uniform float uAdditive;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vFog;
  varying float vNear;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float a = t.a * vColor.a * vNear;
    if (a < 0.003) discard;
    vec3 col = vColor.rgb * t.rgb;
    if (uAdditive > 0.5) {
      gl_FragColor = vec4(col * a * 3.5 * (1.0 - vFog), 1.0); // HDR so bloom catches flames
    } else {
      gl_FragColor = vec4(mix(col, uFogColor, vFog), a);
    }
  }
`;

function makePuffTexture(soft) {
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d");
  if (soft) {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.8)");
    g.addColorStop(0.6, "rgba(255,255,255,0.22)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  } else {
    // lumpy smoke puff: overlapping soft blobs
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * s * 0.22;
      const x = s / 2 + Math.cos(a) * r;
      const y = s / 2 + Math.sin(a) * r;
      const rad = s * (0.14 + Math.random() * 0.16);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const v = 200 + Math.floor(Math.random() * 55);
      g.addColorStop(0, `rgba(${v},${v},${v},0.35)`);
      g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class ParticleSystem {
  constructor(scene, max, { additive, texture, fog }) {
    this.max = max;
    this.count = 0;
    const geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geo.index = quad.index;
    geo.setAttribute("position", quad.attributes.position);
    geo.setAttribute("uv", quad.attributes.uv);
    this.offset = new Float32Array(max * 3);
    this.color = new Float32Array(max * 4);
    this.sizeRot = new Float32Array(max * 2);
    this.aOffset = new THREE.InstancedBufferAttribute(this.offset, 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSizeRot = new THREE.InstancedBufferAttribute(this.sizeRot, 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("iOffset", this.aOffset);
    geo.setAttribute("iColor", this.aColor);
    geo.setAttribute("iSizeRot", this.aSizeRot);
    geo.instanceCount = 0;
    this.geo = geo;

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMap: { value: texture },
        uFogColor: { value: fog.color },
        uFogNear: { value: fog.near },
        uFogFar: { value: fog.far },
        uAdditive: { value: additive ? 1 : 0 },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 11 : 10;
    scene.add(this.mesh);

    // CPU-side simulation state
    this.p = [];
    for (let i = 0; i < max; i++) {
      this.p.push({
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1,
        s0: 1, s1: 1, rot: 0, vrot: 0, drag: 0, grav: 0,
        c0: new THREE.Color(), c1: new THREE.Color(), a0: 1, a1: 0, fadeIn: 0.05,
      });
    }
    this.alive = [];
    this.free = [...this.p];
  }

  emit(o) {
    const p = this.free.pop();
    if (!p) return;
    p.x = o.x; p.y = o.y; p.z = o.z;
    p.vx = o.vx || 0; p.vy = o.vy || 0; p.vz = o.vz || 0;
    p.life = 0;
    p.maxLife = o.life || 1;
    p.s0 = o.size0 ?? 1;
    p.s1 = o.size1 ?? p.s0;
    p.rot = Math.random() * 6.28;
    p.vrot = (Math.random() - 0.5) * (o.spin ?? 1);
    p.drag = o.drag ?? 0.5;
    p.grav = o.grav ?? 0;
    p.c0.set(o.color0 ?? 0xffffff);
    p.c1.set(o.color1 ?? o.color0 ?? 0xffffff);
    p.a0 = o.alpha0 ?? 1;
    p.a1 = o.alpha1 ?? 0;
    p.fadeIn = o.fadeIn ?? 0.05;
    this.alive.push(p);
  }

  update(dt) {
    const tmp = ParticleSystem._c || (ParticleSystem._c = new THREE.Color());
    let n = 0;
    for (let i = this.alive.length - 1; i >= 0; i--) {
      const p = this.alive[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        this.alive[i] = this.alive[this.alive.length - 1];
        this.alive.pop();
        this.free.push(p);
        continue;
      }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vy *= k; p.vz *= k;
      p.vy += p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.rot += p.vrot * dt;
    }
    for (const p of this.alive) {
      const t = p.life / p.maxLife;
      tmp.copy(p.c0).lerp(p.c1, t);
      const fade = Math.min(1, p.life / Math.max(0.001, p.fadeIn * p.maxLife));
      const a = (p.a0 + (p.a1 - p.a0) * t) * fade;
      this.offset[n * 3] = p.x;
      this.offset[n * 3 + 1] = p.y;
      this.offset[n * 3 + 2] = p.z;
      this.color[n * 4] = tmp.r;
      this.color[n * 4 + 1] = tmp.g;
      this.color[n * 4 + 2] = tmp.b;
      this.color[n * 4 + 3] = a;
      this.sizeRot[n * 2] = p.s0 + (p.s1 - p.s0) * Math.sqrt(t);
      this.sizeRot[n * 2 + 1] = p.rot;
      n++;
    }
    this.geo.instanceCount = n;
    this.aOffset.needsUpdate = this.aColor.needsUpdate = this.aSizeRot.needsUpdate = true;
    this.aOffset.clearUpdateRanges();
    this.aOffset.addUpdateRange(0, n * 3);
    this.aColor.clearUpdateRanges();
    this.aColor.addUpdateRange(0, n * 4);
    this.aSizeRot.clearUpdateRanges();
    this.aSizeRot.addUpdateRange(0, n * 2);
  }
}

const rnd = (a, b) => a + Math.random() * (b - a);

export class Effects {
  constructor(scene, fog) {
    const soft = makePuffTexture(true);
    const puff = makePuffTexture(false);
    this.sparkles = new ParticleSystem(scene, 2600, { additive: true, texture: soft, fog });
    this.puffs = new ParticleSystem(scene, 1200, { additive: false, texture: puff, fog });
    this.shake = 0;
    this.lights = [];
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffe77a, 0, 42, 1.5);
      scene.add(light);
      this.lights.push({ light, time: 0, duration: 1, peak: 0 });
    }
  }

  flash(pos, color = 0xffe77a, power = 420) {
    const item = this.lights.reduce((a, b) => a.time > b.time ? a : b);
    item.light.position.copy(pos);
    item.light.color.set(color);
    item.time = 0;
    item.duration = 0.6;
    item.peak = power;
  }

  pop(pos, scale = 1) {
    const colors = [0xffdc55, 0x82f47b, 0x62e8ff, 0xe696ff, 0xff9fc7];
    this.flash(pos, colors[Math.floor(Math.random() * colors.length)], 550 * scale);
    for (let i = 0; i < 90 * scale; i++) {
      const dir = new THREE.Vector3(rnd(-1, 1), rnd(-0.25, 1.2), rnd(-1, 1)).normalize();
      const speed = rnd(5, 22) * scale;
      const color = colors[i % colors.length];
      this.sparkles.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * speed, vy: dir.y * speed + 3, vz: dir.z * speed,
        life: rnd(0.45, 1.4), size0: rnd(0.25, 0.8) * scale, size1: 0.05,
        color0: color, color1: 0xffffff, alpha0: 1, alpha1: 0,
        drag: 1.7, grav: -5, spin: 4,
      });
    }
    for (let i = 0; i < 16 * scale; i++) {
      const dir = new THREE.Vector3(rnd(-1, 1), rnd(-0.2, 1), rnd(-1, 1)).normalize();
      this.puffs.emit({
        x: pos.x, y: pos.y, z: pos.z, vx: dir.x * 3, vy: dir.y * 3, vz: dir.z * 3,
        life: rnd(0.4, 0.8), size0: 0.8 * scale, size1: 3 * scale,
        color0: colors[i % colors.length], color1: 0xffffff,
        alpha0: 0.55, alpha1: 0, drag: 2,
      });
    }
  }

  magicBolt(from, to) {
    for (let i = 0; i < 18; i++) {
      const t = i / 17;
      this.sparkles.emit({
        x: THREE.MathUtils.lerp(from.x, to.x, t) + rnd(-0.4, 0.4),
        y: THREE.MathUtils.lerp(from.y, to.y, t) + Math.sin(t * Math.PI * 4) * 0.35,
        z: THREE.MathUtils.lerp(from.z, to.z, t) + rnd(-0.4, 0.4),
        life: rnd(0.16, 0.35), size0: rnd(0.35, 0.75), size1: 0.05,
        color0: i % 2 ? 0xffd55a : 0xd38cff, color1: 0xffffff,
        alpha0: 1, alpha1: 0, drag: 1,
      });
    }
    this.flash(from, 0xd38cff, 90);
  }

  dust(x, y, z, amount = 1) {
    this.puffs.emit({
      x: x + rnd(-0.5, 0.5), y, z: z + rnd(-0.5, 0.5),
      vx: rnd(-1, 1), vy: rnd(0.4, 1.4), vz: rnd(-1, 1),
      life: rnd(0.8, 1.5), size0: 0.8 * amount, size1: 2 * amount,
      color0: 0xc9e59c, color1: 0xe8f9c6,
      alpha0: 0.28, alpha1: 0, drag: 1.5, grav: 0.2,
    });
  }

  update(dt) {
    for (const item of this.lights) {
      if (item.time >= item.duration) { item.light.intensity = 0; continue; }
      item.time += dt;
      const fade = 1 - item.time / item.duration;
      item.light.intensity = item.peak * fade * fade;
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.sparkles.update(dt);
    this.puffs.update(dt);
  }
}
