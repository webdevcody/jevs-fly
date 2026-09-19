// FPV fantasy fly: model + physics + flight controller.
//
// The fantasy fly keeps an FPV style ANGLE mode flight response:
//   - wing power lifts along the body's UP axis,
//   - sticks map to attitude: pitch/roll stick -> target tilt angle (self-level),
//     yaw stick -> yaw rate with center / max / expo settings,
//   - the attitude loop is a P-controller on angle feeding a rate loop limited by
//     max rotation rate, with a small wing response lag,
//   - forward speed comes purely from tilting the thrust vector (nose down = go),
//   - quadratic air drag gives a terminal speed for each tilt angle.
// In a dive the controller switches to velocity hold: it thrust-vectors toward a commanded
// velocity (direction + speed chosen by the pilot), braking and pitching the nose hard down
// like an FPV dive. The flight controller also offers two assists Jev needs:
//   - vertical-speed hold (throttle is solved from the commanded climb rate and
//     the current tilt, the same idea as an altitude-hold / "air mode" assist),
//   - coordinated turns (auto-bank proportional to yaw rate x speed).
import * as THREE from "three";
import { terrainHeight } from "./terrain.js";

const G = 9.81;
const DEG = Math.PI / 180;

export const RATES = {
  yaw: { center: 70, max: 260, expo: 0.35 }, // deg/s, Betaflight "actual" rates
  maxAngle: 65, // deg, angle-mode tilt limit
  diveAngle: 90, // deg, nose-down limit in a dive: straight down at most, never inverted
  diveFlare: 25, // deg, most the nose comes back in a dive to bleed speed
  diveGain: 3, // 1/s, how fast the dive controller turns the flight path onto the dive line
  diveLineUp: 12, // deg, flight path this close to the dive line counts as on it (speed control starts)
  diveSpeedGain: 1.5, // 1/s, how hard the dive controller chases the commanded speed once on the line
  diveBrake: 4, // m/s², most braking along the flight path the dive controller asks for
  diveCut: 0.3, // g of wanted upward thrust below which the throttle fades to idle in a dive
  diveLook: 15, // deg, nose below the dive line while the throttle is off
  maxRate: 800, // deg/s attitude rate limit for pitch/roll
};

const TWR = 4.2; // thrust-to-weight ratio of a fantasy fly
// Quadratic drag (1/m) keeps quick FPV style turns and swoops.
const DRAG = 0.0064;

function actualRate(x, { center, max, expo }) {
  const ax = Math.abs(x);
  const curve = ax * (ax ** 5 * expo + ax * (1 - expo));
  return Math.sign(x) * (center * ax + (max - center) * curve);
}

export function buildFlyModel() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const lime = new THREE.MeshStandardMaterial({ color: 0x58c74c, roughness: 0.72 });
  const teal = new THREE.MeshStandardMaterial({ color: 0x168d99, roughness: 0.65 });
  const face = new THREE.MeshStandardMaterial({ color: 0x48a86a, roughness: 0.72 });
  const eye = new THREE.MeshStandardMaterial({ color: 0x221c58, roughness: 0.12, metalness: 0.1 });
  const shine = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const wingMat = new THREE.MeshBasicMaterial({ color: 0x8bcce3, transparent: true, opacity: 0.58, side: THREE.DoubleSide, depthWrite: false });
  const add = (geo, mat, x, y, z, parent = body) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = mat !== wingMat;
    parent.add(mesh);
    return mesh;
  };
  // Bright rounded silhouette: head faces -Z, abdomen trails behind.
  const abdomen = add(new THREE.SphereGeometry(0.45, 24, 16), lime, 0, -0.05, 0.35);
  abdomen.scale.set(0.82, 0.7, 1.35);
  add(new THREE.SphereGeometry(0.36, 24, 16), teal, 0, 0.02, -0.12);
  add(new THREE.SphereGeometry(0.38, 24, 16), face, 0, 0.08, -0.47);
  for (const side of [-1, 1]) {
    const e = add(new THREE.SphereGeometry(0.17, 16, 12), eye, side * 0.23, 0.2, -0.75);
    e.scale.set(1, 1.12, 0.52);
    add(new THREE.SphereGeometry(0.045, 10, 8), shine, side * 0.19, 0.26, -0.835);
    const feeler = add(new THREE.CylinderGeometry(0.018, 0.026, 0.32, 8), teal, side * 0.17, 0.52, -0.62);
    feeler.rotation.z = side * 0.38;
    add(new THREE.SphereGeometry(0.052, 10, 8), lime, side * 0.23, 0.68, -0.62);
    for (let i = 0; i < 3; i++) {
      const leg = add(new THREE.CylinderGeometry(0.018, 0.018, 0.58, 6), teal, side * (0.29 + i * 0.05), -0.34, -0.22 + i * 0.24);
      leg.rotation.z = side * (0.55 + i * 0.12);
    }
  }
  const wings = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.2, 0.28, 0.05);
    body.add(pivot);
    for (const offset of [-0.23, 0.2]) {
      const wing = add(new THREE.SphereGeometry(0.55, 20, 10), wingMat, side * 0.52, 0, offset, pivot);
      wing.scale.set(1.35, 0.045, 0.52);
      wing.rotation.y = side * (offset < 0 ? -0.3 : 0.35);
    }
    wings.push({ pivot, side });
  }
  // The camera sits between the eyes and keeps the existing FPV uptilt.
  const cam = new THREE.Group();
  cam.position.set(0, 0.14, -0.79);
  cam.rotation.x = 25 * DEG;
  body.add(cam);
  return { root, body, wings, camMount: cam };
}

export class Fly {
  constructor(scene, id, spawn) {
    this.id = id;
    this.scene = scene;
    const model = buildFlyModel();
    this.model = model;
    scene.add(model.root);

    this.pos = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
    this.vel = new THREE.Vector3();
    this.yaw = spawn.yaw ?? 0; // radians, 0 = facing -Z (north)
    this.pitch = 0; // + nose down
    this.roll = 0; // + right wing down
    this.pitchRate = 0;
    this.rollRate = 0;
    this.yawRate = 0;
    this.throttle = 0;
    this.wingPower = 0; // wing response lags throttle
    this.wingPhase = 0;
    this.nectar = 100;
    this.energy = 100;
    this.alive = true;
    this.state = "ready"; // ready -> flying -> popped
    this.wakeTimer = 1.4;
    this.flightTime = 0;
    
    this.quat = new THREE.Quaternion();
    this.euler = new THREE.Euler(0, 0, 0, "YXZ");
    this.up = new THREE.Vector3(0, 1, 0);
    this.forward = new THREE.Vector3(0, 0, -1);

    // Sticks as the pilot-bot is currently holding them (-1..1; throttle 0..1)
    this.sticks = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
    // Commands from the AI (set by the brain)
    this.cmd = { yaw: 0, pitch: 0, roll: 0, climb: 0, dive: false, velocity: null };
    this.syncModel();
  }

  get tiltDeg() {
    return Math.acos(THREE.MathUtils.clamp(this.up.y, -1, 1)) / DEG;
  }

  agl() {
    return this.pos.y - terrainHeight(this.pos.x, this.pos.z);
  }

  headingDeg() {
    // compass heading: 0 = north (-Z), 90 = east (+X)
    let h = (-this.yaw / DEG) % 360;
    if (h < 0) h += 360;
    return h;
  }

  update(dt) {
    if (!this.alive) return;
    if (this.state === "ready") {
      this.wakeTimer -= dt;
      this.wingPower = THREE.MathUtils.lerp(this.wingPower, 0.25, 1 - Math.exp(-dt * 3));
      this.sticks.throttle = this.wingPower;
      this.animateWings(dt);
      if (this.wakeTimer <= 0) this.state = "flying";
      this.syncModel();
      return;
    }
    this.flightTime += dt;

    // --- Pilot thumbs: slew sticks toward the commanded positions ---
    const slew = (cur, target, rate) => cur + THREE.MathUtils.clamp(target - cur, -rate * dt, rate * dt);
    const c = this.cmd;
    this.sticks.yaw = slew(this.sticks.yaw, c.yaw, 5);
    this.sticks.pitch = slew(this.sticks.pitch, c.pitch, 3.5);
    this.sticks.roll = slew(this.sticks.roll, c.roll, 4);

    // --- Angle mode attitude targets ---
    const speedH = Math.hypot(this.vel.x, this.vel.z);
    const maxAngle = (c.dive ? RATES.diveAngle : RATES.maxAngle) * DEG;
    // Velocity hold (dive mode): thrust-vector the commanded velocity. Tilt and throttle
    // follow from the thrust direction; the commanded velocity comes from the pilot.
    const vh = c.velocity ? this.velocityHold(c.velocity, maxAngle) : null;
    if (vh) {
      this.sticks.pitch = THREE.MathUtils.clamp(vh.pitch / maxAngle, -1, 1);
      this.sticks.roll = THREE.MathUtils.clamp(vh.roll / maxAngle, -1, 1);
    }
    const targetPitch = vh ? vh.pitch : this.sticks.pitch * maxAngle;
    const yawRateCmd = actualRate(this.sticks.yaw, RATES.yaw) * DEG;
    // coordinated turn: bank angle so the lift vector turns the velocity with the nose
    const coordBank = Math.atan((yawRateCmd * Math.max(speedH, 2)) / G);
    const targetRoll = vh ? vh.roll : THREE.MathUtils.clamp(this.sticks.roll * maxAngle * 0.6 + coordBank, -maxAngle, maxAngle);

    // P on angle -> rate (limited) -> first order rate response
    const maxRate = RATES.maxRate * DEG;
    const wantPitchRate = THREE.MathUtils.clamp((targetPitch - this.pitch) * 12, -maxRate, maxRate);
    const wantRollRate = THREE.MathUtils.clamp((targetRoll - this.roll) * 12, -maxRate, maxRate);
    const k = 1 - Math.exp(-dt / 0.035);
    this.pitchRate += (wantPitchRate - this.pitchRate) * k;
    this.rollRate += (wantRollRate - this.rollRate) * k;
    this.yawRate += (yawRateCmd - this.yawRate) * k;
    // The limits bound the targets above; the attitude itself swings back inside them at the
    // loop's own rate (no snap when a dive ends and the limit drops).
    const hardLimit = RATES.diveAngle * DEG;
    this.pitch = THREE.MathUtils.clamp(this.pitch + this.pitchRate * dt, -hardLimit, hardLimit);
    this.roll = THREE.MathUtils.clamp(this.roll + this.rollRate * dt, -hardLimit, hardLimit);
    this.yaw -= this.yawRate * dt; // positive yaw stick = turn right = clockwise from above

    this.euler.set(-this.pitch, this.yaw, -this.roll, "YXZ");
    this.quat.setFromEuler(this.euler);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.forward.set(0, 0, -1).applyQuaternion(this.quat);

    // --- Throttle: solved from the commanded climb rate and the current tilt ---
    const maxAccel = G * TWR;
    const vzErr = c.climb - this.vel.y;
    const dragV = DRAG * this.vel.y * Math.abs(this.vel.y);
    // 6/s: crisp enough to round out a descent a couple of meters over the ground, and about
    // critically damped with the wings' 50 ms lag.
    let throttle = vh ? vh.throttle : (G + vzErr * 6 + dragV) / Math.max(0.25, this.up.y) / maxAccel;
    if (this.energy <= 0) throttle = 0.08; // out of sparkle: wings slow down
    this.throttle = THREE.MathUtils.clamp(throttle, 0.02, 1);
    this.sticks.throttle = this.throttle;
    this.wingPower += (this.throttle - this.wingPower) * (1 - Math.exp(-dt / 0.05));

    // --- Integrate ---
    const thrust = this.wingPower * maxAccel;
    const acc = new THREE.Vector3().copy(this.up).multiplyScalar(thrust);
    acc.y -= G;
    const sp = this.vel.length();
    acc.addScaledVector(this.vel, -DRAG * sp);
    // Wing wash gives a little extra lift close to the ground.
    const agl = this.agl();
    if (agl < 2) acc.y += (2 - agl) * 1.5;
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);

    // Nectar drains with wing power.
    this.nectar = Math.max(0, this.nectar - dt * (0.25 + this.wingPower * 1.1));
    if (this.nectar <= 0) this.energy = 0;

    // A fly with no energy drifts and tumbles.
    if (this.energy <= 0) {
      this.roll += dt * 4;
      this.pitch += dt * 1.5;
    }

    this.animateWings(dt);
    this.syncModel();
  }

  // Thrust vector needed to drive the velocity toward `target` (world m/s), expressed as
  // pitch/roll in the heading frame plus throttle. Throttle is the wanted acceleration
  // projected onto the attitude it can actually reach, so a clamped attitude never pushes
  // the wrong way.
  velocityHold(target, limit) {
    // Direction first, like a pilot putting the flight path on the dive line: turn the
    // velocity toward the commanded direction at a rate proportional to the angle between them.
    const sp = this.vel.length(), spT = target.length();
    const vHat = sp > 2 ? this.vel.clone().divideScalar(sp) : target.clone().divideScalar(Math.max(spT, 0.1));
    const tHat = target.clone().divideScalar(Math.max(spT, 0.1));
    const err = Math.acos(THREE.MathUtils.clamp(vHat.dot(tHat), -1, 1));
    const acc = tHat.clone().addScaledVector(vHat, -vHat.dot(tHat));
    if (acc.lengthSq() > 1e-8) acc.setLength(RATES.diveGain * Math.max(sp, 8) * err);
    // Gravity and drag act on their own; thrust only has to supply the rest. Across the path
    // that's the turn above. Along the path the fly chases the commanded speed only once
    // it's on the line (a gentle flare at most), and until then just carries its speed.
    const natural = new THREE.Vector3(0, -G, 0).addScaledVector(this.vel, -DRAG * sp);
    acc.sub(natural.clone().addScaledVector(vHat, -natural.dot(vHat)));
    const onLine = 1 - THREE.MathUtils.smoothstep(err, 0, RATES.diveLineUp * DEG);
    const alongWant = THREE.MathUtils.clamp(RATES.diveSpeedGain * (spT - sp), -RATES.diveBrake, G * TWR);
    acc.addScaledVector(vHat, onLine * (alongWant - natural.dot(vHat)));
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const aF = acc.x * fx + acc.z * fz;
    const aR = acc.x * rx + acc.z * rz;
    // Wings only lift toward the fly's top, so bending the path down faster than gravity
    // does would mean flipping over. The fly stays upright: when gravity alone isn't
    // enough the nose just points down the dive line (banking toward the target if it's off
    // to the side), and the thrust direction takes over again, never pointing below the
    // horizon, once the path is on the line.
    const ay = Math.max(acc.y, 0.1 * G);
    const lim = RATES.maxAngle * DEG;
    const thrustPitch = THREE.MathUtils.clamp(Math.atan2(aF, ay), -RATES.diveFlare * DEG, limit);
    const thrustRoll = THREE.MathUtils.clamp(Math.atan2(aR, Math.hypot(aF, ay)), -lim, lim);
    const pathAngle = Math.atan2(-target.y, Math.hypot(target.x, target.z));
    const lookPitch = THREE.MathUtils.clamp(pathAngle + RATES.diveLook * DEG, 0, limit);
    const lookRoll = THREE.MathUtils.clamp(Math.atan2(aR, G), -lim, lim);
    const w = THREE.MathUtils.smoothstep(acc.y, 0, RATES.diveCut * G); // 0: gravity alone isn't enough
    const pitch = THREE.MathUtils.lerp(lookPitch, thrustPitch, w);
    const roll = THREE.MathUtils.lerp(lookRoll, thrustRoll, w);
    // body-up direction for that attitude, in (forward, right, up) components
    const upF = Math.sin(pitch) * Math.cos(roll), upR = Math.sin(roll), upY = Math.cos(pitch) * Math.cos(roll);
    const along = aF * upF + aR * upR + acc.y * upY;
    return { pitch, roll, throttle: THREE.MathUtils.clamp(along / (G * TWR), 0.02, 1) };
  }

  animateWings(dt) {
    this.wingPhase += dt * (35 + this.wingPower * 210);
    for (const { pivot, side } of this.model.wings) {
      pivot.rotation.z = side * (0.18 + Math.sin(this.wingPhase) * 0.35);
    }
  }

  syncModel() {
    this.model.root.position.copy(this.pos);
    this.euler.set(-this.pitch, this.yaw, -this.roll, "YXZ");
    this.model.body.quaternion.setFromEuler(this.euler);
  }

  pop() {
    this.alive = false;
    this.state = "popped";
    this.scene.remove(this.model.root);
  }
}
