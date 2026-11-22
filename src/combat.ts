import type { SelfObs } from "../mechfight.ts"
import type { GameMap } from "./map.ts"
import type { Track } from "./world.ts"
import { angDiff, clamp, type V3 } from "./geom.ts"

export type Aim = { yaw: number; pitch: number; dist: number; pt: V3; sigma: number }

/** Scale factor of a mech with `cubes` power cubes. */
export const sizeOf = (cubes: number, perCube: number) => 1 + perCube * cubes

/** Center height offset of a target above its feet. */
export function centerOffset(tr: Track, perCube: number) {
  return tr.kind === "npc" ? 1.75 : 4.5 * sizeOf(tr.cubes, perCube)
}

/** Horizontal hit radius of a target. */
export function hitRadius(tr: Track, perCube: number) {
  return tr.kind === "npc" ? 1.6 : 2.5 * sizeOf(tr.cubes, perCube)
}

/**
 * Motion model learned from the track's recent velocities: current velocity, mean velocity over
 * the last second, and F, the typical time between direction changes (strafing period).
 */
export function motion(tr: Track): { vx: number; vy: number; mx: number; my: number; F: number } {
  const vx = tr.vel[0], vy = tr.vel[1]
  const h = tr.hist
  if (!h || h.length < 4) return { vx, vy, mx: vx, my: vy, F: 2 }
  const tNow = h[h.length - 1][0]
  let sx = 0, sy = 0, n = 0
  for (let k = h.length - 1; k >= 0 && tNow - h[k][0] <= 1.0; k--) (sx += h[k][1]), (sy += h[k][2]), n++
  let flips = 0
  let prev: [number, number, number] | null = null
  for (const s of h) {
    if (Math.hypot(s[1], s[2]) < 2) continue
    if (prev && s[1] * prev[1] + s[2] * prev[2] < -0.2 * Math.hypot(s[1], s[2]) * Math.hypot(prev[1], prev[2])) flips++
    prev = s
  }
  const span = Math.max(0.5, tNow - h[0][0])
  const F = clamp(span / (flips + 0.5), 0.35, 4)
  return { vx, vy, mx: sx / Math.max(1, n), my: sy / Math.max(1, n), F }
}

/**
 * Predicted feet position after `dt` s, and the spread (m) of that guess. A strafing target is
 * expected to keep its current velocity for about F seconds, then drift at its mean velocity.
 */
export function predict2(m: GameMap, tr: Track, dt: number, g: number): { p: V3; sigma: number } {
  const [px, py, pz] = tr.pos
  const vz = tr.vel[2]
  const mo = motion(tr)
  const k = mo.F * (1 - Math.exp(-dt / mo.F))
  const x = px + mo.vx * k + mo.mx * (dt - k)
  const y = py + mo.vy * k + mo.my * (dt - k)
  let z = pz
  if (Math.abs(vz) > 0.5) {
    z = pz + vz * dt - 0.5 * g * dt * dt
    const floor = m.surfAt(x, y)
    if (z < floor) z = floor
  } else {
    const s = m.surfAt(x, y)
    if (Math.abs(s - pz) < 2) z = s
  }
  const dev = Math.hypot(mo.vx - mo.mx, mo.vy - mo.my)
  const sigma = dev * (dt - k) * 0.6 + Math.hypot(mo.vx, mo.vy) * dt * 0.08 + 0.15
  return { p: [x, y, z], sigma }
}

/** Predicted feet position after `dt` seconds (compat). */
export function predict(m: GameMap, tr: Track, dt: number, g: number): V3 {
  return predict2(m, tr, dt, g).p
}

/** Aim at a point. */
export function aimAt(o: V3, p: V3, sigma = 0): Aim {
  const dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2]
  const h = Math.hypot(dx, dy)
  return { yaw: Math.atan2(dy, dx), pitch: Math.atan2(dz, h), dist: Math.hypot(h, dz), pt: p, sigma }
}

/** Lead a straight-flying projectile of `speed` from `o` onto track `tr`. */
export function leadAim(m: GameMap, o: V3, tr: Track, speed: number, latency: number, zOff: number, g: number): Aim {
  let tt = Math.hypot(tr.pos[0] - o[0], tr.pos[1] - o[1], tr.pos[2] + zOff - o[2]) / speed
  let r = predict2(m, tr, tt + latency, g)
  for (let k = 0; k < 3; k++) {
    r = predict2(m, tr, tt + latency, g)
    tt = Math.hypot(r.p[0] - o[0], r.p[1] - o[1], r.p[2] + zOff - o[2]) / speed
  }
  return aimAt(o, [r.p[0], r.p[1], r.p[2] + zOff], r.sigma)
}

/** Residual miss distance (m) of our actual aim against a desired aim, after `dt` s of slewing. */
export function missDist(me: SelfObs, a: Aim, dt: number): number {
  const tr = me.stats.turn_rate ?? 4, pr = me.stats.pitch_rate ?? 3
  const ey = Math.max(0, Math.abs(angDiff(a.yaw, me.aim[0])) - tr * dt)
  const ep = Math.max(0, Math.abs(a.pitch - me.aim[1]) - pr * dt)
  return Math.hypot(ey * Math.cos(a.pitch), ep) * a.dist
}

/** Probability that a shot with residual miss `mu`, spread `sigma` lands within `r` (1-D). */
export function hitProb(mu: number, sigma: number, r: number): number {
  const s = Math.max(0.05, sigma)
  return clamp(phi((r - mu) / s) - phi((-r - mu) / s), 0, 1)
}

function phi(z: number) {
  // standard normal CDF (Abramowitz-Stegun 7.1.26 via erf)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-(z * z) / 2)
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

export function clampPitch(me: SelfObs, p: number) {
  return clamp(p, me.stats.min_pitch ?? -0.7, me.stats.max_pitch ?? 1.3)
}

/** Landing point and time of a mortar shell (or null if it won't land within 8 s). */
export function shellLanding(m: GameMap, pos: V3, vel: V3, g: number): { x: number; y: number; z: number; t: number } | null {
  let [x, y, z] = pos
  let [vx, vy, vz] = vel
  const dt = 0.05
  for (let t = 0; t < 8; t += dt) {
    x += vx * dt
    y += vy * dt
    z += vz * dt - 0.5 * g * dt * dt
    vz -= g * dt
    if (vz < 0 && z <= m.surfAt(x, y)) return { x, y, z, t }
  }
  return null
}
