// Headless test flight: runs the game in Chrome, flies for a while and saves the flight logs.
//   node scripts/flight-test.mjs --secs 120 --seed 7 [--label run] [--port 5199] [--mock] [--query "magic=0"]
// --mock answers Jev's questions locally from their own criteria, so a tuning run costs no
// TypeSafe credits. Logs land in .audit/flights/<label>.json; read them with flight-report.mjs.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "package.json"));
const puppeteer = require("puppeteer-core");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = {};
process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith("--")) args[a.slice(2)] = all[i + 1]?.startsWith("--") ? "1" : all[i + 1] ?? "1"; });
const secs = Number(args.secs || 120);
const port = Number(args.port || 5199);
const seed = Number(args.seed || 7);
const mock = args.mock === "1";
const label = args.label || `${mock ? "mock" : "jev"}-s${seed}`;
const out = path.join(ROOT, ".audit/flights");
fs.mkdirSync(out, { recursive: true });

const srv = spawn("node", ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), TYPESAFE_TRACE: "0", FLIGHT_LOG: "0" }, stdio: ["ignore", "pipe", "pipe"] });
await new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error("server did not start")), 5000);
  srv.stdout.on("data", (b) => { if (String(b).includes("running at")) { clearTimeout(to); res(); } });
});
const killer = setTimeout(() => { console.error("hard timeout"); srv.kill(); process.exit(2); }, (secs + 60) * 1000);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--mute-audio", "--window-size=1280,720"],
  defaultViewport: { width: 1280, height: 720 },
});
let R;
try {
  const page = await browser.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`.slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") logs.push(`[console] ${m.text()}`.slice(0, 300)); });
  await page.evaluateOnNewDocument((seed, mock) => {
    // Same map and goblin placement every run.
    let a = seed >>> 0;
    Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    if (!mock) return;
    // Stand-in for Jev: answers each question straight from its own criteria, with the same
    // round-trip delay, so flights can be tuned without spending credits.
    const pick = (state) => {
      const g = state.goblin, p = state.path_ahead;
      const deg = parseInt(g.bearing, 10) || 0;
      const rightward = / right/.test(g.bearing);
      const side = (n) => (rightward ? n : n.replace("right", "left"));
      const turn = deg <= 3 ? "straight" : deg <= 10 ? side("nudge_right") : deg <= 25 ? side("slight_right") : deg <= 60 ? side("right") : side("hard_right");
      const trunk = p.trunks[0];
      const dodge = !trunk ? "none" : trunk.side === "right" ? "left" : "right";
      const c = p.climb_needed_deg;
      const climb = c > 20 ? "up30" : c >= 12 ? "up20" : c >= 7 ? "up12" : c >= 3 ? "up7" : c > -3 ? "level" : c > -10 ? "down6" : c > -20 ? "down15" : "down25";
      const below = g.below_horizon_deg, clear = g.line_of_sight === "clear" && c <= 7;
      const aimed = deg <= 40;
      let dive = "not_yet";
      if (clear && below > 80) dive = "d90";
      else if (clear && aimed) dive = below >= 66 ? "d75" : below >= 52 ? "d60" : below >= 38 ? "d45" : below >= 25 ? "d30" : "not_yet";
      return { turn, dodge, climb, dive };
    };
    const realFetch = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      if (!String(url).endsWith("/api/decide")) return realFetch(url, opts);
      const body = JSON.parse(opts.body);
      const choices = pick(body.state);
      const answers = {};
      for (const [id, q] of Object.entries(body.questions)) {
        const probabilities = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === choices[id] ? 1 : 0]));
        answers[id] = { type: "choice", choice: choices[id], confidence: 1, probabilities };
      }
      await new Promise((r) => setTimeout(r, 180 + Math.random() * 80)); // Jev's usual latency
      return new Response(JSON.stringify({ model: "mock", answers, usage: { input_tokens: 0 }, server_ms: 0, request_id: "mock" }), { headers: { "Content-Type": "application/json" } });
    };
  }, seed, mock);
  await page.goto(`http://localhost:${port}/?autostart=1&${args.query || ""}`, { waitUntil: "domcontentloaded" });
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) await new Promise((r) => setTimeout(r, 1000));
  R = await page.evaluate(() => ({
    flights: window.game.flightLog?.flights ?? [], pops: window.game.pops, resets: window.game.resets,
    calls: window.game.pilot.stats.calls, errors: window.game.pilot.stats.errors,
  }));
  R.logs = logs;
} finally {
  await browser.close();
  srv.kill();
  clearTimeout(killer);
}
const file = path.join(out, `${label}.json`);
fs.writeFileSync(file, JSON.stringify(R));
console.log(`${label}: ${R.pops} pops, ${R.resets} resets, ${R.flights.length} flights logged, ${R.calls} calls, ${R.errors} errors -> ${path.relative(ROOT, file)}`);
if (R.logs.length) console.log(R.logs.slice(0, 5).join("\n"));
