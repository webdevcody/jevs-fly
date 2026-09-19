// Jev pilots a fantasy fly around a wandering goblin.
//
// Jev only sees what an FPV pilot sees in the goggles: where the goblin sits in the view, as
// degrees left/right of the nose and degrees below the horizon. That's the whole state.
// Both numbers point at where the goblin will be when the fly gets there, so a moving goblin
// doesn't pull the dive behind it.
//
// Jev answers two questions in one call, about 5 times a second:
//   turn  which way to yaw toward the goblin
//   dive  keep cruising toward it, or dive into it now and how steeply
//
// The flight controller does the rest without Jev: angle-mode stabilization, a fixed cruise
// speed, altitude hold at cruise height over the ground and treetops ahead (like a real FC's
// rangefinder alt-hold), and a braking hover if answers stop. It never reads the goblin's
// position: which way to head and when and how steeply to dive come only from Jev.
// A response with any missing or invalid answer is rejected whole.
import * as THREE from "three";
import { terrainHeight } from "./terrain.js";

const DEG = Math.PI / 180;
const MIN_INTERVAL_MS = 140; // ~5 decisions/second
const FAILSAFE_MS = 1500;

// Flight controller settings (the only things the fly does on its own).
const CRUISE_TILT = 0.35; // forward stick while cruising, ~25 m/s
const CRUISE_AGL = 30; // m above the ground
const TREE_CLEARANCE = 7; // m above any treetop in the corridor ahead
const LOOKAHEAD_S = 2.5; // how far ahead alt-hold looks, in seconds of flight
const DIVE_SPEED = 32; // m/s along the dive path

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const r0 = (v) => Math.round(v);

// Plain description of a relative bearing: a number and a side.
export function bearingText(rel) {
  const a = r0(Math.abs(rel));
  if (a === 0) return "0°";
  return `${a}° ${rel < 0 ? "left" : "right"}`;
}

// Radius of a tree's silhouette at a given world height (0 when above it).
export function treeRadiusAt(t, y) {
  const dy = y - t.y;
  if (dy < 0 || dy > t.height) return 0;
  if (t.kind === "pine") {
    if (dy < t.canopyBottom) return t.trunkR;
    return t.canopyR * (1 - (dy - t.canopyBottom) / (t.height - t.canopyBottom));
  }
  const cc = t.canopyCenter;
  const d = Math.abs(dy - cc);
  if (d < t.canopyR) return Math.sqrt(t.canopyR * t.canopyR - d * d);
  return dy < cc ? t.trunkR : 0;
}

// The two questions. They never change, only the state does.
const side = (dir) => ({
  [`hard_${dir}`]: `The goblin is more than 60° to the ${dir}.`,
  [dir]: `The goblin is 25° to 60° to the ${dir}.`,
  [`slight_${dir}`]: `The goblin is 10° to 25° to the ${dir}.`,
  [`nudge_${dir}`]: `The goblin is 3° to 10° to the ${dir}.`,
});
export const QUESTIONS = {
  turn: {
    type: "choice",
    instructions: "Which way should the fly turn to point its nose at the goblin? Use `goblin.bearing`.",
    criteria: { ...side("left"), straight: "The goblin is within 3° of the nose.", ...side("right") },
  },
  dive: {
    type: "choice",
    instructions:
      "The fly makes the goblin pop into colorful sparkles by swooping close. Should it dive now, and how steeply? " +
      "Use `goblin.below_horizon_deg` and `goblin.bearing`.",
    criteria: {
      not_yet: "Keep flying toward it: the goblin is less than 25° below the horizon, or it is more than 40° left or right (unless it is more than 80° below).",
      d30: "Dive at 30°: the goblin is 25° to 38° below the horizon and within 40° of the nose.",
      d45: "Dive at 45°: the goblin is 38° to 52° below the horizon and within 40° of the nose.",
      d60: "Dive at 60°: the goblin is 52° to 66° below the horizon and within 40° of the nose.",
      d75: "Dive at 75°: the goblin is 66° to 80° below the horizon and within 40° of the nose.",
      d90: "Dive straight down: the goblin is more than 80° below the horizon, whatever its bearing.",
    },
  },
};

// A response is only flown if every question has a valid typed answer.
function validateAnswers(answers) {
  for (const [id, q] of Object.entries(QUESTIONS)) {
    const a = answers?.[id];
    if (!a) return `missing answer: ${id}`;
    if (!Object.hasOwn(q.criteria, a.choice)) return `invalid choice for ${id}: ${a.choice}`;
  }
  return null;
}

// Option -> command tables. Yaw is a heading change relative to the heading when the state
// was captured, so it still means the same thing when it lands ~250 ms later.
const YAW_DELTA = {
  hard_left: -85, left: -40, slight_left: -17, nudge_left: -6, straight: 0,
  nudge_right: 6, slight_right: 17, right: 40, hard_right: 85,
};
// Flight-path angle below the horizon for each dive. The shallowest dive flies the bottom of
// its range, so the goblin only climbs higher in the view and a dive never shallows back out
// into a pull-out; the rest fly the middle of their range.
const DIVE_ANGLE = { d30: 26, d45: 45, d60: 59, d75: 73, d90: 88 };

export class JevPilot {
  constructor({ world, getFly, getGoblin, hud }) {
    this.world = world;
    this.getFly = getFly;
    this.getGoblin = getGoblin;
    this.hud = hud;
    this.running = false;
    this.paused = false;
    this.lastDecisionAt = 0;
    this.stats = { calls: 0, errors: 0, tokens: 0, latencies: [], times: [], started: performance.now() };
    this.plan = null; // what the flight controller executes between decisions
    this.requestModel = null; // the model id server.js forwards upstream (from /api/stats)
    this._near = [];
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  setPaused(p) {
    this.paused = p;
  }

  // New fly: forget the old plan.
  reset() {
    this.plan = null;
    this.lastDecisionAt = 0;
  }

  planIsLive() {
    return !!this.plan && performance.now() - this.lastDecisionAt <= FAILSAFE_MS;
  }

  // --- the entire world model Jev sees ------------------------------------------------
  buildState(fly, goblin) {
    const heading = fly.headingDeg();
    // Where the goblin will be when the fly gets there (time to go at the fly's speed).
    const tv = goblin.velocity(new THREE.Vector3());
    const c = goblin.center(new THREE.Vector3());
    const tgo = c.distanceTo(fly.pos) / Math.max(fly.vel.length(), 18);
    const ax = c.x + tv.x * tgo, az = c.z + tv.z * tgo;
    const dx = ax - fly.pos.x, dz = az - fly.pos.z;
    const bearing = wrap180((Math.atan2(dx, -dz) / DEG) - heading);
    const below = Math.atan2(fly.pos.y - c.y, Math.max(Math.hypot(dx, dz), 0.1)) / DEG;
    const state = { goblin: { bearing: bearingText(bearing), below_horizon_deg: r0(below) } };
    return { state, heading };
  }

  // --- Jev's two answers -> a plan for the flight controller -----------------------------
  decide(answers) {
    const turn = answers.turn.choice, dive = answers.dive.choice;
    const diving = dive !== "not_yet";
    return {
      branch: diving ? "DIVE" : "CRUISE",
      yawDelta: YAW_DELTA[turn],
      dive: diving,
      diveAngle: diving ? DIVE_ANGLE[dive] : null,
      turn,
      diveChoice: dive,
    };
  }

  async loop() {
    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        // Keep the pilot loop running after a bad response; hover covers the gap.
        console.error("pilot tick failed", err);
        this.stats.errors++;
        this.hud.showError(String(err.message || err));
        await sleep(300);
      }
    }
  }

  async tick() {
    const fly = this.getFly();
    const goblin = this.getGoblin();
    if (this.paused || document.hidden || !fly || !fly.alive || fly.state !== "flying" || !goblin?.alive) {
      await sleep(120);
      return;
    }
    const t0 = performance.now();
    const snap = this.buildState(fly, goblin);
    let data;
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: snap.state, questions: QUESTIONS }),
      });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      this.stats.errors++;
      this.hud.showError(String(err.message || err));
      await sleep(/429|529/.test(String(err?.message || err)) ? 1200 : 400);
      return;
    }
    const latency = performance.now() - t0;
    this.stats.calls++;
    this.stats.tokens += data.usage?.input_tokens || 0;
    this.stats.latencies.push(latency);
    this.stats.times.push(performance.now());
    if (this.stats.latencies.length > 40) this.stats.latencies.shift();
    if (this.stats.times.length > 20) this.stats.times.shift();

    // Reject the whole response rather than fly on made-up values, and stop flying the old
    // plan right away (hover) instead of letting it run out.
    const invalid = validateAnswers(data.answers);
    if (invalid) {
      this.lastDecisionAt = 0;
      throw new Error(`rejected response (${invalid})`);
    }

    // The fly may have died while we waited.
    if (fly !== this.getFly() || !fly.alive) return;

    const decision = this.decide(data.answers);
    this.plan = {
      headingTarget: snap.heading + decision.yawDelta,
      dive: decision.dive,
      diveAngle: decision.diveAngle,
      branch: decision.branch,
    };
    this.lastDecisionAt = performance.now();
    // The full round trip as TypeSafe saw it: server.js forwards { model, state, questions }
    // and tacks server_ms / request_id onto the response, so strip those back off.
    const { server_ms, request_id, ...output } = data;
    const call = { input: { model: this.requestModel, state: snap.state, questions: QUESTIONS }, output };
    this.hud.showDecision({
      decision, answers: data.answers, state: snap.state, latency, call,
      model: data.model, usage: data.usage, stats: this.stats, requestId: data.request_id,
    });

    const wait = MIN_INTERVAL_MS - (performance.now() - t0);
    if (wait > 0) await sleep(wait);
  }

  // --- flight controller, runs every frame ------------------------------------------------
  // Executes the latest plan. With no usable answer it brakes to a level hover.
  fly(fly) {
    const cmd = fly.cmd;
    const live = this.planIsLive();
    this.failsafe = !!this.plan && !live; // before the first answer the fly just waits on the pad
    cmd.velocity = null;
    if (!live) {
      // Hover: tilt against the fly's own drift until it stops.
      const yaw = fly.yaw;
      const vF = -fly.vel.x * Math.sin(yaw) - fly.vel.z * Math.cos(yaw);
      const vR = fly.vel.x * Math.cos(yaw) - fly.vel.z * Math.sin(yaw);
      cmd.yaw = 0;
      cmd.pitch = THREE.MathUtils.clamp(-vF * 0.07, -0.5, 0.5);
      cmd.roll = THREE.MathUtils.clamp(-vR * 0.1, -0.5, 0.5);
      cmd.climb = 0;
      cmd.dive = false;
      return;
    }
    const p = this.plan;
    const err = wrap180(p.headingTarget - fly.headingDeg());
    cmd.yaw = THREE.MathUtils.clamp(err / 40, -1, 1);
    cmd.roll = 0;
    cmd.dive = p.dive;
    if (p.dive) {
      // Fly the velocity Jev chose: its heading, its dive angle, a fixed dive speed.
      const h = p.headingTarget * DEG, g = p.diveAngle * DEG;
      cmd.velocity = new THREE.Vector3(Math.sin(h) * Math.cos(g), -Math.sin(g), -Math.cos(h) * Math.cos(g)).multiplyScalar(DIVE_SPEED);
      cmd.pitch = 0;
      cmd.climb = 0;
      return;
    }
    cmd.pitch = CRUISE_TILT;
    cmd.climb = this.altitudeHold(fly);
  }

  // Climb rate that keeps the fly at cruise height over the ground and treetops in the
  // corridor it's about to fly through. Terrain and trees only; never the goblin.
  altitudeHold(fly) {
    const p = fly.pos;
    const hs = Math.hypot(fly.vel.x, fly.vel.z);
    const yaw = fly.yaw;
    const fx = hs > 3 ? fly.vel.x / hs : -Math.sin(yaw);
    const fz = hs > 3 ? fly.vel.z / hs : -Math.cos(yaw);
    const reach = Math.max(25, hs * LOOKAHEAD_S);
    let want = terrainHeight(p.x, p.z) + CRUISE_AGL;
    for (let d = 10; d <= reach; d += 10) {
      want = Math.max(want, terrainHeight(p.x + fx * d, p.z + fz * d) + CRUISE_AGL);
    }
    for (const t of this.world.queryObstacles(p.x + fx * reach / 2, p.z + fz * reach / 2, reach / 2 + 8, this._near)) {
      const ox = t.x - p.x, oz = t.z - p.z;
      const along = ox * fx + oz * fz;
      if (along < -5 || along > reach) continue;
      if (Math.abs(ox * fz - oz * fx) > t.canopyR + 5) continue;
      want = Math.max(want, t.y + t.height + TREE_CLEARANCE);
    }
    return THREE.MathUtils.clamp((want - p.y) * 0.8, -5, 12);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
