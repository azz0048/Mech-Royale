import type { GameMap } from "./map.ts"
import type { Track } from "./world.ts"
import type { V2 } from "./geom.ts"

export type PeekPlan = {
  /** spot hidden from the threats (null: none nearby) */
  hide: V2 | null
  /** spot near `hide` with a clear shot at the target (null: none) */
  peek: V2 | null
  /** is our current position hidden from all considered threats? */
  hiddenNow: boolean
  /** can we shoot the target from where we stand? */
  shotNow: boolean
  t: number
  tid: number
}

const RADII = [3, 6, 10, 15, 22, 30]
const DIRS = 16

/**
 * Cover planner: around our position, find the nearest spot hidden from the threats and a nearby
 * spot from which the target can be shot. Exposure is tested from each threat's eye to our center
 * and head; shots from our muzzle to the target center.
 */
export function planPeek(
  m: GameMap,
  x: number,
  y: number,
  rq: number,
  comp: Int32Array,
  myComp: number,
  threats: Track[],
  target: Track,
  scale: number,
  perCube: number,
  t: number,
  zoneOk: (px: number, py: number) => boolean,
): PeekPlan {
  const eyes = threats.map((e) => {
    const s = 1 + perCube * e.cubes
    return [e.pos[0], e.pos[1], e.pos[2] + 8 * s] as [number, number, number]
  })
  const ts = 1 + perCube * target.cubes
  const tc: [number, number, number] = [target.pos[0], target.pos[1], target.pos[2] + 4.5 * ts]
  const exposed = (px: number, py: number, pz: number) => {
    let n = 0
    for (const e of eyes) if (m.los(e[0], e[1], e[2], px, py, pz + 4.5 * scale) || m.los(e[0], e[1], e[2], px, py, pz + 8.5 * scale)) n++
    return n
  }
  const canShoot = (px: number, py: number, pz: number) => m.los(px, py, pz + 7 * scale, tc[0], tc[1], tc[2])
  const z0 = m.surfAt(x, y)
  const hiddenNow = exposed(x, y, z0) === 0
  const shotNow = canShoot(x, y, z0)
  // candidates
  type Cand = { x: number; y: number; d: number; exp: number; shot: boolean }
  const cands: Cand[] = [{ x, y, d: 0, exp: hiddenNow ? 0 : 1, shot: shotNow }]
  for (let k = 0; k < DIRS; k++) {
    const a = (k / DIRS) * Math.PI * 2
    const ca = Math.cos(a), sa = Math.sin(a)
    for (const r of RADII) {
      const px = x + ca * r, py = y + sa * r
      const n = m.nodeOf(px, py)
      if (!m.passable(n, rq) || (myComp >= 0 && comp[n] !== myComp)) continue
      if (!zoneOk(px, py)) continue
      if (r > 6 && !m.walkLine(x, y, px, py, rq)) continue
      const pz = m.surfAt(px, py)
      cands.push({ x: px, y: py, d: r, exp: exposed(px, py, pz), shot: canShoot(px, py, pz) })
    }
  }
  // hide: hidden from all threats, nearest; prefer spots farther from the target when tied
  let hide: Cand | null = null
  for (const c of cands) {
    if (c.exp !== 0) continue
    const sc = c.d - 0.05 * Math.hypot(c.x - tc[0], c.y - tc[1])
    if (!hide || sc < hide.d - 0.05 * Math.hypot(hide.x - tc[0], hide.y - tc[1])) hide = c
  }
  // peek: can shoot the target, few other exposures, close to hide
  let peek: Cand | null = null
  let ps = Infinity
  const hx = hide ? hide.x : x, hy = hide ? hide.y : y
  for (const c of cands) {
    if (!c.shot) continue
    const dh = Math.hypot(c.x - hx, c.y - hy)
    if (hide && dh > 12) continue
    const sc = dh + (c.exp - 1) * 6
    if (sc < ps) (ps = sc), (peek = c)
  }
  return { hide: hide ? [hide.x, hide.y] : null, peek: peek ? [peek.x, peek.y] : null, hiddenNow, shotNow, t, tid: target.id }
}

/**
 * Viewshed of one observer: which nav nodes a standing mech could be seen on (chest height), by
 * casting rays from the observer's eye and keeping the steepest obstacle so far. ~0.4 ms for 360
 * rays out to 220 m. `seen(n)` is valid until the next compute().
 */
export class Viewshed {
  m: GameMap
  stamp: Uint32Array
  gen = 0
  ex = 0
  ey = 0
  ez = 0
  t = -99
  constructor(m: GameMap) {
    this.m = m
    this.stamp = new Uint32Array(m.NW * m.NH)
  }
  compute(ex: number, ey: number, ez: number, t: number, rays = 360, maxR = 220) {
    const m = this.m, s = m.step, nx = m.nx, ny = m.ny
    this.gen++
    this.ex = ex
    this.ey = ey
    this.ez = ez
    this.t = t
    const gen = this.gen, st = this.stamp, nSurf = m.nSurf
    for (let k = 0; k < rays; k++) {
      const a = (k / rays) * Math.PI * 2
      const ca = Math.cos(a), sa = Math.sin(a)
      let smax = -Infinity
      for (let r = 2; r <= maxR; r += 2) {
        const px = ex + ca * r, py = ey + sa * r
        const i = Math.floor((px - m.minX) / s), j = Math.floor((py - m.minY) / s)
        if (i < 0 || j < 0 || i >= nx || j >= ny) break
        const n = m.nodeOf(px, py)
        if (n >= 0 && (nSurf[n] + 6 - ez) / r > smax) st[n] = gen
        const o = (m.topAt(j * nx + i) - ez) / r
        if (o > smax) smax = o
      }
    }
  }
  seen(n: number) {
    return n >= 0 && this.stamp[n] === this.gen
  }
}
