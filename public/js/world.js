// Storybook garden: sky, lighting, terrain, forests, rocks and a starting flower.
import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mulberry32, createNoise2D } from "./noise.js";
import {
  terrainHeight, dirtAmount, PLAY_HALF, TERRAIN_SIZE, START_FLOWER, FLOWER_HEIGHT, MAP_SEED,
} from "./terrain.js";

// Sun in the south-west, behind the flower, giving the fly a warm backlight.
export const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(
  1, THREE.MathUtils.degToRad(90 - 30), THREE.MathUtils.degToRad(-35),
);
const SKY_GAIN = 0.38; // Preetham radiance is far brighter than our lit ground; keep them balanced

function dimSky(sky) {
  sky.material.fragmentShader = sky.material.fragmentShader.replace(
    "gl_FragColor = vec4( texColor, 1.0 );",
    `gl_FragColor = vec4( texColor * ${SKY_GAIN.toFixed(3)}, 1.0 );`,
  );
}
export const FOG_COLOR = new THREE.Color(0xaec3d3);

export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.trees = [];
    this.rocks = [];
    this.treeGrid = new Map();
    this.gridSize = 16;
    this.time = 0;

    this.buildSky();
    this.buildLights();
    this.buildTerrain();
    this.buildTrees();
    this.buildRocks();
    this.buildGrass();
    this.buildStartFlower();
  }

  buildSky() {
    const sky = new Sky();
    dimSky(sky);
    sky.scale.setScalar(2000);
    const u = sky.material.uniforms;
    u.turbidity.value = 4.5;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.86;
    u.sunPosition.value.copy(SUN_DIR);
    u.cloudCoverage.value = 0.42;
    u.cloudDensity.value = 0.55;
    u.cloudElevation.value = 0.55;
    u.cloudScale.value = 0.00022;
    u.cloudSpeed.value = 0.00003;
    this.sky = sky;
    this.scene.add(sky);

    // Image-based lighting from the same atmosphere so materials pick up sky tint.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envSky = new Sky();
    dimSky(envSky);
    envSky.scale.setScalar(1000);
    for (const k of Object.keys(u)) {
      if (envSky.material.uniforms[k] && k !== "sunPosition") envSky.material.uniforms[k].value = u[k].value;
    }
    envSky.material.uniforms.sunPosition.value.copy(SUN_DIR);
    envSky.material.uniforms.cloudCoverage.value = 0;
    envScene.add(envSky);
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environmentIntensity = 1.1;
    this.scene.fog = new THREE.Fog(FOG_COLOR, 170, 950);
  }

  buildLights() {
    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a5a32, 0.7);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff0d8, 4.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const s = sun.shadow.camera;
    s.left = -90; s.right = 90; s.top = 90; s.bottom = -90;
    s.near = 10; s.far = 600;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    sun.shadow.radius = 3;
    this.sun = sun;
    this.scene.add(sun);
    this.scene.add(sun.target);
  }

  // Keep the shadow frustum centred on whatever the camera is following.
  updateSun(focus) {
    const texel = 180 / 4096;
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + SUN_DIR.x * 300, focus.y + SUN_DIR.y * 300, fz + SUN_DIR.z * 300);
  }

  buildTerrain() {
    const seg = 320;
    const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const grassA = new THREE.Color(0x4f7a2c);
    const grassB = new THREE.Color(0x6f8f37);
    const grassC = new THREE.Color(0x3b6127);
    const dirt = new THREE.Color(0x8a6f4a);
    const rock = new THREE.Color(0x7d7a70);
    const snowish = new THREE.Color(0x9aa39a);
    const tmp = new THREE.Color();
    const detail = createNoise2D(MAP_SEED + 7);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = terrainHeight(x, z);
      pos.setY(i, h);
      const e = 1.5;
      const slope = Math.hypot(terrainHeight(x + e, z) - h, terrainHeight(x, z + e) - h) / e;
      const d = detail(x * 0.05, z * 0.05) * 0.5 + 0.5;
      tmp.copy(grassA).lerp(grassB, d);
      tmp.lerp(grassC, Math.max(0, detail(x * 0.013 + 40, z * 0.013) * 0.8));
      tmp.lerp(dirt, dirtAmount(x, z) * 0.55);
      tmp.lerp(rock, THREE.MathUtils.smoothstep(slope, 0.45, 0.9));
      tmp.lerp(snowish, THREE.MathUtils.smoothstep(h, 55, 90) * 0.6);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      map: makeGroundDetailTexture(),
    });
    mat.map.repeat.set(TERRAIN_SIZE / 6, TERRAIN_SIZE / 6);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.terrain = mesh;
    this.scene.add(mesh);
  }

  addToGrid(item) {
    const key = `${Math.floor(item.x / this.gridSize)},${Math.floor(item.z / this.gridSize)}`;
    if (!this.treeGrid.has(key)) this.treeGrid.set(key, []);
    this.treeGrid.get(key).push(item);
  }

  // Trees and rocks whose footprint could touch the circle (x, z, r).
  queryObstacles(x, z, r, out = []) {
    out.length = 0;
    const g = this.gridSize;
    const pad = 12;
    const x0 = Math.floor((x - r - pad) / g), x1 = Math.floor((x + r + pad) / g);
    const z0 = Math.floor((z - r - pad) / g), z1 = Math.floor((z + r + pad) / g);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const cell = this.treeGrid.get(`${gx},${gz}`);
        if (cell) for (const t of cell) out.push(t);
      }
    }
    return out;
  }

  buildTrees() {
    const rand = mulberry32(MAP_SEED + 10);
    const forest = createNoise2D(MAP_SEED + 11);
    const candidates = [];
    let attempts = 0;
    while (candidates.length < 560 && attempts < 40000) {
      attempts++;
      const x = (rand() * 2 - 1) * (PLAY_HALF + 60);
      const z = (rand() * 2 - 1) * (PLAY_HALF + 60);
      if (Math.hypot(x - START_FLOWER.x, z - START_FLOWER.z) < 45) continue;
      const density = forest(x * 0.009, z * 0.009) * 0.5 + 0.5;
      if (rand() > density * density * 1.25 + 0.03) continue;
      let ok = true;
      for (const c of candidates) {
        if ((c.x - x) ** 2 + (c.z - z) ** 2 < 5.5 * 5.5) { ok = false; break; }
      }
      if (!ok) continue;
      candidates.push({ x, z });
    }

    // Build instanced low-poly pines and broadleaf trees.
    const trunkGeo = new THREE.CylinderGeometry(0.22, 0.34, 1, 6).translate(0, 0.5, 0);
    const pineParts = [];
    for (let i = 0; i < 4; i++) {
      const r = 0.34 - i * 0.07;
      const h = 0.34;
      pineParts.push(new THREE.ConeGeometry(r, h, 7).translate(0, 0.3 + i * 0.17 + h / 2, 0));
    }
    const pineGeo = mergeGeometries(pineParts);
    const oakParts = [
      new THREE.IcosahedronGeometry(0.3, 1).translate(0, 0.62, 0),
      new THREE.IcosahedronGeometry(0.22, 1).translate(0.16, 0.74, 0.08),
      new THREE.IcosahedronGeometry(0.21, 1).translate(-0.15, 0.72, -0.1),
      new THREE.IcosahedronGeometry(0.2, 1).translate(0.02, 0.84, 0.14),
    ];
    const oakGeo = mergeGeometries(oakParts);

    const leafMat = new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true });
    addWindSway(leafMat, this);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4029, roughness: 1 });

    const pines = [], oaks = [];
    candidates.forEach((c, i) => {
      const isPine = rand() < 0.62;
      const height = isPine ? 11 + rand() * 13 : 8 + rand() * 7;
      const tree = {
        id: `tree_${i + 1}`,
        kind: isPine ? "pine" : "oak",
        x: c.x,
        z: c.z,
        y: terrainHeight(c.x, c.z) - 0.3,
        height,
        rot: rand() * Math.PI * 2,
        tint: rand(),
      };
      if (isPine) {
        tree.canopyBottom = height * 0.3;
        tree.canopyR = height * 0.3;
        tree.trunkR = 0.28 * (height / 16);
      } else {
        tree.canopyBottom = height * 0.38;
        tree.canopyR = height * 0.34;
        tree.canopyCenter = height * 0.68;
        tree.trunkR = 0.3 * (height / 12);
      }
      tree.radius = tree.canopyR; // footprint used by goblins and the AI
      this.trees.push(tree);
      this.addToGrid(tree);
      (isPine ? pines : oaks).push(tree);
    });

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const make = (list, canopyGeo, trunkScale, palette) => {
      const canopy = new THREE.InstancedMesh(canopyGeo, leafMat, list.length);
      const trunk = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
      list.forEach((t, i) => {
        dummy.position.set(t.x, t.y, t.z);
        dummy.rotation.set(0, t.rot, 0);
        dummy.scale.setScalar(t.height);
        dummy.updateMatrix();
        canopy.setMatrixAt(i, dummy.matrix);
        dummy.scale.set(t.height * trunkScale, t.height * (t.kind === "pine" ? 0.45 : 0.5), t.height * trunkScale);
        dummy.updateMatrix();
        trunk.setMatrixAt(i, dummy.matrix);
        color.set(palette[Math.floor(t.tint * palette.length)]);
        color.offsetHSL((t.tint - 0.5) * 0.03, 0, (t.tint - 0.5) * 0.08);
        canopy.setColorAt(i, color);
      });
      canopy.castShadow = canopy.receiveShadow = true;
      trunk.castShadow = trunk.receiveShadow = true;
      this.scene.add(canopy, trunk);
    };
    make(pines, pineGeo, 0.09, [0x2f5a2a, 0x2a4f2b, 0x3a6a30, 0x264a27]);
    make(oaks, oakGeo, 0.12, [0x5d8a32, 0x6f9a3a, 0x4f7c2e, 0x7c8f36]);
  }

  buildRocks() {
    const rand = mulberry32(MAP_SEED + 20);
    const geo = new THREE.DodecahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a867c, roughness: 0.9, flatShading: true });
    const count = 140;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      let x, z;
      do {
        x = (rand() * 2 - 1) * PLAY_HALF;
        z = (rand() * 2 - 1) * PLAY_HALF;
      } while (Math.hypot(x - START_FLOWER.x, z - START_FLOWER.z) < 40);
      const s = 0.5 + rand() ** 2 * 2.6;
      dummy.position.set(x, terrainHeight(x, z) + s * 0.15, z);
      dummy.rotation.set(rand() * 3, rand() * 3, rand() * 3);
      dummy.scale.set(s * (0.8 + rand() * 0.6), s * (0.5 + rand() * 0.4), s * (0.8 + rand() * 0.6));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      if (s > 1.6) this.rocks.push({ x, z, radius: s });
    }
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  buildGrass() {
    const rand = mulberry32(MAP_SEED + 30);
    const blade = new THREE.ConeGeometry(0.09, 0.8, 3).translate(0, 0.4, 0);
    const clump = mergeGeometries([
      blade.clone().rotateZ(0.25),
      blade.clone().rotateZ(-0.3).translate(0.1, 0, 0.05),
      blade.clone().rotateX(0.3).translate(-0.05, 0, 0.1),
      blade.clone().rotateX(-0.2).translate(0.02, 0, -0.1),
    ]);
    const mat = new THREE.MeshStandardMaterial({ color: 0x6a9a35, roughness: 1 });
    const count = 9000;
    const mesh = new THREE.InstancedMesh(clump, mat, count);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const x = (rand() * 2 - 1) * (PLAY_HALF + 20);
      const z = (rand() * 2 - 1) * (PLAY_HALF + 20);
      dummy.position.set(x, terrainHeight(x, z) - 0.05, z);
      dummy.rotation.set(0, rand() * 6.28, 0);
      dummy.scale.setScalar(0.7 + rand() * 1.1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      color.setHSL(0.22 + rand() * 0.06, 0.5, 0.28 + rand() * 0.12);
      mesh.setColorAt(i, color);
    }
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  buildStartFlower() {
    const flower = new THREE.Group();
    flower.position.set(START_FLOWER.x, FLOWER_HEIGHT, START_FLOWER.z);
    const leaf = new THREE.MeshStandardMaterial({ color: 0x409e67, roughness: 0.8 });
    const petalMats = [0xcd6fa9, 0x9e73c7, 0xd6a45c, 0x62b9b2].map((color) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.65, side: THREE.DoubleSide }));
    const centerMat = new THREE.MeshStandardMaterial({ color: 0xb29148, roughness: 0.85, emissive: 0x4b3414, emissiveIntensity: 0.1 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(7.3, 7.7, 0.42, 32), leaf);
    base.position.y = 0.15;
    base.receiveShadow = true;
    flower.add(base);
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      const petal = new THREE.Mesh(new THREE.SphereGeometry(3.3, 20, 10), petalMats[i % petalMats.length]);
      petal.position.set(Math.cos(a) * 6.3, 0.35, Math.sin(a) * 6.3);
      petal.scale.set(1.4, 0.12, 0.74);
      petal.rotation.y = -a;
      petal.castShadow = true;
      flower.add(petal);
    }
    const disk = new THREE.Mesh(new THREE.CylinderGeometry(5.1, 5.1, 0.35, 32), centerMat);
    disk.position.y = 0.39;
    disk.receiveShadow = true;
    flower.add(disk);
    this.flowerGlow = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff0a0 }));
    this.flowerGlow.position.set(0, 0.64, 0);
    flower.add(this.flowerGlow);
    // Oversized mushrooms ring the starting flower for a storybook silhouette.
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x9f8d7c, roughness: 0.8 });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xa35eb1, roughness: 0.65 });
    for (let i = 0; i < 18; i++) {
      const a = i * Math.PI * 2 / 18;
      const r = 13 + (i % 3) * 2;
      const h = 1.5 + (i % 4) * 0.35;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.4, h, 10), stemMat);
      stem.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      flower.add(stem);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8), capMat);
      cap.scale.set(1, 0.5, 1);
      cap.position.set(stem.position.x, h, stem.position.z);
      flower.add(cap);
    }
    this.scene.add(flower);
  }

  update(dt) {
    this.time += dt;
    this.sky.material.uniforms.time.value = this.time;
    if (this.windUniform) this.windUniform.value = this.time;
    this.flowerGlow.scale.setScalar(0.9 + Math.sin(this.time * 3) * 0.1);
  }
}

// Gentle canopy sway injected into the standard material's vertex stage.
function addWindSway(material, world) {
  world.windUniform = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWind = world.windUniform;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uWind;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = instanceMatrix[3].xyz;
          float sway = sin(uWind * 1.3 + ip.x * 0.11 + ip.z * 0.07) * 0.025 * position.y;
          transformed.x += sway;
          transformed.z += sway * 0.6;
        #endif`,
      );
  };
}

function makeGroundDetailTexture() {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const rand = mulberry32(99);
  for (let i = 0; i < size * size; i++) {
    const v = 200 + rand() * 55;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // a few darker speckles/pebbles
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(60,50,30,${0.08 + rand() * 0.15})`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, 0.5 + rand() * 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
