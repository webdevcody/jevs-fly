// Synthesized wing buzz, rushing wind, goblin hum and cheerful magic pops.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = false;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);
    this.flyGain = ctx.createGain();
    this.flyGain.gain.value = 0;
    this.flyGain.connect(this.master);
    this.flyOsc = ctx.createOscillator();
    this.flyOsc.type = "sawtooth";
    this.flyOsc.frequency.value = 160;
    const flyFilter = ctx.createBiquadFilter();
    flyFilter.type = "lowpass";
    flyFilter.frequency.value = 900;
    this.flyOsc.connect(flyFilter).connect(this.flyGain);
    this.flyOsc.start();
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windGain.connect(this.master);
    const wind = ctx.createBufferSource();
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    wind.buffer = buffer;
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "lowpass";
    windFilter.frequency.value = 500;
    wind.connect(windFilter).connect(this.windGain);
    wind.start();
    this.goblinGain = ctx.createGain();
    this.goblinGain.gain.value = 0;
    this.goblinGain.connect(this.master);
    this.goblinOsc = ctx.createOscillator();
    this.goblinOsc.type = "triangle";
    this.goblinOsc.frequency.value = 90;
    this.goblinOsc.connect(this.goblinGain);
    this.goblinOsc.start();
    this.enabled = true;
  }

  update(_dt, { camera, fly, goblin }) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    const speed = fly?.alive ? fly.vel.length() : 0;
    this.flyOsc.frequency.setTargetAtTime(135 + (fly?.wingPower || 0) * 420, t, 0.05);
    this.flyGain.gain.setTargetAtTime(fly?.alive ? 0.04 + fly.wingPower * 0.055 : 0, t, 0.1);
    this.windGain.gain.setTargetAtTime(0.01 + Math.min(0.055, speed * 0.001), t, 0.2);
    const dist = goblin?.alive ? camera.position.distanceTo(goblin.center()) : Infinity;
    this.goblinGain.gain.setTargetAtTime(Math.min(0.045, 0.045 * 30 / Math.max(30, dist)), t, 0.2);
  }

  chime(frequencies, duration = 0.35, volume = 0.12) {
    if (!this.enabled) return;
    const t = this.ctx.currentTime;
    for (let i = 0; i < frequencies.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = frequencies[i];
      const gain = this.ctx.createGain();
      const at = t + i * 0.055;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(volume, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
      osc.connect(gain).connect(this.master);
      osc.start(at);
      osc.stop(at + duration + 0.02);
    }
  }

  spell() { this.chime([620, 820], 0.2, 0.045); }
  sparkle() { this.chime([1100, 750], 0.16, 0.055); }
  pop(_pos, big = false) { this.chime(big ? [350, 530, 790, 1180] : [480, 720, 960], big ? 0.48 : 0.32, big ? 0.13 : 0.09); }
  blip(freq = 880, dur = 0.08) { this.chime([freq], dur, 0.08); }
}
