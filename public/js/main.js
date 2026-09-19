import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { World, FOG_COLOR } from "./world.js";
import { Effects } from "./effects.js";
import { Fly } from "./fly.js";
import { Goblin } from "./goblin.js";
import { AudioEngine } from "./audio.js";
import { HUD } from "./hud.js";
import { JevPilot, treeRadiusAt } from "./ai.js";
import { terrainHeight, PLAY_HALF, START_FLOWER, FLOWER_HEIGHT } from "./terrain.js";

const params = new URLSearchParams(location.search);
// One fly against one goblin. ?dist=120 fixes the starting distance;
// &magic=0 turns off the goblin's sparkle spells.
const FIXED_DIST = params.has("dist") ? Number(params.get("dist")) : null;
const GOBLIN_MAGIC = params.get("magic") !== "0";

// --- renderer / scene --------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: params.has("capture") });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById("app").appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.1, 3000);
camera.position.set(START_FLOWER.x, FLOWER_HEIGHT + 4, START_FLOWER.z + 8);

const world = new World(scene, renderer);
const effects = new Effects(scene, { color: FOG_COLOR, near: scene.fog.near, far: scene.fog.far });
const audio = new AudioEngine();
const hud = new HUD();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.45, 0.5, 2.6);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const fpvCam = new THREE.PerspectiveCamera(92, 16 / 9, 0.05, 1500);

// --- game state -------------------------------------------------------------------
const game = {
  fly: null,
  flyNum: 0,
  goblin: null,
  goblinNum: 0,
  pops: 0,
  resets: 0,
  timers: [],
  popCam: null,
  started: false,
  paused: false,
  events: [],
  slowmo: 0,
};
window.game = game;
game.three = { renderer, scene, camera, THREE };
game.audio = audio;

const pilot = new JevPilot({
  world,
  getFly: () => game.fly,
  getGoblin: () => game.goblin,
  hud,
});
game.pilot = pilot;

function later(sec, fn) {
  game.timers.push({ t: sec, fn });
}

// Somewhere in the garden, well away from the flower and clear of trees.
function goblinSpot() {
  for (let i = 0; i < 60; i++) {
    let x, z;
    if (FIXED_DIST) {
      const a = (Math.random() - 0.5) * 1.2; // within ~35° of north of the pad
      x = START_FLOWER.x + Math.sin(a) * FIXED_DIST;
      z = START_FLOWER.z - Math.cos(a) * FIXED_DIST;
    } else {
      x = (Math.random() * 2 - 1) * (PLAY_HALF - 40);
      z = -PLAY_HALF + 40 + Math.random() * (PLAY_HALF * 1.45);
      if (Math.hypot(x - START_FLOWER.x, z - START_FLOWER.z) < 110) continue;
    }
    if (world.queryObstacles(x, z, 8, []).some((t) => Math.hypot(t.x - x, t.z - z) < 7)) continue;
    return { x, z };
  }
  return { x: START_FLOWER.x, z: START_FLOWER.z - (FIXED_DIST || 150) };
}

function spawnGoblin() {
  const p = goblinSpot();
  const t = new Goblin(scene, world, ++game.goblinNum, p.x, p.z);
  if (FIXED_DIST) {
    t.home = { x: p.x, z: p.z, r: 30 }; // wander near its spawn point
    t.pickWaypoint();
  }
  game.goblin = t;
  return t;
}

// Clear the old goblin before the next round.
function clearGoblin() {
  const old = game.goblin;
  if (!old) return;
  scene.remove(old.model.root);
  game.goblin = null;
}

function spawnFly() {
  game.flyNum++;
  const d = new Fly(scene, game.flyNum, {
    x: START_FLOWER.x, y: FLOWER_HEIGHT + 1.5, z: START_FLOWER.z, yaw: 0,
  });
  game.fly = d;
  pilot.reset();
  game.popCam = null;
  hud.banner(`FLY #${game.flyNum} TAKING OFF`, "Jev guides the wings");
  audio.blip(660, 0.12);
  later(0.18, () => audio.blip(880, 0.12));
  later(0.36, () => audio.blip(1320, 0.2));
  snapCamera();
}

function popFly(cause, big = false) {
  const d = game.fly;
  if (!d || !d.alive) return;
  const pos = d.pos.clone();
  effects.pop(pos, big ? 1.5 : 0.7);
  effects.shake = big ? 1.2 : 0.7;
  audio.pop(pos, big);
  d.pop();
  game.popCam = { pos, t: 0 };
  const tk = game.goblin;
  game.events.push({
    t: Math.round(performance.now() / 1000), fly: d.id, cause, flight: Math.round(d.flightTime),
    branch: pilot.plan?.branch, dive: d.cmd.dive, speed: Math.round(d.vel.length()), vy: Math.round(d.vel.y),
    goblinDist: tk ? Math.round(tk.center(new THREE.Vector3()).distanceTo(d.pos)) : null,
  });
  if (cause === "goblin") return; // popGoblin() starts the next round
  game.resets++;
  hud.toast(`FLY #${d.id} POPPED — ${cause}`, "bad");
  later(2.6, spawnFly);
}

function popGoblin(goblin) {
  const c = goblin.center(new THREE.Vector3());
  goblin.pop();
  effects.pop(c, 1.6);
  effects.shake = 1.4;
  audio.pop(c, true);
  game.pops++;
  game.events.push({ t: Math.round(performance.now() / 1000), pop: goblin.id });
  hud.toast(`${goblin.label} POPPED!`, "good");
  hud.banner("GOBLIN POP!", `Fly #${game.fly?.id} made a splash`);
  // Brief slow motion for the pop, then a fresh goblin and fly.
  game.slowmo = 1.1;
  later(3.2, () => {
    clearGoblin();
    const t = spawnGoblin();
    hud.toast(`NEW GOBLIN — ${t.label}`, "info");
    spawnFly();
  });
}

// --- collisions ---------------------------------------------------------------------
const _near = [];
function checkCollisions() {
  const d = game.fly;
  if (!d || !d.alive || d.state !== "flying") return;
  const p = d.pos;

  // A glowing fly pops a goblin when they meet.
  const goblin = game.goblin;
  if (goblin?.alive && d.energy > 0 && goblin.center(new THREE.Vector3()).distanceTo(p) < 4) {
    popGoblin(goblin);
    popFly("goblin", true);
    return;
  }
  // trees
  for (const t of world.queryObstacles(p.x, p.z, 4, _near)) {
    const r = treeRadiusAt(t, p.y);
    if (r > 0 && Math.hypot(t.x - p.x, t.z - p.z) < r + 0.3) {
      popFly(`BUMPED A ${t.kind.toUpperCase()} TREE (${t.id})`);
      return;
    }
  }
  // ground
  const gh = terrainHeight(p.x, p.z);
  if (p.y < gh + 0.25) {
    const impact = d.vel.length();
    if (d.energy <= 0) return popFly(d.nectar <= 0 ? "OUT OF NECTAR" : "SPARKLE OVERLOAD");
    // A close landing beside the goblin also counts.
    if (goblin?.alive && Math.hypot(goblin.x - p.x, goblin.z - p.z) < 4) {
      popGoblin(goblin);
      return popFly("goblin", true);
    }
    if (impact > 6 || d.tiltDeg > 50) return popFly("BOUNCED OFF THE GROUND");
    p.y = gh + 0.25;
    d.vel.multiplyScalar(0.2);
    d.vel.y = Math.max(0, d.vel.y);
  }
  if (Math.abs(p.x) > PLAY_HALF + 140 || Math.abs(p.z) > PLAY_HALF + 140) popFly("SIGNAL LOST (OUT OF RANGE)");
  if (p.y > 220) popFly("SIGNAL LOST (TOO HIGH)");
}

function onFlySpark(goblin, amount) {
  const d = game.fly;
  if (!d || !d.alive) return;
  const wasAlive = d.energy > 0;
  d.energy = Math.max(0, d.energy - amount);
  audio.sparkle();
  effects.sparkles.emit({ x: d.pos.x, y: d.pos.y, z: d.pos.z, life: 0.15, size0: 0.8, size1: 0.2, color0: 0xffffff, color1: 0xffaa33 });
  if (wasAlive && d.energy <= 0) {
    hud.toast(`FLY #${d.id} POPPED BY ${goblin.label}'S MAGIC`, "bad");
  }
}

// --- camera -------------------------------------------------------------------------
const cam = { yaw: 0, pos: new THREE.Vector3(), look: new THREE.Vector3(), lift: 0 };
const _camNear = [];

// Extra height needed so the sightline camera -> fly clears every tree canopy.
function occlusionLift(from, to) {
  const mx = (from.x + to.x) / 2, mz = (from.z + to.z) / 2;
  const trees = world.queryObstacles(mx, mz, from.distanceTo(to) / 2 + 2, _camNear);
  let lift = 0;
  for (let k = 0; k < 6; k++) {
    const f = k / 6; // stop short of the fly itself
    const px = from.x + (to.x - from.x) * f, pz = from.z + (to.z - from.z) * f;
    const py = from.y + (to.y - from.y) * f;
    for (const t of trees) {
      if (treeRadiusAt(t, py) <= 0) continue;
      const d = Math.hypot(t.x - px, t.z - pz);
      if (d < treeRadiusAt(t, py) + 0.8) lift = Math.max(lift, (t.y + t.height + 1.5 - py) / Math.max(0.15, 1 - f));
    }
  }
  return Math.min(lift, 9);
}
function desiredCam(d, outPos, outLook) {
  const fwd = new THREE.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
  const dive = d.cmd.dive ? 1 : 0;
  outPos.copy(d.pos).addScaledVector(fwd, -4.3 - dive * 1.5).add(new THREE.Vector3(0, 1.45 + dive * 1.2, 0));
  outLook.copy(d.pos).addScaledVector(fwd, 7).add(new THREE.Vector3(0, 0.2 - dive * 2.5, 0));
}
function snapCamera() {
  const d = game.fly;
  if (!d) return;
  cam.yaw = d.yaw;
  desiredCam(d, cam.pos, cam.look);
}
function updateCamera(dt) {
  const d = game.fly;
  if (!game.started) {
    // slow cinematic orbit behind the intro card
    const t = performance.now() / 1000;
    cam.pos.set(START_FLOWER.x + Math.sin(t * 0.05) * 60, FLOWER_HEIGHT + 30, START_FLOWER.z - 40 + Math.cos(t * 0.05) * 60);
    cam.look.set(0, 12, 20);
  } else if (game.popCam) {
    // Pull back to watch the sparkle cloud fade.
    const dc = game.popCam;
    dc.t += dt;
    if (!dc.away) {
      dc.away = new THREE.Vector3().subVectors(cam.pos, dc.pos).setY(0);
      if (dc.away.lengthSq() < 0.01) dc.away.set(0, 0, 1);
      dc.away.normalize();
    }
    const want = dc.pos.clone().addScaledVector(dc.away, 26).add(new THREE.Vector3(0, 11, 0));
    cam.pos.lerp(want, 1 - Math.exp(-dt * 2.2));
    cam.look.lerp(dc.pos.clone().add(new THREE.Vector3(0, 2, 0)), 1 - Math.exp(-dt * 4));
  } else if (d) {
    let dy = d.yaw - cam.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    cam.yaw += dy * (1 - Math.exp(-dt * 7));
    const p = new THREE.Vector3(), l = new THREE.Vector3();
    desiredCam(d, p, l);
    // rise over canopies that would hide the fly (eases in fast, drifts back down slowly)
    const want = occlusionLift(p, d.pos);
    cam.lift += (want - cam.lift) * (1 - Math.exp(-dt * (want > cam.lift ? 8 : 1.5)));
    p.y += cam.lift;
    cam.pos.lerp(p, 1 - Math.exp(-dt * 12));
    cam.look.lerp(l, 1 - Math.exp(-dt * 14));
  }
  const floor = terrainHeight(cam.pos.x, cam.pos.z) + 1.2;
  if (cam.pos.y < floor) cam.pos.y = floor;
  camera.position.copy(cam.pos);
  if (effects.shake > 0) {
    const s = effects.shake * effects.shake * 0.35;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
  }
  camera.lookAt(cam.look);
}

// --- main loop ----------------------------------------------------------------------
const clock = new THREE.Clock();
let hudTimer = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (game.slowmo > 0) game.slowmo -= dt;
  const simDt = game.paused ? 0 : game.slowmo > 0 ? dt * 0.3 : dt;

  for (let i = game.timers.length - 1; i >= 0; i--) {
    game.timers[i].t -= simDt;
    if (game.timers[i].t <= 0) {
      const { fn } = game.timers[i];
      game.timers.splice(i, 1);
      fn();
    }
  }

  const d = game.fly;
  if (simDt > 0) {
    if (d && d.alive) {
      if (d.state === "flying") pilot.fly(d);
      d.update(simDt);
      // Wing wash stirs up soft garden dust near the ground.
      const agl = d.agl();
      if (agl < 6 && Math.random() < simDt * 25 * (1 - agl / 6) * d.wingPower * 2) {
        effects.dust(d.pos.x, terrainHeight(d.pos.x, d.pos.z) + 0.2, d.pos.z, 0.5);
      }
      // A tired fly leaves a few glowing motes.
      if (d.energy < 60 && Math.random() < simDt * 12) {
        effects.puffs.emit({
          x: d.pos.x, y: d.pos.y, z: d.pos.z, life: 0.7, size0: 0.2, size1: 0.8,
          color0: 0xa8f0f4, color1: 0xffffff, alpha0: 0.45, alpha1: 0,
        });
      }
      checkCollisions();
    }
    game.goblin?.update(simDt, { effects, fly: game.fly, audio, onFlySpark, magic: GOBLIN_MAGIC });
    world.update(simDt);
    effects.update(simDt, camera);
  }

  updateCamera(dt);
  world.updateSun(game.fly?.alive ? game.fly.pos : cam.look);
  audio.update(dt, { camera, fly: game.fly, goblin: game.goblin });

  // HUD (throttled DOM work)
  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = 1 / 30;
    hud.updateFlight(game.fly, pilot);
    const dd = game.fly;
    hud.setStandby(
      !game.started ? null
        : !dd || !dd.alive ? `FLY POPPED<small>another fly is ready at the flower…</small>`
          : dd.state === "ready" ? `FLY #${dd.id} WAKING UP<small>wings warming · Jev link standing by</small>` : null,
    );
    hud.updateReticle(camera, game.goblin, game.fly?.alive ? game.fly.pos : camera.position);
    hud.drawMinimap(world, game.goblin, game.fly);
    hud.updateScore({ pops: game.pops, resets: game.resets, flyNum: game.flyNum });
  }

  // main view
  renderer.shadowMap.needsUpdate = true;
  renderer.setScissorTest(false);
  composer.render();

  // FPV picture-in-picture from the fly's own camera
  const pip = document.getElementById("fpv");
  if (d && d.alive && pip.offsetParent !== null) {
    const r = pip.getBoundingClientRect();
    const y = window.innerHeight - r.bottom;
    d.model.camMount.updateWorldMatrix(true, false);
    fpvCam.position.set(0, 0, -0.1);
    fpvCam.quaternion.identity();
    if (fpvCam.parent !== d.model.camMount) d.model.camMount.add(fpvCam);
    fpvCam.aspect = r.width / r.height;
    fpvCam.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = false;
    renderer.setScissorTest(true);
    renderer.setViewport(r.left, y, r.width, r.height);
    renderer.setScissor(r.left, y, r.width, r.height);
    renderer.render(scene, fpvCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
  }
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "p" || e.key === "P") {
    game.paused = !game.paused;
    pilot.setPaused(game.paused);
    hud.banner(game.paused ? "PAUSED" : "RESUMED");
  }
  if (e.key === "m" || e.key === "M") {
    if (audio.master) audio.master.gain.value = audio.master.gain.value > 0 ? 0 : 0.7;
  }
  if (e.key === "h" || e.key === "H") document.body.classList.toggle("hide-hud");
});

function start() {
  if (game.started) return;
  game.started = true;
  document.getElementById("intro").classList.add("gone");
  try { audio.start(); } catch (err) { console.warn("audio unavailable", err); }
  spawnFly();
  pilot.start();
}

// Put the goblin out immediately so the intro screen has a live backdrop.
spawnGoblin();
fetch("/api/stats").then((r) => r.json()).then((s) => {
  pilot.requestModel = s.model;
  if (!s.hasKey) hud.showError("Server has no TYPESAFE_API_KEY");
}).catch(() => {});

document.getElementById("deploy").addEventListener("click", start);
if (params.has("autostart")) start();
else {
  // idle orbit behind the intro card
  cam.pos.set(START_FLOWER.x + 30, FLOWER_HEIGHT + 22, START_FLOWER.z + 30);
  cam.look.set(0, 10, 60);
}
frame();
