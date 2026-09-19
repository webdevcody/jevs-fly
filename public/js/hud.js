// DOM overlay: Jev decision tree (with the taken path lit up), state inspector,
// Stats, FPV stick gimbals, minimap, goblin marker and event feed.
import * as THREE from "three";
import { PLAY_HALF, START_FLOWER } from "./terrain.js";

const SVGNS = "http://www.w3.org/2000/svg";

// Decision-tree layout (viewBox 420 x 290). Jev answers TURN? and DIVE? from the same state;
// the flight controller flies the result.
const TURN_OPTS = ["hard_left", "left", "slight_left", "nudge_left", "straight", "nudge_right", "slight_right", "right", "hard_right"];
const TURN_LABELS = ["◂◂", "◂", "", "", "|", "", "", "▸", "▸▸"];
const DIVE_OPTS = ["not_yet", "d30", "d45", "d60", "d75", "d90"];
const DIVE_LABELS = ["no", "30°", "45°", "60°", "75°", "90°"];
const NODES = {
  state: { x: 210, y: 18, w: 340, h: 28, kind: "io", title: "STATE → JEV" },
  turn: { x: 105, y: 104, w: 190, h: 92, kind: "q", title: "TURN?", bars: TURN_OPTS, labels: TURN_LABELS },
  dive: { x: 315, y: 104, w: 190, h: 92, kind: "q", title: "DIVE?", bars: DIVE_OPTS, labels: DIVE_LABELS },
  yaw: { x: 105, y: 206, w: 150, h: 42, kind: "act", title: "HEADING" },
  cruise: { x: 260, y: 206, w: 106, h: 42, kind: "act", title: "CRUISE" },
  dive_run: { x: 370, y: 206, w: 90, h: 42, kind: "act", title: "DIVE RUN" },
  sticks: { x: 210, y: 270, w: 340, h: 28, kind: "io", title: "STICKS → FLIGHT CONTROLLER" },
};

const EDGES = [
  ["state", "turn"],
  ["state", "dive"],
  ["turn", "yaw"],
  ["dive", "cruise", "not yet"],
  ["dive", "dive_run", "dive"],
  ["yaw", "sticks"],
  ["cruise", "sticks"],
  ["dive_run", "sticks"],
];

const BRANCH_COLORS = { CRUISE: "#36e2ff", DIVE: "#ff7a1a" };

const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export class HUD {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.buildTree();
    this.trail = [];
    this.messages = this.$("feed");
    this.minimap = this.$("minimap");
    this.mctx = this.minimap.getContext("2d");
    this.stateOpen = true;
    this.$("state-toggle").addEventListener("click", () => {
      this.stateOpen = !this.stateOpen;
      this.$("state-json").style.display = this.stateOpen ? "block" : "none";
      this.$("state-toggle").textContent = this.stateOpen ? "hide" : "show";
    });

    // Full call inspector (request in / response out): live by default, "freeze" holds one call for reading/copying
    this.last = null;
    this.modalShown = null;
    this.modalOpen = false;
    this.modalFrozen = false;
    this.modalTab = "input";
    for (const b of document.querySelectorAll("#state-modal [data-tab]")) {
      b.addEventListener("click", () => {
        this.modalTab = b.dataset.tab;
        this.renderStateModal(this.modalShown);
        this.$("sm-json").scrollTop = 0;
      });
    }
    this.$("state-json").addEventListener("click", () => this.openStateModal());
    this.$("state-expand").addEventListener("click", () => this.openStateModal());
    this.$("sm-close").addEventListener("click", () => this.closeStateModal());
    this.$("state-modal").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) this.closeStateModal();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.modalOpen) this.closeStateModal();
    });
    this.$("sm-freeze").addEventListener("click", () => {
      this.modalFrozen = !this.modalFrozen;
      this.renderStateModal(this.modalFrozen ? this.modalShown : this.last);
    });
    this.$("sm-copy").addEventListener("click", async () => {
      if (!this.modalShown) return;
      const btn = this.$("sm-copy");
      try {
        await navigator.clipboard.writeText(JSON.stringify(this.modalShown.call[this.modalTab], null, 2));
        btn.textContent = "copied";
      } catch {
        btn.textContent = "copy failed";
      }
      setTimeout(() => (btn.textContent = "copy"), 1200);
    });
  }

  openStateModal() {
    this.modalOpen = true;
    this.modalFrozen = false;
    this.modalTab = "input";
    this.$("state-modal").classList.add("on");
    this.renderStateModal(this.last);
  }

  closeStateModal() {
    this.modalOpen = false;
    this.$("state-modal").classList.remove("on");
  }

  renderStateModal(shown) {
    this.modalShown = shown;
    for (const b of document.querySelectorAll("#state-modal [data-tab]")) b.classList.toggle("on", b.dataset.tab === this.modalTab);
    const freeze = this.$("sm-freeze");
    freeze.textContent = this.modalFrozen ? "resume" : "freeze";
    freeze.classList.toggle("on", this.modalFrozen);
    const pre = this.$("sm-json");
    const top = pre.scrollTop;
    pre.innerHTML = shown ? syntaxJSON(shown.call[this.modalTab], 2) : "waiting for Jev's first decision…";
    pre.scrollTop = top;
    this.$("sm-meta").textContent = !shown ? ""
      : [
          this.modalFrozen ? "FROZEN" : "LIVE",
          `${shown.usage?.input_tokens ?? "?"} tok`,
          `${Math.round(shown.latency)} ms`,
          shown.requestId,
        ].filter(Boolean).join(" · ");
  }

  buildTree() {
    const svg = this.$("tree");
    svg.innerHTML = "";
    const defs = el("defs", {}, svg);
    const glow = el("filter", { id: "glow", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
    el("feGaussianBlur", { stdDeviation: "3", result: "b" }, glow);
    const merge = el("feMerge", {}, glow);
    el("feMergeNode", { in: "b" }, merge);
    el("feMergeNode", { in: "SourceGraphic" }, merge);

    this.edgeEls = new Map();
    const edgeLayer = el("g", {}, svg);
    for (const [a, b, label] of EDGES) {
      const A = NODES[a], B = NODES[b];
      const x1 = A.x, y1 = A.y + A.h / 2;
      const x2 = B.x, y2 = B.y - B.h / 2;
      const my = (y1 + y2) / 2;
      const d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
      const g = el("g", { class: "edge" }, edgeLayer);
      el("path", { d, class: "edge-base" }, g);
      el("path", { d, class: "edge-flow" }, g);
      if (label) {
        const lx = (x1 + x2) / 2 + (x2 < x1 ? -8 : 8);
        const t = el("text", { x: lx, y: (y1 + y2) / 2 - 2, class: "edge-label", "text-anchor": "middle" }, g);
        t.textContent = label;
      }
      this.edgeEls.set(`${a}-${b}`, g);
    }

    this.nodeEls = new Map();
    const nodeLayer = el("g", {}, svg);
    for (const [id, n] of Object.entries(NODES)) {
      const g = el("g", { class: `node node-${n.kind}`, transform: `translate(${n.x - n.w / 2}, ${n.y - n.h / 2})` }, nodeLayer);
      const q = n.kind === "q";
      el("rect", { width: n.w, height: n.h, rx: q ? 7 : 6, class: "node-box" }, g);
      if (q) el("path", { d: "M 10 5 l 5 5 l -5 5 l -5 -5 z", class: "node-diamond" }, g);
      const title = el("text", { x: q ? 20 : n.w / 2, y: q ? 14 : n.kind === "act" ? 15 : n.h / 2 + 4, class: "node-title", "text-anchor": q ? "start" : "middle" }, g);
      title.textContent = n.title;
      const sub = el("text", { x: q ? 20 : n.w / 2, y: q ? 28 : 29, class: "node-sub", "text-anchor": q ? "start" : "middle" }, g);
      const extra = n.kind === "act" ? el("text", { x: n.w / 2, y: 39, class: "node-sub", "text-anchor": "middle" }, g) : null;
      // Question nodes get one bar per option, filled with Jev's probabilities.
      const bars = new Map();
      if (n.bars) {
        const x0 = 10, top = 36, h = 34;
        const bw = (n.w - 20) / n.bars.length;
        n.bars.forEach((opt, i) => {
          const x = x0 + i * bw + 1.5;
          el("rect", { x, y: top, width: bw - 3, height: h, class: "node-bar-bg", rx: 1.5 }, g);
          const b = el("rect", { x, y: top + h, width: bw - 3, height: 0, class: "opt-bar", rx: 1.5 }, g);
          el("text", { x: x + (bw - 3) / 2, y: top + h + 11, class: "opt-label", "text-anchor": "middle" }, g).textContent = n.labels[i];
          bars.set(opt, { b, top, h });
        });
      }
      this.nodeEls.set(id, { g, title, sub, extra, bars });
    }
  }

  setNode(id, sub, extra) {
    const e = this.nodeEls.get(id);
    e.sub.textContent = sub;
    if (e.extra && extra !== undefined) e.extra.textContent = extra;
  }

  // Fill a question node's option bars with Jev's probabilities; the chosen one lights up.
  setBars(id, answer) {
    for (const [opt, { b, top, h }] of this.nodeEls.get(id).bars) {
      const p = answer.probabilities?.[opt] ?? (opt === answer.choice ? 1 : 0);
      const bh = p > 0 ? Math.max(1, p * h) : 0;
      b.setAttribute("y", top + h - bh);
      b.setAttribute("height", bh);
      b.classList.toggle("chosen", opt === answer.choice);
    }
  }

  showDecision({ decision, answers, state, latency, call, model, usage, stats, requestId }) {
    const diving = decision.dive;
    const leaf = diving ? "dive_run" : "cruise";
    const path = new Set(["state", "turn", "dive", "yaw", leaf, "sticks"]);
    const edges = new Set(["state-turn", "state-dive", "turn-yaw", `dive-${leaf}`, "yaw-sticks", `${leaf}-sticks`]);
    for (const [id, e] of this.nodeEls) e.g.classList.toggle("active", path.has(id));
    for (const [id, e] of this.edgeEls) e.classList.toggle("active", edges.has(id));
    this.$("tree").dataset.branch = decision.branch;

    this.nodeEls.get("state").title.textContent =
      `STATE → JEV · goblin ${state.goblin.bearing} · ${state.goblin.below_horizon_deg}° below`;
    const { turn, dive } = answers;
    this.setNode("turn", `→ ${turn.choice}  ${pct(turn.probabilities?.[turn.choice])}`);
    this.setBars("turn", turn);
    this.setNode("dive", `→ ${dive.choice}  ${pct(dive.probabilities?.[dive.choice])}`);
    this.setBars("dive", dive);
    const dy = decision.yawDelta;
    this.setNode("yaw", dy === 0 ? "hold heading" : `turn ${Math.abs(dy)}° ${dy < 0 ? "left" : "right"}`, "yaw rate stick");
    this.setNode("cruise", "alt-hold 30 m", "~25 m/s");
    this.setNode("dive_run", diving ? `${decision.diveAngle}° down` : "—", "32 m/s");

    // Trail of recent branches
    this.trail.push(decision.branch);
    if (this.trail.length > 36) this.trail.shift();
    this.$("trail").innerHTML = this.trail
      .map((b) => `<i style="background:${BRANCH_COLORS[b] || "#666"}" title="${b}"></i>`)
      .join("");
    const branchEl = this.$("branch");
    branchEl.textContent = decision.branch;
    branchEl.style.color = BRANCH_COLORS[decision.branch] || "#fff";

    // Stats
    const avg = stats.latencies.reduce((x, y2) => x + y2, 0) / Math.max(1, stats.latencies.length);
    const elapsed = (performance.now() - stats.started) / 1000;
    const tt = stats.times;
    const hz = tt.length > 1 ? ((tt.length - 1) * 1000) / (tt[tt.length - 1] - tt[0]) : 0;
    const costPerHour = (stats.tokens / Math.max(1, elapsed)) * 3600 * (0.042 / 1e6);
    this.$("st-model").textContent = model || "jev";
    this.$("st-lat").textContent = `${Math.round(latency)} ms`;
    this.$("st-avg").textContent = `${Math.round(avg)} ms`;
    this.$("st-hz").textContent = `${hz.toFixed(1)}/s`;
    this.$("st-calls").textContent = stats.calls.toLocaleString();
    this.$("st-cost").textContent = `$${costPerHour.toFixed(2)}/h`;
    const nq = Object.keys(call.input.questions).length;
    this.$("st-q").textContent = `${nq} questions · 1 call · ${usage?.input_tokens ?? "?"} tok`;
    const req = this.$("st-req");
    req.textContent = requestId ? `${requestId.slice(0, 16)}…` : "";
    req.title = requestId ? `TypeSafe request id: ${requestId}` : "";
    this.drawLatency(stats.latencies);

    if (this.stateOpen) this.$("state-json").innerHTML = syntaxJSON(state);
    this.last = { call, usage, latency, requestId };
    if (this.modalOpen && !this.modalFrozen) this.renderStateModal(this.last);
    this.$("link").classList.remove("err");
    this.$("link").textContent = "LINK OK";
  }

  drawLatency(list) {
    const c = this.$("latency");
    const ctx = c.getContext("2d");
    const w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(400, ...list);
    ctx.strokeStyle = "rgba(54,226,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    list.forEach((v, i) => {
      const x = (i / 39) * w;
      const y = h - (v / max) * (h - 2) - 1;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }

  showError(msg) {
    const l = this.$("link");
    l.classList.add("err");
    l.textContent = "LINK ERROR";
    l.title = msg;
  }

  setStandby(html) {
    const el = this.$("standby");
    if (this._standby === html) return;
    this._standby = html;
    el.classList.toggle("on", !!html);
    el.innerHTML = html ? `<div>${html}</div>` : "";
  }

  setFailsafe(on) {
    this.$("failsafe").classList.toggle("on", on);
  }

  toast(text, kind = "info") {
    const d = document.createElement("div");
    d.className = `toast ${kind}`;
    d.textContent = text;
    this.messages.prepend(d);
    setTimeout(() => d.classList.add("out"), 3600);
    setTimeout(() => d.remove(), 4200);
    while (this.messages.children.length > 5) this.messages.lastChild.remove();
  }

  banner(text, sub = "") {
    const b = this.$("banner");
    b.innerHTML = `<div>${esc(text)}</div>${sub ? `<small>${esc(sub)}</small>` : ""}`;
    b.classList.remove("show");
    void b.offsetWidth;
    b.classList.add("show");
  }

  updateScore({ pops, resets, flyNum }) {
    this.$("sc-pops").textContent = pops;
    this.$("sc-resets").textContent = resets;
    this.$("sc-fly").textContent = `#${flyNum}`;
    this.$("sc-rate").textContent = pops + resets ? `${Math.round((100 * pops) / (pops + resets))}%` : "–";
  }

  updateFlight(fly, pilot) {
    if (!fly) return;
    const s = fly.sticks;
    const put = (id, x, y) => {
      const dot = this.$(id);
      dot.style.left = `${50 + x * 42}%`;
      dot.style.top = `${50 - y * 42}%`;
    };
    put("stick-l", s.yaw, s.throttle * 2 - 1);
    put("stick-r", s.roll, s.pitch);
    this.$("thr").textContent = `${Math.round(s.throttle * 100)}%`;
    this.$("flight-mode").textContent = fly.cmd.dive ? "ANGLE · DIVE" : pilot.failsafe ? "FAILSAFE" : "ANGLE · ALT HOLD";

    // FPV OSD
    const agl = fly.agl();
    this.$("osd-alt").textContent = `${agl.toFixed(0)}m`;
    this.$("osd-spd").textContent = `${(fly.vel.length() * 3.6).toFixed(0)}km/h`;
    this.$("osd-nectar").textContent = `NECTAR ${Math.round(fly.nectar)}%`;
    this.$("osd-nectar").classList.toggle("low", fly.nectar < 25);
    const t = Math.floor(fly.flightTime);
    this.$("osd-time").textContent = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    this.$("osd-energy-fill").style.width = `${fly.energy}%`;
    this.$("osd-hdg").textContent = `${Math.round(fly.headingDeg()).toString().padStart(3, "0")}°`;
    this.$("osd-horizon").style.transform = `translate(-50%, -50%) rotate(${-fly.roll / (Math.PI / 180)}deg) translateY(${(-fly.pitch / (Math.PI / 180)) * 1.2}px)`;
    this.setFailsafe(pilot.failsafe && fly.state === "flying");
  }

  // Screen-space brackets over the goblin.
  updateReticle(camera, goblin, from) {
    const r = this.$("reticle");
    const v = goblin?.alive ? goblin.center(new THREE.Vector3()).project(camera) : null;
    if (!v || v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) {
      r.style.display = "none";
      return;
    }
    const w = window.innerWidth, h = window.innerHeight;
    const dist = Math.hypot(goblin.x - from.x, goblin.z - from.z);
    const size = THREE.MathUtils.clamp(900 / Math.max(dist, 8), 16, 110);
    r.style.display = "block";
    r.style.transform = `translate(${(v.x * 0.5 + 0.5) * w - size / 2}px, ${(-v.y * 0.5 + 0.5) * h - size / 2}px)`;
    r.style.width = r.style.height = `${size}px`;
    r.classList.toggle("casting", !!goblin.castingAtFly);
    r.querySelector("label").textContent = `${goblin.label} · ${Math.round(dist)}m`;
  }

  drawMinimap(world, goblin, fly) {
    const c = this.minimap;
    const ctx = this.mctx;
    const W = c.width;
    const scale = W / ((PLAY_HALF + 20) * 2);
    const toX = (x) => (x + PLAY_HALF + 20) * scale;
    const toY = (z) => (z + PLAY_HALF + 20) * scale;
    if (!this.minimapBase) {
      const b = document.createElement("canvas");
      b.width = b.height = W;
      const bx = b.getContext("2d");
      bx.fillStyle = "rgba(20,32,20,0.9)";
      bx.fillRect(0, 0, W, W);
      for (const t of world.trees) {
        bx.fillStyle = t.kind === "pine" ? "rgba(60,120,60,0.9)" : "rgba(110,150,60,0.9)";
        bx.beginPath();
        bx.arc(toX(t.x), toY(t.z), Math.max(1.2, t.canopyR * scale), 0, Math.PI * 2);
        bx.fill();
      }
      bx.strokeStyle = "rgba(255,210,60,0.9)";
      bx.lineWidth = 1.5;
      bx.beginPath();
      bx.arc(toX(START_FLOWER.x), toY(START_FLOWER.z), 4, 0, Math.PI * 2);
      bx.stroke();
      bx.strokeStyle = "rgba(255,255,255,0.15)";
      bx.strokeRect(toX(-PLAY_HALF), toY(-PLAY_HALF), PLAY_HALF * 2 * scale, PLAY_HALF * 2 * scale);
      this.minimapBase = b;
    }
    ctx.clearRect(0, 0, W, W);
    ctx.drawImage(this.minimapBase, 0, 0);
    if (goblin) {
      if (fly?.alive && goblin.alive) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "rgba(255,120,40,0.9)";
        ctx.beginPath();
        ctx.moveTo(toX(fly.pos.x), toY(fly.pos.z));
        ctx.lineTo(toX(goblin.x), toY(goblin.z));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.save();
      ctx.translate(toX(goblin.x), toY(goblin.z));
      if (goblin.alive) {
        ctx.rotate(-goblin.heading);
        ctx.fillStyle = "#ff7a1a";
        ctx.fillRect(-3, -4, 6, 8);
      } else {
        ctx.fillStyle = `rgba(255,${120 + Math.random() * 80},30,0.9)`;
        ctx.beginPath();
        ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (fly && fly.alive) {
      ctx.save();
      ctx.translate(toX(fly.pos.x), toY(fly.pos.z));
      ctx.rotate(-fly.yaw);
      ctx.fillStyle = "#36e2ff";
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 5);
      ctx.lineTo(0, 2);
      ctx.lineTo(-5, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}

function syntaxJSON(obj, indent = 1) {
  const json = JSON.stringify(obj, null, indent);
  return esc(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = "num";
      if (/^"/.test(m)) cls = /:$/.test(m) ? "key" : "str";
      else if (/true|false/.test(m)) cls = "bool";
      return `<span class="${cls}">${m}</span>`;
    },
  );
}
