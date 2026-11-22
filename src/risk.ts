import type { SelfObs } from "../mechfight.ts"
import type { GameMap } from "./map.ts"
import type { Track, World } from "./world.ts"
import { angDiff, clamp } from "./geom.ts"

/** Tunable thresholds (defaults are the shipped values; BOTP env var overrides them in local tests). */
export const RP = {
  dangerTtd: 3.5,
  dangerAdv: 1.0,
  riskyTtd: 5,
  riskyAdv: 1.3,
  evadeDur: 2,
  outTtd: 3,
  outAdv: 1.2,
  regenLow: 0.5,
  regenLowMulti: 0.65,
  brawlAdv: 0.9,
  /** upgrade order override (empty = built-in lists) */
  upg: [] as string[],
  /** never drop the gun for a second special weapon */
  keepGun: false,
  /** minimum hit probability to pull the gun trigger / release the laser */
  gunNeed: 0.3,
  laserNeed: 0.8,
  /** refuse long laser duels when we hold lightning */
  doctrine: true,
  /** endgame: from this time on, no opportunistic fights or looting */
  lateT: 330,
  /** next-circle radius from which we move to the final area right away */
  lateRadius: 70,
  /** after a kill, heal up to this fraction before taking the next fight */
  healAfterKill: 0.9,
  /** camping: minimum trade advantage to open fire on a favourable target */
  campAdv: 1.5,
  /** use the v8 brain in practice too (A/B) */
  legacy: false,
  /** play the aggressive practice core in free-for-all too (instead of the ninja core) */
  ffaPractice: false,
  /** simulator only: treat every match as a free-for-all from the start */
  ffaForce: false,
  /** test only: keep the navigator state left by the warmup (the hops of v13 and before) */
  warmNav: false,
  /** extra salt for our RNG: the scorer is deterministic, so a new salt gives a new sample of the same strategy */
  salt: 0,
  /** opening move for the first openT seconds (see Navigator.openMode); "none" = plain start */
  openMode: "hop" as "none" | "hop" | "side" | "jet" | "boost",
  openT: 4,
  /** stop the opening move as soon as a mech hits us */
  openCancel: false,
  /** free-for-all brain: "ninja" (v8 camping) or "econ" (economy core with free-for-all engagement rules) */
  ffaCore: "econ" as "ninja" | "econ",
}
try {
  const env = typeof process !== "undefined" ? process.env.BOTP : undefined
  if (env) Object.assign(RP, JSON.parse(env))
} catch {}

export type Risk = {
  /** damage per second we take if we stay where we are */
  incoming: number
  /** time to death at that rate (s) */
  ttd: number
  /** our damage per second against the target */
  ourDps: number
  /** time to kill the target (s) */
  ttk: number
  /** ttd / ttk: > 1 means we win the trade */
  adv: number
  /** number of known mechs with a line of sight on us */
  exposedTo: number
  level: "safe" | "ok" | "risky" | "danger"
}

/** Expected damage per second a mech holding `weapons` deals to a target at distance d. */
export function weaponDps(weapons: string[], d: number, cubes: number, cfg: any): number {
  const W = cfg.weapons
  let dps = 0
  const gun = W.gun
  // gun accuracy against a strafing mech falls with distance
  if (weapons.includes("gun") && d <= gun.range) dps += (gun.damage / gun.cooldown) * (gun.mag * gun.cooldown) / (gun.mag * gun.cooldown + gun.reload) * clamp(1.15 - d / 160, 0.12, 0.85)
  if (weapons.includes("laser") && d <= W.laser.range) dps += (W.laser.damage / (W.laser.charge + W.laser.cooldown)) * 0.85
  if (weapons.includes("lightning") && d <= W.lightning.range) dps += (W.lightning.damage / W.lightning.cooldown) * 0.75
  if (weapons.includes("mortar") && d <= 230) dps += ((W.mortar.damage * 0.5 + W.mortar.splash * 0.5) / W.mortar.cooldown) * 0.35
  return dps * (1 + (cfg.cubes.damage_per_cube ?? 0.04) * Math.min(cubes, cfg.cubes.stat_cap ?? 10))
}

/** Risk of standing at (x, y) against everyone we know about, and of fighting `target`. */
export function assess(m: GameMap, w: World, me: SelfObs, x: number, y: number, target: Track | null, cfg: any, perCube: number): Risk {
  const z = me.pos[2]
  const s = (me.stats.radius ?? 2.5) / (cfg.mech.radius ?? 2.5)
  const t = w.t
  let incoming = 0
  let exposedTo = 0
  for (const e of w.tracks.values()) {
    if (e.kind !== "mech" || t - e.seenT > 2.5) continue
    const d = Math.hypot(e.pos[0] - x, e.pos[1] - y)
    if (d > 300) continue
    const es = 1 + perCube * e.cubes
    const ez = e.pos[2] + 8 * es
    if (!m.los(e.pos[0], e.pos[1], ez, x, y, z + 4.5 * s) && !m.los(e.pos[0], e.pos[1], ez, x, y, z + 8.5 * s)) continue
    exposedTo++
    // a laser that just fired is cooling down: it cannot hurt us for the next ~1.5 s
    const cooling = t - e.laserT < (cfg.weapons.laser.cooldown ?? 1.65) - 0.2 && !e.charging
    const ws = (e.weapons.length ? e.weapons : ["gun"]).filter((k) => !(cooling && k === "laser"))
    let dps = weaponDps(ws, d, e.cubes, cfg)
    // shots from outside our front arc hit harder
    if (Math.abs(angDiff(Math.atan2(e.pos[1] - y, e.pos[0] - x), me.aim[0])) > Math.PI / 2) dps *= cfg.mech.rear_mult ?? 1.5
    incoming += dps
  }
  // shooters we cannot see still count: use what we actually took recently as a floor
  incoming = Math.max(incoming, w.recentDamage(2) / 2)
  incoming *= 1 - (me.stats.armor ?? 0)
  const ttd = me.hp / Math.max(1, incoming)
  let ourDps = 0
  let ttk = Infinity
  if (target) {
    const d = Math.hypot(target.pos[0] - x, target.pos[1] - y)
    const held = me.weapons.filter(Boolean).map((wp) => wp!.kind)
    ourDps = weaponDps(held, d, me.cubes, cfg) * 1.1
    ttk = target.hp / Math.max(1, ourDps)
  }
  const adv = ttd / Math.max(0.1, ttk)
  let level: Risk["level"] = "safe"
  if (exposedTo > 0 || incoming > 1) {
    if (ttd < RP.dangerTtd || (target && adv < RP.dangerAdv)) level = "danger"
    else if (ttd < RP.riskyTtd || (target && adv < RP.riskyAdv) || exposedTo >= 2) level = "risky"
    else level = "ok"
  }
  return { incoming, ttd, ourDps, ttk, adv, exposedTo, level }
}
