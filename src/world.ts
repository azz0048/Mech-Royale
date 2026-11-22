import { RP } from "./risk.ts"
import type { Hello, Observation, WeaponKind } from "../mechfight.ts"
import type { GameMap } from "./map.ts"
import type { V2, V3 } from "./geom.ts"

export type Track = {
  id: number
  kind: "mech" | "npc"
  pos: V3
  vel: V3
  aim: V2
  hp: number
  maxHp: number
  cubes: number
  weapons: string[]
  charging: boolean
  /** last time it was in obs.mechs (seen or tracked by memory) */
  seenT: number
  firstT: number
  /** last time it damaged us */
  hitUsT: number
  /** last time we damaged it */
  hitByUsT: number
  /** last time we saw or felt it fire its laser */
  laserT: number
  /** recent horizontal velocities (t, vx, vy), newest last, ~2 s */
  hist: [number, number, number][]
  /** last time its HP dropped while we had not hit it (it is fighting someone else) */
  hurtByOtherT: number
}

export type Pickup = { id: number; kind: WeaponKind; pos: V3; seenT: number }
export type Crate = { id: number; pos: V3; hp: number; seenT: number }
export type Heard = { t: number; kind: string; bearing: number; dist: string }
export type Hurt = { t: number; amount: number; bearing: number | null; by: number | null; weapon: string; rear: boolean }

/** What we know about the match beyond the current observation. */
export class World {
  m: GameMap
  hello: Hello
  t = 0
  tracks = new Map<number, Track>()
  pickups = new Map<number, Pickup>()
  crates = new Map<number, Crate>()
  /** power cubes seen on the ground (persist until picked up or seen gone) */
  cubes = new Map<number, { id: number; pos: V3; seenT: number }>()
  /** where mechs we killed died: their cubes (+2) lie there */
  killSites: { pos: V3; t: number }[] = []
  ignorePickups = new Set<number>()
  heard: Heard[] = []
  hurt: Hurt[] = []
  lastHurtT = -99
  lastDealT = -99
  kills = 0
  mechCount: number
  mode: "unknown" | "practice" | "ffa" = "unknown"
  /** last time each mech id hit us, even before we ever saw it */
  hitBy = new Map<number, number>()
  obs!: Observation

  constructor(m: GameMap, hello: Hello) {
    this.m = m
    this.hello = hello
    this.mechCount = hello.config.match.mechs ?? 16
  }

  update(obs: Observation) {
    this.obs = obs
    const t = (this.t = obs.t)
    const me = obs.self
    for (const a of obs.mechs) {
      let tr = this.tracks.get(a.id)
      if (!tr) {
        tr = { id: a.id, kind: a.kind, pos: a.pos, vel: a.vel, aim: a.aim, hp: a.hp ?? 1, maxHp: a.max_hp ?? 1, cubes: a.cubes ?? 0, weapons: a.weapons ?? [], charging: !!a.charging, seenT: t, firstT: t, hitUsT: -99, hitByUsT: -99, laserT: -99, hist: [], hurtByOtherT: -99 }
        this.tracks.set(a.id, tr)
      }
      tr.pos = a.pos
      tr.vel = a.vel
      tr.aim = a.aim
      if (a.hp !== undefined) {
        const weHit = obs.events.some((ev) => ev.type === "hit" && ev.target === a.id)
        if (a.hp < tr.hp - 1 && !weHit && t - tr.hitByUsT > 0.6) tr.hurtByOtherT = t
        tr.hp = a.hp
      }
      if (a.max_hp !== undefined) tr.maxHp = a.max_hp
      tr.cubes = a.cubes ?? tr.cubes
      if (a.weapons) tr.weapons = a.weapons
      tr.charging = !!a.charging
      tr.seenT = t
      tr.hist.push([t, a.vel[0], a.vel[1]])
      while (tr.hist.length && t - tr.hist[0][0] > 2.05) tr.hist.shift()
    }
    for (const ev of obs.events) {
      switch (ev.type) {
        case "damaged": {
          if (ev.weapon === "zone") break
          this.lastHurtT = t
          this.hurt.push({ t, amount: ev.amount, bearing: ev.bearing, by: ev.by, weapon: ev.weapon, rear: !!ev.rear })
          if (ev.by !== null) {
            this.hitBy.set(ev.by, t)
            const tr = this.tracks.get(ev.by)
            if (tr) {
              tr.hitUsT = t
              if (ev.weapon === "laser") tr.laserT = t
            }
          }
          break
        }
        case "hit": {
          if (ev.target < 1000) {
            this.lastDealT = t
            const tr = this.tracks.get(ev.target)
            if (tr) tr.hitByUsT = t
          }
          break
        }
        case "kill": {
          this.kills++
          const tr = this.tracks.get(ev.target)
          if (tr) this.killSites.push({ pos: tr.pos, t })
          this.tracks.delete(ev.target)
          break
        }
        case "took":
          this.pickups.delete(ev.id)
          break
        case "dropped":
          this.ignorePickups.add(ev.id)
          break
        case "take_failed":
          if (ev.reason === "gone" || ev.reason === "have") this.pickups.delete(ev.id)
          if (ev.reason === "have") this.ignorePickups.add(ev.id)
          break
      }
    }
    // forget tracks not seen for a while
    for (const [id, tr] of this.tracks) if (t - tr.seenT > (tr.kind === "npc" ? 30 : 12)) this.tracks.delete(id)
    // loot memory
    const ex = me.pos[0], ey = me.pos[1], ez = me.pos[2] + (me.stats.eye_height ?? 8)
    const seenP = new Set<number>()
    for (const p of obs.pickups) {
      seenP.add(p.id)
      if (this.ignorePickups.has(p.id)) continue
      this.pickups.set(p.id, { id: p.id, kind: p.kind, pos: p.pos, seenT: t })
    }
    for (const [id, p] of this.pickups) {
      if (seenP.has(id)) continue
      const d = Math.hypot(p.pos[0] - ex, p.pos[1] - ey)
      if (d < 30 && this.m.los(ex, ey, ez, p.pos[0], p.pos[1], p.pos[2] + 0.8)) this.pickups.delete(id)
    }
    const seenC = new Set<number>()
    for (const c of obs.crates) {
      seenC.add(c.id)
      this.crates.set(c.id, { id: c.id, pos: c.pos, hp: c.hp ?? 300, seenT: t })
    }
    for (const [id, c] of this.crates) {
      if (seenC.has(id)) continue
      const d = Math.hypot(c.pos[0] - ex, c.pos[1] - ey)
      if (d < 30 && this.m.los(ex, ey, ez, c.pos[0], c.pos[1], c.pos[2] + 1.2)) this.crates.delete(id)
    }
    const seenCube = new Set<number>()
    for (const c of obs.cubes) {
      seenCube.add(c.id)
      this.cubes.set(c.id, { id: c.id, pos: c.pos, seenT: t })
    }
    for (const [id, c] of this.cubes) {
      if (seenCube.has(id)) continue
      const d = Math.hypot(c.pos[0] - ex, c.pos[1] - ey)
      if ((d < 30 && this.m.los(ex, ey, ez, c.pos[0], c.pos[1], c.pos[2] + 0.5)) || t - c.seenT > 120) this.cubes.delete(id)
    }
    // a kill site is done once we stood near it (cubes there are then in sight) or it is old
    this.killSites = this.killSites.filter((k) => t - k.t < 90 && Math.hypot(k.pos[0] - ex, k.pos[1] - ey) > 12)
    for (const b of obs.beams) {
      if (b.kind !== "laser") continue
      const tr = this.tracks.get(b.by)
      if (tr) tr.laserT = t - b.age
    }
    for (const s of obs.sounds) this.heard.push({ t: t - s.age, kind: s.kind, bearing: s.bearing, dist: s.dist })
    this.heard = this.heard.filter((h) => t - h.t < 4)
    this.hurt = this.hurt.filter((h) => t - h.t < 6)
    // practice (house squad, never fight each other) vs free-for-all
    const deadOthers = this.mechCount - obs.alive - this.kills
    // free-for-all shows early deaths we did not cause; practice house bots only die late (zone)
    if (RP.ffaForce) this.mode = "ffa"
    if (this.mode !== "ffa" && ((deadOthers >= 2 && t < 200) || (deadOthers >= 4 && t < 330))) this.mode = "ffa"
    else if (this.mode === "unknown" && t > 150 && deadOthers === 0) this.mode = "practice"
  }

  /** Enemy mechs currently in obs (seen or within memory). */
  liveMechs(): Track[] {
    const out: Track[] = []
    for (const tr of this.tracks.values()) if (tr.kind === "mech" && tr.seenT === this.t) out.push(tr)
    return out
  }

  liveNpcs(): Track[] {
    const out: Track[] = []
    for (const tr of this.tracks.values()) if (tr.kind === "npc" && tr.seenT === this.t) out.push(tr)
    return out
  }

  /** Damage taken in the last `s` seconds. */
  recentDamage(s: number): number {
    let a = 0
    for (const h of this.hurt) if (this.t - h.t <= s) a += h.amount
    return a
  }

  /** Zone circle at time `t` (linear shrink between shrink_start and shrink_end). */
  zoneAt(t: number): { c: V2; r: number } {
    const z = this.obs.zone
    if (t <= z.shrink_start) return { c: [z.center[0], z.center[1]], r: z.radius }
    if (t >= z.shrink_end) return { c: [z.next_center[0], z.next_center[1]], r: z.next_radius }
    const f = (t - z.shrink_start) / Math.max(1e-6, z.shrink_end - z.shrink_start)
    return {
      c: [z.center[0] + (z.next_center[0] - z.center[0]) * f, z.center[1] + (z.next_center[1] - z.center[1]) * f],
      r: z.radius + (z.next_radius - z.radius) * f,
    }
  }

  /** Distance inside the zone edge at time t (negative = outside). */
  zoneMargin(x: number, y: number, t: number): number {
    const z = this.zoneAt(t)
    return z.r - Math.hypot(x - z.c[0], y - z.c[1])
  }
}
