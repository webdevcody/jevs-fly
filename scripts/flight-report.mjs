// Reads flight logs and reports how the flying went: outcomes, how low and fast the fly flew,
// how close it passed trees, Jev's answer mix, and the path into every crash.
//   node scripts/flight-report.mjs .audit/flights/*.jsonl [--crash-detail]
// Takes the server's .jsonl logs or the .json files from flight-test.mjs.
import fs from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const detail = process.argv.includes("--crash-detail");
const flights = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  if (f.endsWith(".jsonl")) for (const line of text.split("\n")) { if (line.trim()) flights.push({ src: f, ...JSON.parse(line) }); }
  else for (const fl of JSON.parse(text).flights ?? []) flights.push({ src: f.replace(/.*\//, ""), ...fl });
}
if (!flights.length) { console.log("no flights"); process.exit(0); }
const C = Object.fromEntries(flights[0].cols.map((c, i) => [c, i]));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const count = (arr) => arr.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});

// --- outcomes ---
const outcomes = flights.map((f) => {
  const o = f.outcome;
  if (o.cause === "goblin") return "POP";
  if (o.what === "tree") return `${o.kind} ${o.part}`;
  if (o.what === "ground") return "ground";
  return o.cause;
});
console.log(`${flights.length} flights · ${outcomes.filter((o) => o === "POP").length} pops · outcomes ${JSON.stringify(count(outcomes))}`);
const dur = flights.map((f) => f.duration_s);
console.log(`flight time p50 ${pct(dur, 0.5)} s · mean decision latency ${Math.round(flights.flatMap((f) => f.decisions.map((d) => d.latency_ms)).reduce((a, b, _, x) => a + b / x.length, 0))} ms`);

// --- path-wide stats ---
const all = flights.flatMap((f) => f.path);
const agl = all.map((s) => s[C.agl]), spd = all.map((s) => s[C.speed_h]);
console.log(`AGL p5/p50/p95 ${pct(agl, 0.05)}/${pct(agl, 0.5)}/${pct(agl, 0.95)} m · speed p50 ${pct(spd, 0.5)} m/s · |roll| p95 ${pct(all.map((s) => Math.abs(s[C.roll_deg])), 0.95)}° · pitch p95 ${pct(all.map((s) => s[C.pitch_deg]), 0.95)}°`);
// Close passes: per flight and tree, the smallest clearance while that tree was nearest.
const passes = [];
for (const f of flights) {
  const by = new Map();
  for (const s of f.path) {
    if (s[C.tree_id] === null) continue;
    const k = s[C.tree_id], cur = by.get(k);
    if (!cur || s[C.tree_clear_m] < cur.clear) by.set(k, { clear: s[C.tree_clear_m], part: s[C.tree_part], agl: s[C.agl] });
  }
  passes.push(...by.values());
}
// Hit radius 0.3 m; the body is ~0.45 m wide each side, the wings reach ~1.45 m.
const band = (lo, hi) => passes.filter((p) => p.clear >= lo && p.clear < hi);
for (const part of ["trunk", "canopy"]) {
  const P = passes.filter((p) => p.part === part);
  console.log(`${part} passes within 3 m: ${P.filter((p) => p.clear < 3).length} · wing overlap (<1.45 m) ${P.filter((p) => p.clear < 1.45).length} · body overlap (<0.45 m) ${P.filter((p) => p.clear < 0.45).length} · hit (<0.3 m) ${P.filter((p) => p.clear < 0.3).length}`);
}
void band;
// Canopy exposure: time spent level with a canopy that close.
const canopyNear = all.filter((s) => s[C.tree_part] === "canopy" && s[C.tree_clear_m] < 3);
console.log(`time level with a canopy within 3 m: ${(canopyNear.length / 10).toFixed(1)} s of ${(all.length / 10).toFixed(0)} s, AGL there p50 ${canopyNear.length ? pct(canopyNear.map((s) => s[C.agl]), 0.5) : "-"} m`);

// --- Jev's answers ---
const dec = flights.flatMap((f) => f.decisions);
for (const q of ["turn", "dodge", "climb", "dive"]) console.log(`${q}: ${JSON.stringify(count(dec.map((d) => d.answers[q])))}`);
// Dodge effectiveness: after a dodge answer, did the first trunk's gap grow by the next decision?
let grew = 0, shrank = 0;
for (const f of flights) for (let i = 0; i + 1 < f.decisions.length; i++) {
  const a = f.decisions[i], b = f.decisions[i + 1];
  if (a.answers.dodge === "none") continue;
  const ta = a.state.path_ahead?.trunks?.[0], tb = b.state.path_ahead?.trunks?.[0];
  if (!ta) continue;
  if (!tb || tb.distance_m > ta.distance_m + 5 || tb.gap_m > ta.gap_m) grew++; else shrank++;
}
console.log(`dodges: gap grew/cleared ${grew} · gap shrank ${shrank}`);

// --- crashes ---
for (const f of flights) {
  const o = f.outcome;
  if (o.cause === "goblin") continue;
  const what = o.what === "tree" ? `${o.kind} ${o.part} (${o.tree_id}) at ${o.fly_agl_m} m AGL, ${o.height_on_tree_m} m up a ${o.tree_height_m} m tree (canopy from ${o.canopy_bottom_m} m, trunk r ${o.trunk_r_m})` : o.what === "ground" ? `ground at ${o.impact_speed} m/s, vy ${o.vy}, tilt ${o.tilt_deg}°` : o.cause;
  console.log(`\n✗ ${f.src} fly ${f.fly} after ${f.duration_s}s: ${what} · speed ${o.speed} vy ${o.vy}`);
  if (!detail) continue;
  console.log("   t     agl  spd   vy  pitch  roll  hdg  thr  clear part     answers");
  for (const s of f.path.slice(-20).filter((_, i, a) => (a.length - 1 - i) % 2 === 0)) {
    console.log(`   ${String(s[C.t]).padEnd(5)} ${String(s[C.agl]).padStart(4)} ${String(s[C.speed_h]).padStart(4)} ${String(s[C.vy]).padStart(4)} ${String(s[C.pitch_deg]).padStart(6)} ${String(s[C.roll_deg]).padStart(5)} ${String(s[C.heading_deg]).padStart(4)} ${String(s[C.throttle]).padStart(4)} ${String(s[C.tree_clear_m]).padStart(6)} ${String(s[C.tree_part]).padEnd(7)} ${s[C.turn]}/${s[C.dodge]}/${s[C.climb]}/${s[C.dive]}`);
  }
  for (const d of f.decisions.slice(-3)) console.log(`   jev @${d.t}s (${d.latency_ms} ms): ${JSON.stringify(d.state.path_ahead)} -> ${d.answers.dodge}/${d.answers.climb}`);
}
