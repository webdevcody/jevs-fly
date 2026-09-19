// Terrain height field shared by rendering, physics, goblin wandering and the AI state.
import { createNoise2D } from "./noise.js";

export const MAP_SEED = 1337;
export const PLAY_HALF = 260; // playable area is [-PLAY_HALF, PLAY_HALF] on x and z
export const TERRAIN_SIZE = 1100;
export const START_FLOWER = { x: 0, z: 205 };

const n1 = createNoise2D(MAP_SEED);
const n2 = createNoise2D(MAP_SEED + 1);
const n3 = createNoise2D(MAP_SEED + 2);

function fbm(noise, x, z, octaves) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function terrainHeight(x, z) {
  let h = fbm(n1, x * 0.0042, z * 0.0042, 4) * 11 + 4;
  h += n2(x * 0.02, z * 0.02) * 0.8;

  // Rim of hills around the garden so the world never ends abruptly.
  const d = Math.max(Math.abs(x), Math.abs(z));
  const rim = smooth(PLAY_HALF + 10, PLAY_HALF + 220, d);
  h += rim * (45 + fbm(n3, x * 0.006, z * 0.006, 3) * 35);

  // Flatten the starting flower.
  const dp = Math.hypot(x - START_FLOWER.x, z - START_FLOWER.z);
  const padBlend = 1 - smooth(14, 40, dp);
  h = h * (1 - padBlend) + terrainBase(START_FLOWER.x, START_FLOWER.z) * padBlend;
  return h;
}

function terrainBase(x, z) {
  return fbm(n1, x * 0.0042, z * 0.0042, 4) * 11 + 4;
}

export function terrainNormal(x, z, out) {
  const e = 0.8;
  const hL = terrainHeight(x - e, z);
  const hR = terrainHeight(x + e, z);
  const hD = terrainHeight(x, z - e);
  const hU = terrainHeight(x, z + e);
  out.set(hL - hR, 2 * e, hD - hU).normalize();
  return out;
}

// Low-frequency "dirt" mask used for terrain coloring (soft soil and bare patches).
export function dirtAmount(x, z) {
  return smooth(0.35, 0.75, n3(x * 0.012, z * 0.012) * 0.5 + 0.5);
}

export const FLOWER_HEIGHT = terrainBase(START_FLOWER.x, START_FLOWER.z);
