// Flight recorder: every flight's path, Jev's decisions along it, and exactly how it ended,
// for tuning Jev and the flight controller. Finished flights stay on game.flightLog.flights
// and are posted to the server, which appends them to .audit/flights/.
import { terrainHeight } from "./terrain.js";
import { treeRadiusAt } from "./ai.js";

const SAMPLE_S = 0.1; // path sample period
const KEEP = 30; // finished flights kept in memory
const DEG = 180 / Math.PI;
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// Path columns, one array per sample.
export const PATH_COLS = [
  "t", "x", "y", "z", "agl", "speed_h", "vy", "pitch_deg", "roll_deg", "heading_deg", "throttle",
  "tree_clear_m", "tree_part", "tree_id", "turn", "dodge", "climb", "dive",
];

// Which part of a tree a point at world height y is level with.
export function treePart(t, y) {
  const r = treeRadiusAt(t, y);
  if (r <= 0) return null;
  return r === t.trunkR ? "trunk" : "canopy";
}

// Everything about a tree collision worth tuning against.
export function treeHit(t, fly) {
  const p = fly.pos;
  return {
    what: "tree",
    tree_id: t.id,
    kind: t.kind,
    part: treePart(t, p.y),
    fly_agl_m: r2(p.y - terrainHeight(p.x, p.z)),
    height_on_tree_m: r2(p.y - t.y),
    tree_height_m: r1(t.height),
    canopy_bottom_m: r1(t.kind === "pine" ? t.canopyBottom : t.canopyCenter - t.canopyR),
    trunk_r_m: r2(t.trunkR),
    center_dist_m: r2(Math.hypot(t.x - p.x, t.z - p.z)),
  };
}

export class FlightLog {
  constructor(world, pilot) {
    this.world = world;
    this.pilot = pilot;
    this.flights = [];
    this.cur = null;
    this._near = [];
  }

  start(fly, goblin) {
    this.cur = {
      fly: fly.id,
      started: new Date().toISOString(),
      goblin_start: goblin ? { x: r1(goblin.x), z: r1(goblin.z) } : null,
      cols: PATH_COLS,
      path: [],
      decisions: [],
      t: 0,
      next: 0,
    };
  }

  // Nearest tree surface at the fly's height: collision happens when the clearance drops
  // below the fly's 0.3 m hit radius.
  nearestTree(p) {
    let best = null;
    for (const t of this.world.queryObstacles(p.x, p.z, 10, this._near)) {
      const r = treeRadiusAt(t, p.y);
      if (r <= 0) continue;
      const clear = Math.hypot(t.x - p.x, t.z - p.z) - r;
      if (!best || clear < best.clear) best = { t, r, clear };
    }
    return best;
  }

  sample(fly, dt) {
    const c = this.cur;
    if (!c || fly.id !== c.fly || fly.state !== "flying") return;
    c.t += dt;
    if (c.t < c.next) return;
    c.next = c.t + SAMPLE_S;
    const p = fly.pos, near = this.nearestTree(p), ch = this.pilot.plan?.choices ?? {};
    c.path.push([
      r2(c.t), r2(p.x), r2(p.y), r2(p.z), r2(fly.agl()), r1(Math.hypot(fly.vel.x, fly.vel.z)), r1(fly.vel.y),
      r1(fly.pitch * DEG), r1(fly.roll * DEG), Math.round(fly.headingDeg()), r2(fly.throttle),
      near ? r2(near.clear) : null, near ? (near.r === near.t.trunkR ? "trunk" : "canopy") : null, near?.t.id ?? null,
      ch.turn ?? null, ch.dodge ?? null, ch.climb ?? null, ch.dive ?? null,
    ]);
  }

  // One Jev round trip: what it saw and what it answered.
  decision(fly, { state, answers, latency }) {
    const c = this.cur;
    if (!c || fly.id !== c.fly) return;
    const choices = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.choice]));
    c.decisions.push({ t: r2(c.t), latency_ms: Math.round(latency), state, answers: choices });
  }

  // outcome: { cause, ...details } — a tree hit carries treeHit(), the ground its impact.
  end(fly, outcome) {
    const c = this.cur;
    if (!c || fly.id !== c.fly) return null;
    this.cur = null;
    const agl = c.path.map((s) => s[4]);
    const speed = c.path.map((s) => s[5]);
    const clear = c.path.map((s) => s[11]).filter((v) => v !== null);
    const mean = (a) => (a.length ? r2(a.reduce((x, y) => x + y, 0) / a.length) : null);
    const flight = {
      fly: c.fly,
      started: c.started,
      duration_s: r2(c.t),
      goblin_start: c.goblin_start,
      outcome: { ...outcome, x: r2(fly.pos.x), y: r2(fly.pos.y), z: r2(fly.pos.z), speed: r1(fly.vel.length()), vy: r1(fly.vel.y) },
      summary: {
        samples: c.path.length,
        decisions: c.decisions.length,
        agl_min: agl.length ? Math.min(...agl) : null,
        agl_mean: mean(agl),
        agl_max: agl.length ? Math.max(...agl) : null,
        speed_mean: mean(speed),
        tree_clear_min: clear.length ? Math.min(...clear) : null,
      },
      cols: c.cols,
      path: c.path,
      decisions: c.decisions,
    };
    this.flights.push(flight);
    if (this.flights.length > KEEP) this.flights.shift();
    fetch("/api/flights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(flight),
    }).catch(() => {});
    return flight;
  }
}
