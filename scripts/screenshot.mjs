// Capture the running game with headless Chrome and append it to the progress gallery.
// usage: node scripts/screenshot.mjs --label "first flight" --wait 15 [--note "..."] [--shots 1] [--gap 4]
//        node scripts/screenshot.mjs --rebuild   (regenerate the gallery page only)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "screenshots");
fs.mkdirSync(OUT, { recursive: true });

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
    return acc;
  }, []),
);
const label = args.label || "snapshot";
const wait = Number(args.wait || 14);
const shots = Number(args.shots || 1);
const gap = Number(args.gap || 4);
const url = args.url || "http://localhost:5173/?autostart=1&capture=1";
const record = !args["no-record"];

if (args.rebuild) {
  // just regenerate screenshots/index.html from progress.json
  writeGallery(JSON.parse(fs.readFileSync(path.join(OUT, "progress.json"), "utf8")));
  process.exit(0);
}

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required", "--window-size=1600,900"],
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => {
  if (["error", "warning"].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: "domcontentloaded" });

const files = [];
for (let i = 0; i < shots; i++) {
  await new Promise((r) => setTimeout(r, (i === 0 ? wait : gap) * 1000));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const file = `${stamp}-${slug}${shots > 1 ? `-${i + 1}` : ""}.png`;
  await page.screenshot({ path: path.join(OUT, file) });
  files.push(file);
}

const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0;
  const t0 = performance.now();
  const tick = () => (++n, performance.now() - t0 < 2000 ? requestAnimationFrame(tick) : res(Math.round((n * 1000) / (performance.now() - t0))));
  requestAnimationFrame(tick);
}));
const info = await page.evaluate(() => {
  const g = window.game;
  if (!g) return { error: "no game object" };
  const d = g.fly;
  return {
    pops: g.pops,
    resets: g.resets,
    flyNum: g.flyNum,
    fly: d && { state: d.state, alive: d.alive, agl: +d.agl().toFixed(1), speed: +d.vel.length().toFixed(1), heading: Math.round(d.headingDeg()), energy: d.energy },
    calls: g.pilot.stats.calls,
    errors: g.pilot.stats.errors,
    avgLatency: Math.round(g.pilot.stats.latencies.reduce((a, b) => a + b, 0) / Math.max(1, g.pilot.stats.latencies.length)),
    branch: document.getElementById("branch")?.textContent,
    goblinAlive: !!g.goblin?.alive,
    webgl: !!document.querySelector("#app canvas")?.getContext("webgl2"),
    events: g.events,
    audio: g.audio?.ctx ? { state: g.audio.ctx.state, t: +g.audio.ctx.currentTime.toFixed(1) } : null,
  };
});
await browser.close();

info.fps = fps;
console.log(JSON.stringify({ files, info, logs: logs.slice(0, 20) }, null, 2));

if (record) {
  const dbFile = path.join(OUT, "progress.json");
  const db = fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, "utf8")) : [];
  for (const f of files) db.push({ file: f, label, note: args.note || "", at: new Date().toISOString(), info });
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
  writeGallery(db);
}

function writeGallery(db) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const cards = [...db]
    .reverse()
    .map((e, i) => `
    <article>
      <header><span class="n">#${db.length - i}</span><h2>${esc(e.label)}</h2><time>${esc(new Date(e.at).toLocaleString())}</time></header>
      <a href="${esc(e.file)}" target="_blank"><img src="${esc(e.file)}" loading="lazy" alt="${esc(e.label)}"></a>
      ${e.note ? `<p>${esc(e.note)}</p>` : ""}
      <dl>
        <div><dt>pops</dt><dd>${e.info?.pops ?? "–"}</dd></div>
        <div><dt>fly resets</dt><dd>${e.info?.resets ?? "–"}</dd></div>
        <div><dt>Jev calls</dt><dd>${e.info?.calls ?? "–"}</dd></div>
        <div><dt>avg latency</dt><dd>${e.info?.avgLatency ?? "–"} ms</dd></div>
        <div><dt>branch</dt><dd>${esc(e.info?.branch ?? "–")}</dd></div>
      </dl>
    </article>`)
    .join("\n") || '<p class="sub">No garden captures yet.</p>';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev's Fly · garden captures</title>
<style>
  :root { --bg:#0b0f14; --card:#121a24; --line:rgba(160,200,255,.14); --text:#dce6f2; --dim:#7f8ea3; --accent:#36e2ff; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, sans-serif; }
  main { max-width:1180px; margin:0 auto; padding:32px 16px 64px; }
  h1 { font-size:28px; letter-spacing:.08em; margin:0 0 4px; }
  .sub { color:var(--dim); margin:0 0 28px; }
  article { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:22px; }
  article header { display:flex; align-items:baseline; gap:12px; margin-bottom:10px; flex-wrap:wrap; }
  article h2 { margin:0; font-size:18px; }
  .n { color:var(--accent); font-family:ui-monospace, monospace; }
  time { color:var(--dim); font-size:12px; margin-left:auto; }
  img { width:100%; border-radius:10px; display:block; border:1px solid var(--line); }
  p { color:#b9c6d6; margin:12px 0 4px; }
  dl { display:flex; gap:22px; flex-wrap:wrap; margin:10px 0 0; font-family:ui-monospace, monospace; font-size:12px; }
  dt { color:var(--dim); } dd { margin:0; color:var(--text); }
</style></head><body><main>
<h1>JEV'S FLY · GARDEN CAPTURES</h1>
<p class="sub">FPV garden moments piloted by TypeSafe Jev. Newest first.</p>
${cards}
</main></body></html>`;
  fs.writeFileSync(path.join(OUT, "index.html"), html);
}
