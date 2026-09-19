// Jev pilots a fantasy fly around a wandering goblin.
//
// Jev sees what an FPV pilot sees in the goggles: where the goblin sits in the view, as
// degrees left/right of the nose and degrees below the horizon, and whether a tree or the
// ground stands between them. Those numbers point at where the goblin will be when the fly
// gets there, so a moving goblin doesn't pull the dive behind it. Trees are thin trunks under
// canopies that hang well above the ground, so for the flight path ahead Jev sees just two
// things: the climb angle that keeps the fly skimming low (over the ground, under the canopies),
// and the trunks the line would brush past (thin posts it can slip beside).
//
// Jev answers four questions in one call, about 5 times a second:
//   turn   which way to yaw toward the goblin
//   dodge  sidestep a trunk in the way, or not
//   climb  what to do with height: skim low over the ground, under the canopies
//   dive   keep cruising toward it, or dive into it now (along a clear line) and how steeply
//
// The flight controller does the rest without Jev: angle-mode stabilization, a fixed cruise
// speed, flying Jev's climb angle as a vertical speed, rolling into Jev's sidesteps, and a
// braking hover if answers stop. It never reads the goblin, the trees or the ground: which way
// to head, how high to fly, which side of a trunk to pass, and when and how steeply to dive
// come only from Jev.
// A response with any missing or invalid answer is rejected whole.
import * as THREE from "three";
import { terrainHeight } from "./terrain.js";

const DEG = Math.PI / 180;
const MIN_INTERVAL_MS = 140; // ~5 decisions/second
const FAILSAFE_MS = 1500;
const STALE_MS = 400; // an answer this old no longer carries the fly downward

// Flight controller settings (the only things the fly does on its own).
const CRUISE_TILT = 0.35; // forward stick while cruising, ~25 m/s
const DIVE_SPEED = 32; // m/s along the dive path
const DODGE_GAP_M = 2; // m of air a sidestep leaves between the flight line and the trunk's bark
const SIDE_KP = 1.2; // roll stick per m of sidestep still to go
const SIDE_KD = 0.5; // roll stick per m/s of sideways slide (damps it; also keeps the fly flying where it points)
const SIDE_MAX = 0.9; // most roll stick a sidestep uses, ~35° of bank

// What Jev is told about the flight path ahead.
const SKIM_M = 1.8; // m over the ground the fly hunts at: under every canopy
const SQUEEZE_M = 0.8; // m over the ground the fly will drop to, to get under a low canopy
const GROUND_LOOK_M = 20; // how far ahead the ground counts: short enough that "level" holds the fly near SKIM_M
const CANOPY_MARGIN = 0.8; // m under a canopy that counts as passing safely
const TREETOP_MARGIN = 1.5; // m over a treetop, when it's too late to duck under the canopy
const DUCK_DEG = -25; // steepest descent that still counts as time to duck under a canopy
const WING_M = 0.6; // m, the fly's reach sideways (wings plus the collision margin)
const TREE_LOOK_M = 60; // how far along the flight line trees are listed, ~2.4 s at cruise speed
const TRUNK_GAP_M = 1.5; // m of air between the flight line and the bark that counts as in the way
const MAX_TRUNKS = 2; // nearest first
const SIGHT_MARGIN = 1; // m, room for the wings along the line of sight to the goblin
const POP_RANGE = 4; // m, how close the fly has to get to pop the goblin (see main.js)

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;

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

// Underside of a tree's canopy (world y) `side` m out from the trunk, or null when the canopy
// doesn't reach that far. Pines have a flat skirt; an oak's round crown hangs lowest in the middle.
export function canopyUnderside(t, side) {
  if (side >= t.canopyR) return null;
  if (t.kind === "pine") return t.y + t.canopyBottom;
  return t.y + t.canopyCenter - Math.sqrt(t.canopyR * t.canopyR - side * side);
}

// The four questions. They never change, only the state does.
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
  dodge: {
    type: "choice",
    instructions:
      "Trees are thin trunks with canopies high overhead, so the low-flying fly slips between the trunks. " +
      "`path_ahead.trunks` lists the trunks in its way, nearest first: the flight line passes less than 1.5 m from " +
      "their bark (`gap_m`, negative: straight through the trunk), on the `side` given. Should the fly sidestep? " +
      "Use the first trunk in the list.",
    criteria: {
      left: "Sidestep left: the first trunk in `path_ahead.trunks` is on the right.",
      none: "Keep the line: `path_ahead.trunks` is empty.",
      right: "Sidestep right: the first trunk in `path_ahead.trunks` is on the left.",
    },
  },
  climb: {
    type: "choice",
    instructions:
      "The fly hunts low, skimming just over the ground and under the tree canopies, and must never touch the ground " +
      "or a canopy. `path_ahead.climb_needed_deg` is the flight-path angle that keeps it there: about 2 m over the " +
      "ground and under the canopies ahead (negative: it can descend that steeply). What should the fly do with its height?",
    criteria: {
      up30: "Climb at 30°: `path_ahead.climb_needed_deg` is more than 20°.",
      up20: "Climb at 20°: `path_ahead.climb_needed_deg` is 12° to 20°.",
      up12: "Climb at 12°: `path_ahead.climb_needed_deg` is 7° to 12°.",
      up7: "Climb at 7°: `path_ahead.climb_needed_deg` is 3° to 7°.",
      level: "Fly level: `path_ahead.climb_needed_deg` is between -3° and 3°.",
      down6: "Descend at 6°: `path_ahead.climb_needed_deg` is -10° to -3°.",
      down15: "Descend at 15°: `path_ahead.climb_needed_deg` is -20° to -10°.",
      down25: "Descend at 25°: `path_ahead.climb_needed_deg` is below -20°.",
    },
  },
  dive: {
    type: "choice",
    instructions:
      "The fly makes the goblin pop into colorful sparkles by swooping close. Should it dive now, and how steeply? " +
      "The way is clear only when `goblin.line_of_sight` is clear and `path_ahead.climb_needed_deg` is at most 7°. " +
      "Use `goblin.below_horizon_deg` and `goblin.bearing`.",
    criteria: {
      not_yet: "Keep flying toward it: the way is not clear, or the goblin is less than 25° below the horizon, or it is more than 40° left or right (unless it is more than 80° below).",
      d30: "Dive at 30°: the way is clear and the goblin is 25° to 38° below the horizon and within 40° of the nose.",
      d45: "Dive at 45°: the way is clear and the goblin is 38° to 52° below the horizon and within 40° of the nose.",
      d60: "Dive at 60°: the way is clear and the goblin is 52° to 66° below the horizon and within 40° of the nose.",
      d75: "Dive at 75°: the way is clear and the goblin is 66° to 80° below the horizon and within 40° of the nose.",
      d90: "Dive straight down: the way is clear and the goblin is more than 80° below the horizon, whatever its bearing.",
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
const DODGE_SIDE = { left: -1, none: 0, right: 1 };
// Flight-path angle below the horizon for each dive. The shallowest dive flies the bottom of
// its range, so the goblin only climbs higher in the view and a dive never shallows back out
// into a pull-out; the rest fly the middle of their range.
const DIVE_ANGLE = { d30: 26, d45: 45, d60: 59, d75: 73, d90: 88 };
// Flight-path angle above the horizon for each climb answer, named after the angle it flies.
// Climbs fly the top of their range so rising ground is always out-climbed, and the ranges are
// narrow enough that the overshoot past a crest never reaches the canopies. Descents fly the
// shallow half, so a late answer doesn't carry the fly into the ground.
const CLIMB_ANGLE = { up30: 30, up20: 20, up12: 12, up7: 7, level: 0, down6: -6, down15: -15, down25: -25 };

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
    this._sight = [];
    this.onDecision = null; // (fly, { state, answers, latency }) after each flown answer
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
    // The flight line: straight out of the nose. The controller keeps the fly from sliding
    // sideways, so that's where it goes, and a sidestep moves the line by exactly its slide.
    const fx = -Math.sin(fly.yaw), fz = -Math.cos(fly.yaw);
    const blocker = this.sightBlocker(fly.pos, new THREE.Vector3(ax, c.y, az));
    const state = {
      goblin: {
        bearing: bearingText(bearing),
        below_horizon_deg: r0(below),
        line_of_sight: blocker ? `blocked by ${blocker.what} ${blocker.distance_m} m away` : "clear",
      },
      path_ahead: this.pathAhead(fly, fx, fz),
    };
    return { state, heading, origin: { x: fly.pos.x, z: fly.pos.z }, right: { x: -fz, z: fx } };
  }

  // The first tree or rise of ground on the straight line from the fly to the goblin, or null
  // when the line is clear.
  sightBlocker(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz), flat = Math.hypot(dx, dz);
    // only trees whose canopy comes near the line on the map
    const trees = this.world.queryObstacles((from.x + to.x) / 2, (from.z + to.z) / 2, flat / 2 + 2, this._sight).filter((t) => {
      const ox = t.x - from.x, oz = t.z - from.z;
      const f = THREE.MathUtils.clamp((ox * dx + oz * dz) / Math.max(flat * flat, 1e-6), 0, 1);
      return Math.hypot(ox - dx * f, oz - dz * f) < t.canopyR + SIGHT_MARGIN;
    });
    for (let s = 1; s < len - POP_RANGE; s++) { // the line only has to reach popping range
      const f = s / len;
      const x = from.x + dx * f, y = from.y + dy * f, z = from.z + dz * f;
      if (y < terrainHeight(x, z) + 0.5) return { what: "the ground", distance_m: s };
      for (const t of trees) {
        const r = treeRadiusAt(t, y);
        if (r > 0 && Math.hypot(t.x - x, t.z - z) < r + SIGHT_MARGIN) return { what: `a ${t.kind} tree`, distance_m: s };
      }
    }
    return null;
  }

  // What the fly sees along its flight line: the climb angle that keeps it low, and the trunks
  // whose bark the line passes within TRUNK_GAP_M of, nearest first. Low means SKIM_M over the
  // ground and CANOPY_MARGIN under every canopy it still has time to duck under; a tree too
  // close to duck under is cleared over the top instead.
  pathAhead(fly, fx, fz) {
    const p = fly.pos;
    const ground = []; // [distance, angle to stay SKIM_M over the ground there, to stay SQUEEZE_M over it]
    for (let d = 4; d <= GROUND_LOOK_M; d += 4) {
      const g = terrainHeight(p.x + fx * d, p.z + fz * d) - p.y;
      ground.push([d, Math.atan2(g + SKIM_M, d) / DEG, Math.atan2(g + SQUEEZE_M, d) / DEG]);
    }
    const over = []; // [distance, angle to clear a treetop]
    let ceiling = 90, ceilingAt = 0;
    const trunks = [];
    const mx = p.x + fx * TREE_LOOK_M / 2, mz = p.z + fz * TREE_LOOK_M / 2;
    for (const t of this.world.queryObstacles(mx, mz, TREE_LOOK_M / 2 + 8, this._near)) {
      const ox = t.x - p.x, oz = t.z - p.z;
      const along = ox * fx + oz * fz;
      const cross = fx * oz - fz * ox; // > 0: trunk right of the line
      const side = Math.abs(cross);
      const reach = Math.max(0, side - WING_M); // nearest the wings come to the trunk
      const under = canopyUnderside(t, reach);
      if (under === null) continue; // the canopy doesn't reach the line, so neither does the trunk
      const half = Math.sqrt(t.canopyR ** 2 - reach ** 2); // canopy chord along the line
      if (along + half < 0 || along - half > TREE_LOOK_M || p.y > t.y + t.height + TREETOP_MARGIN) continue;
      const entry = Math.max(along - half, 2);
      const duck = Math.atan2(under - CANOPY_MARGIN - p.y, entry) / DEG;
      if (duck < DUCK_DEG) {
        over.push([entry, Math.atan2(t.y + t.height + TREETOP_MARGIN - p.y, entry) / DEG]);
        continue;
      }
      if (duck < ceiling) [ceiling, ceilingAt] = [duck, entry];
      const gap = side - t.trunkR;
      if (gap < TRUNK_GAP_M && along >= -1) trunks.push({ distance_m: r0(Math.max(along, 0)), side: cross > 0 ? "right" : "left", gap_m: r1(gap) });
    }
    trunks.sort((a, b) => a.distance_m - b.distance_m);
    // Lowest safe line: the steepest climb the ground (at `col`'s height) or a treetop needs up
    // to `dist` ahead.
    const floorTo = (dist, col = 1) => Math.max(-90, ...[...ground.map((g) => [g[0], g[col]]), ...over]
      .filter(([d]) => d <= Math.max(dist, 4)).map(([, a]) => a));
    let climb = floorTo(Infinity);
    if (ceiling < climb) {
      // No straight line skims everything ahead and passes under the canopy: duck under the
      // canopy first, minding only what comes before it, down to SQUEEZE_M over the ground.
      // Past it, the rest gets its turn.
      const near = floorTo(ceilingAt, 2);
      climb = ceiling - 2 >= near ? ceiling - 2 : (ceiling + near) / 2;
    }
    return { climb_needed_deg: r0(climb), trunks: trunks.slice(0, MAX_TRUNKS) };
  }

  // --- Jev's four answers -> a plan for the flight controller ----------------------------
  decide(answers) {
    const turn = answers.turn.choice, dodge = answers.dodge.choice;
    const climb = answers.climb.choice, dive = answers.dive.choice;
    // A dive bends onto its line gradually, so it never overrules a hard climb: when Jev says
    // both, the fly climbs with the rising ground first.
    const diving = dive !== "not_yet" && CLIMB_ANGLE[climb] <= 7;
    return {
      branch: diving ? "DIVE" : "CRUISE",
      yawDelta: YAW_DELTA[turn],
      dodge: DODGE_SIDE[dodge],
      climbAngle: CLIMB_ANGLE[climb],
      dive: diving,
      diveAngle: diving ? DIVE_ANGLE[dive] : null,
      turn,
      dodgeChoice: dodge,
      climb,
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
      // A sidestep slides the line to DODGE_GAP_M from the first trunk Jev saw, measured from
      // where the fly was when it looked, so repeated answers aim at the same spot.
      origin: snap.origin,
      right: snap.right,
      slide: decision.dodge * Math.max(0.5, DODGE_GAP_M - (snap.state.path_ahead.trunks[0]?.gap_m ?? DODGE_GAP_M)),
      dodge: decision.dodge,
      climbAngle: decision.climbAngle,
      dive: decision.dive,
      diveAngle: decision.diveAngle,
      branch: decision.branch,
      choices: { turn: decision.turn, dodge: decision.dodgeChoice, climb: decision.climb, dive: decision.diveChoice },
    };
    this.lastDecisionAt = performance.now();
    this.onDecision?.(fly, { state: snap.state, answers: data.answers, latency });
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
    // A banked turn toward the trunk would swing the line back into it: hold the nose until
    // the sidestep is done.
    if (!p.dive && p.dodge && Math.sign(err) === -p.dodge) cmd.yaw = 0;
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
    // A sidestep is pure bank: the nose stays put while the fly slides to its planned spot off the line Jev
    // saw. Otherwise the same loop cancels any sideways slide.
    const right = p.dodge ? p.right : { x: Math.cos(fly.yaw), z: -Math.sin(fly.yaw) };
    const slide = fly.vel.x * right.x + fly.vel.z * right.z;
    const togo = p.dodge ? p.slide - ((fly.pos.x - p.origin.x) * right.x + (fly.pos.z - p.origin.z) * right.z) : 0;
    cmd.roll = THREE.MathUtils.clamp(SIDE_KP * togo - SIDE_KD * slide, -SIDE_MAX, SIDE_MAX);
    // Fly Jev's climb angle as a vertical speed at the current ground speed. A late answer
    // stops carrying the fly down: it holds its height until a fresh one lands.
    const hs = Math.hypot(fly.vel.x, fly.vel.z);
    const stale = performance.now() - this.lastDecisionAt > STALE_MS;
    const angle = stale ? Math.max(p.climbAngle, 0) : p.climbAngle;
    cmd.climb = THREE.MathUtils.clamp(Math.max(hs, 12) * Math.tan(angle * DEG), -9, 15);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
