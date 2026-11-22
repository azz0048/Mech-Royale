// Approximate kinematic sandbox: our Brain against a hunting squad on the real map.
// Not the real game: it is for finding stuck spots, zone deaths, firing bugs, timing, and for
// sanity-checking tactics. House bots here are guesses.
//   node tools/sim.ts [matches=8] [seed=1] [omniscient=0] [kit=../mechfight-kit]
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { Brain } from "../src/brain.ts"
import { GameMap } from "../src/map.ts"
import { Navigator } from "../src/nav.ts"
import { draw, type Observation } from "../mechfight.ts"
import { angDiff, rng, type V2, type V3 } from "../src/geom.ts"

const N_MATCH = Number(process.argv[2] ?? 8)
const SEED = Number(process.argv[3] ?? 1)
const OMNI = process.argv[4] === "1"
const KIT = process.argv[5] ?? "../mechfight-kit"
const VERBOSE = process.env.SIMV === "1"
// house strength 0..1 (aim error, laser share); calibrated so that v1 scores like the real board
const HARD = Number(process.env.SIMHARD ?? -0.5)
// SIMMODE=real: house bots modelled on the recorded hunter (laser snipers, precise aim) that must
// find us through squad vision; SIMERR adds aim error (rad), SIMOMNI=1 makes hunters omniscient
const REAL = process.env.SIMMODE === "real"
const REAL_ERR = Number(process.env.SIMERR ?? 0.02)
const REAL_OMNI = process.env.SIMOMNI === "1"
// SIMFFA=1: free-for-all, every house bot fights the nearest mech it sees (like qualifying/final)
const FFA = process.env.SIMFFA === "1" || !!process.env.SIMBOTS
// SIMBOTS=econ|practice|mix: the 15 opponents run our own cores (TTUN-like econ, Lance-like practice) in a free-for-all
const BOTS = process.env.SIMBOTS ?? ""
// SIMINVIS=s: measurement only, nobody sees us for the first s seconds
const INVIS = Number(process.env.SIMINVIS ?? 0)
// SIMCANOPY=0 turns off the tree crowns in vision (on by default: the server fades sight through dense crowns beyond near range)
const CANOPY = process.env.SIMCANOPY !== "0"
// SIMMODE=lance: house model of a public 4.75 bot's sim (all 15 hunt within a tier chase radius,
// tier fire ranges, aim noise per tier x SIMLF, lasers on the 3 experts)
const LANCE = process.env.SIMMODE === "lance"
const LF = Number(process.env.SIMLF ?? 1)
const SCHED = process.env.SIMSCHED === "1"
const L_NOISE = [4.0, 2.5, 1.3, 0.7], L_CHASE = [150, 260, 420, 1e9], L_RANGE = [110, 140, 170, 200]
const lines = gunzipSync(readFileSync(KIT + "/check/stream.jsonl.gz")).toString("utf8").trim().split("\n")
const HELLO = JSON.parse(lines[0])
HELLO.map.dir = KIT + "/arena"
const C = HELLO.config
const MAP = new GameMap(HELLO.map.dir)
const DT = 1 / C.match.tick_hz
const RQ = C.mech.radius + 0.9
const D2R = Math.PI / 180

type W = { kind: string; cooldown: number; ammo?: number; reload?: number; charge?: number; stats: Record<string, number> }
type Ent = { id: number; kind: "mech" | "npc" | "crate"; pos: V3; vel: V3; hp: number; maxHp: number; alive: boolean; radius: number; height: number; aim: V2 }
type Mech = Ent & {
  cmdAim: V2; energy: number; spendT: number; grounded: boolean; weapons: (W | null)[]; deathTick: number; cubes: number; armor: number
  lastCombatT: number; seen: Map<number, number>; brain: Brain | null; nav: Navigator | null
  move: V2; boost: boolean; jump: boolean; fire: [boolean, boolean]; skill: number; hunter: boolean; events: any[]; sounds: any[]
  offer: any; offersPending: number; upgrades: string[]; stats: Record<string, number>; hitByUsT: number; flipT: number; side: number
}
type Npc = Ent & { home: V2; target: number; cd: number; goal: V2 }
type Shot = { by: number; pos: V3; vel: V3; ttl: number; dmg: number; kind: string }

const mkWeapon = (kind: string): W => {
  const s = { ...C.weapons[kind] }
  return kind === "gun" ? { kind, cooldown: 0, ammo: s.mag, reload: 0, stats: s } : kind === "laser" ? { kind, cooldown: 0, charge: 0, stats: s } : { kind, cooldown: 0, stats: s }
}
const gauss = (R: () => number) => Math.sqrt(-2 * Math.log(R() + 1e-12)) * Math.cos(2 * Math.PI * R())

function zoneAt(phases: { c: V2; r: number; t0: number; t1: number; dps: number }[], t: number) {
  let prev = phases[0]
  for (let i = 1; i < phases.length; i++) {
    const p = phases[i]
    if (t < p.t0) return { c: prev.c, r: prev.r, dps: p.dps, next: p, prev }
    if (t < p.t1) {
      const f = (t - p.t0) / (p.t1 - p.t0)
      return { c: [prev.c[0] + (p.c[0] - prev.c[0]) * f, prev.c[1] + (p.c[1] - prev.c[1]) * f] as V2, r: prev.r + (p.r - prev.r) * f, dps: p.dps, next: p, prev }
    }
    prev = p
  }
  return { c: prev.c, r: prev.r, dps: 260, next: prev, prev }
}

function runMatch(seed: number) {
  const R = rng(seed)
  const t0wall = performance.now()
  const phases: { c: V2; r: number; t0: number; t1: number; dps: number }[] = [{ c: C.zone.start_center, r: C.zone.start_radius, t0: 0, t1: 0, dps: 0 }]
  let tt = 0
  for (const ph of C.zone.phases) {
    const prev = phases[phases.length - 1]
    let c: V2 = prev.c
    for (let k = 0; k < 40; k++) {
      const a = R() * Math.PI * 2, d = R() * (prev.r - ph.radius) * 0.9
      c = [prev.c[0] + Math.cos(a) * d, prev.c[1] + Math.sin(a) * d]
      const n = MAP.nodeOf(c[0], c[1])
      if (n >= 0 && MAP.nClear[n] > 4) break
    }
    phases.push({ c, r: ph.radius, t0: tt + ph.hold_s, t1: tt + ph.hold_s + ph.shrink_s, dps: ph.dps })
    tt += ph.hold_s + ph.shrink_s
  }
  const comp = MAP.comp(RQ)
  const ground = (minClear = RQ + 1, inR = C.zone.start_radius * 0.8): V3 => {
    for (;;) {
      const a = R() * Math.PI * 2, d = Math.sqrt(R()) * inR
      const x = C.zone.start_center[0] + Math.cos(a) * d, y = C.zone.start_center[1] + Math.sin(a) * d
      const n = MAP.nodeOf(x, y)
      if (n >= 0 && comp[n] === 0 && MAP.nClear[n] > minClear) return [x, y, MAP.surfAt(x, y)]
    }
  }
  const mechs: Mech[] = []
  for (let i = 0; i < 16; i++) {
    let pos = ground()
    for (let k = 0; k < 30 && mechs.some((o) => Math.hypot(o.pos[0] - pos[0], o.pos[1] - pos[1]) < 110); k++) pos = ground()
    const skill = i === 0 ? 1 : i <= 4 ? 0.3 : i <= 8 ? 0.5 : i <= 12 ? 0.7 : 0.9
    const m: Mech = {
      id: i, kind: "mech", pos, vel: [0, 0, 0], aim: [R() * 6.28 - 3.14, 0], cmdAim: [0, 0], hp: C.mech.hp, maxHp: C.mech.hp, alive: true, radius: C.mech.radius, height: C.mech.height,
      energy: C.mech.energy, spendT: -9, grounded: true, weapons: [mkWeapon("gun"), null], deathTick: 1e9, cubes: 0, armor: 0, lastCombatT: -99, seen: new Map(),
      brain: null, nav: i === 0 ? null : new Navigator(MAP), move: [0, 0], boost: false, jump: false, fire: [false, false], skill, hunter: false, events: [], sounds: [],
      offer: null, offersPending: 0, upgrades: [], stats: { ...C.mech }, hitByUsT: -99, flipT: 0, side: 1,
    }
    m.cmdAim = [...m.aim] as V2
    ;(m as any).tier = i <= 4 ? 0 : i <= 8 ? 1 : i <= 12 ? 2 : 3
    if (LANCE) {
      if (i >= 13) m.weapons[1] = mkWeapon("laser")
    } else if (REAL) {
      if (i > 0 && R() < 0.5 + skill * 0.5) m.weapons[1] = mkWeapon(R() < 0.75 ? "laser" : "lightning")
    } else if (i > 0 && R() < (0.2 + skill * 0.6) * (0.4 + HARD)) m.weapons[1] = mkWeapon(R() < 0.4 + 0.4 * HARD ? "laser" : "lightning")
    mechs.push(m)
  }
  mechs[0].brain = new Brain({ ...HELLO, slot: 0, seed: seed * 7 + 1 })
  ;(globalThis as any).__ECODBG = false
  if (BOTS)
    for (let i = 1; i < 16; i++) {
      const core = BOTS === "mix" ? (i % 2 ? "econ" : "practice") : (BOTS as "econ" | "practice")
      mechs[i].brain = new Brain({ ...HELLO, slot: i, seed: seed * 7 + 1 + i * 13 }, { map: MAP, core, noWarm: true })
    }
  const npcs: Npc[] = []
  for (let k = 0; k < C.npc.count; k++) {
    const p = ground(3)
    npcs.push({ id: 100 + k, kind: "npc", pos: p, vel: [0, 0, 0], hp: C.npc.hp, maxHp: C.npc.hp, alive: true, radius: C.npc.radius, height: C.npc.height, aim: [0, 0], home: [p[0], p[1]], target: -1, cd: 0, goal: [p[0], p[1]] })
  }
  const crates: Ent[] = []
  for (let k = 0; k < Math.round(C.crates.count * (1 - C.crates.roof_fraction)); k++) {
    const p = ground(3)
    crates.push({ id: 1000 + k, kind: "crate", pos: p, vel: [0, 0, 0], hp: C.crates.hp, maxHp: C.crates.hp, alive: true, radius: C.crates.radius, height: C.crates.height, aim: [0, 0] })
  }
  const pickups: { id: number; kind: string; pos: V3 }[] = []
  let pid = 8000
  for (let k = 0; k < Math.round(C.loot.floor_count * (1 - C.loot.floor_roof_fraction)); k++) pickups.push({ id: pid++, kind: ["laser", "lightning", "mortar"][Math.floor(R() * 3)], pos: ground(3) })
  const cubes: { id: number; pos: V3 }[] = []
  let cid = 5000
  const dropCubes = (p: V3, n: number) => {
    for (let k = 0; k < n; k++) cubes.push({ id: cid++, pos: [p[0] + gauss(R), p[1] + gauss(R), p[2]] })
  }
  let shots: Shot[] = []
  const drops: { id: number; pos: V3; landT: number; holder: number | null; progress: number; taken: boolean }[] = []
  const times: number[] = []
  let late = 0
  const st = { lzShots: 0, lzHits: 0, ltShots: 0, ltHits: 0, byHunter: 0, byOther: 0, byNpc: 0, shots: 0, hits: 0, dealt: 0, taken: 0, zoneDmg: 0, kills: 0, npcKills: 0, crates: 0, cubes: 0, drops: 0, stuck: 0 }
  const stateTicks = new Map<string, number>()
  let squadSeen = { t: -99, pos: [0, 0, 0] as V3 }
  let tick = 0
  let lastPos: V3 = [...mechs[0].pos] as V3
  let lastMoveT = 0
  const aliveMechs = () => mechs.filter((m) => m.alive)
  const targets = (): Ent[] => [...mechs.filter((m) => m.alive), ...npcs.filter((n) => n.alive), ...crates.filter((c) => c.alive)]
  const dmgMul = (m: Mech) => 1 + C.cubes.damage_per_cube * Math.min(m.cubes, C.cubes.stat_cap)

  const damage = (target: Ent, amount: number, by: Mech | Npc | null, weapon: string, from: V3 | null, t: number) => {
    if (!target.alive) return
    let rear = false
    if (target.kind === "mech") {
      const tm = target as Mech
      if (from) {
        const b = Math.atan2(from[1] - tm.pos[1], from[0] - tm.pos[0])
        if (Math.abs(angDiff(b, tm.aim[0])) > (C.mech.front_arc_deg / 2) * D2R) (amount *= C.mech.rear_mult), (rear = true)
      }
      if (weapon !== "zone") amount *= 1 - tm.armor
      tm.lastCombatT = t
      if (by?.id === 0) tm.hitByUsT = t
      const bearing = from ? Math.atan2(from[1] - tm.pos[1], from[0] - tm.pos[0]) : null
      tm.events.push({ type: "damaged", amount, weapon, bearing, by: by ? by.id : null, ...(rear && { rear }) })
      if (VERBOSE && tm.id === 0 && weapon !== "zone") console.log(`  ${t.toFixed(1)} hit by ${by?.id} (${(by as any)?.hunter ? "hunter" : "other"} skill ${(by as any)?.skill}) ${weapon} ${amount.toFixed(0)}${rear ? " REAR" : ""} d=${by ? Math.hypot(by.pos[0] - tm.pos[0], by.pos[1] - tm.pos[1]).toFixed(0) : "-"} hp=${tm.hp.toFixed(0)}`)
      if (tm.id === 0) (weapon === "zone" ? (st.zoneDmg += amount) : (st.taken += amount))
      if (tm.id === 0 && by) {
        if (by.kind === "npc") st.byNpc += amount
        else if ((by as Mech).hunter) st.byHunter += amount
        else st.byOther += amount
      }
    }
    if (by && by.kind === "mech") {
      ;(by as Mech).lastCombatT = t
      if ((by as Mech).brain) (by as Mech).events.push({ type: "hit", target: target.id, amount, weapon })
      if (by.id === 0) st.dealt += amount
    }
    if (target.kind === "npc" && by) (target as Npc).target = by.id
    target.hp -= amount
    if (target.hp <= 0) {
      target.alive = false
      if (target.kind === "mech") {
        const tm = target as Mech
        tm.deathTick = tick
        dropCubes(tm.pos, tm.cubes + C.cubes.death_drop_extra)
        for (const w of tm.weapons) if (w && w.kind !== "gun") pickups.push({ id: pid++, kind: w.kind, pos: [...tm.pos] as V3 })
        if (by && by.kind === "mech") {
          ;(by as Mech).events.push({ type: "kill", target: tm.id })
          if (by.id === 0) st.kills++
        }
      } else if (target.kind === "npc") {
        dropCubes(target.pos, C.npc.cubes)
        if (by?.id === 0) st.npcKills++
      } else {
        dropCubes(target.pos, C.crates.cubes)
        if (R() < C.loot.crate_weapon_chance) pickups.push({ id: pid++, kind: ["laser", "lightning", "mortar"][Math.floor(R() * 3)], pos: [...target.pos] as V3 })
        if (by?.id === 0) st.crates++
      }
    }
  }
  const sees = (a: Mech, b: Ent) => {
    if (b.id === 0 && a.id !== 0 && tick * DT < INVIS) return false
    const d = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1])
    if (d > C.vision.range) return false
    if (d > C.vision.near_range && Math.abs(angDiff(Math.atan2(b.pos[1] - a.pos[1], b.pos[0] - a.pos[0]), a.aim[0])) > (C.vision.fov_deg / 2) * D2R) return false
    const ez = a.pos[2] + 8
    if (CANOPY) return MAP.sees(a.pos[0], a.pos[1], ez, b.pos[0], b.pos[1], b.pos[2] + b.height / 2, C.vision.near_range) || MAP.sees(a.pos[0], a.pos[1], ez, b.pos[0], b.pos[1], b.pos[2] + b.height, C.vision.near_range)
    return MAP.los(a.pos[0], a.pos[1], ez, b.pos[0], b.pos[1], b.pos[2] + b.height / 2) || MAP.los(a.pos[0], a.pos[1], ez, b.pos[0], b.pos[1], b.pos[2] + b.height)
  }
  const sound = (src: V3, kind: string, except: number) => {
    const range = C.sound.range[kind] ?? 100
    for (const o of mechs) {
      if (o.id === except || !o.alive) continue
      const d = Math.hypot(o.pos[0] - src[0], o.pos[1] - src[1])
      if (d > range) continue
      o.sounds.push({ kind, bearing: Math.atan2(src[1] - o.pos[1], src[0] - o.pos[0]) + gauss(R) * 7 * D2R, dist: d < 60 ? "near" : d < 160 ? "mid" : "far", age: 0 })
    }
  }
  const fireLaser = (m: Mech, w: W, muz: V3, dir: V3, t: number) => {
    const frac = Math.min(1, w.charge! / w.stats.charge)
    const dmg = w.stats.damage * (w.stats.min_frac + (1 - w.stats.min_frac) * frac) * dmgMul(m)
    w.charge = 0
    w.cooldown = w.stats.cooldown
    sound(m.pos, "laser", m.id)
    let best: Ent | null = null, bt = Infinity
    for (const o of targets()) {
      if (o === m) continue
      const tt = rayCyl(muz, dir, o.pos, o.radius, o.height)
      if (tt !== null && tt < bt && tt < w.stats.range) (bt = tt), (best = o)
    }
    const ok = best && MAP.los(muz[0], muz[1], muz[2], muz[0] + dir[0] * bt, muz[1] + dir[1] * bt, muz[2] + dir[2] * bt)
    if (m.id === 0) (st.lzShots++, ok && best!.kind === "mech" && st.lzHits++)
    if (ok) damage(best!, dmg, m, "laser", m.pos, t)
  }

  // ---- main loop ----
  while (tick < C.match.duration_s * C.match.tick_hz) {
    const t = tick * DT
    const live = aliveMechs()
    const me = mechs[0]
    if (live.length <= 1 || !me.alive) break
    const Z = zoneAt(phases, t)
    const house = live.filter((m) => m.id !== 0)
    const nHunt = LANCE && !SCHED ? 99 : LANCE ? 1 + st.kills + (t > 120 ? 2 : 0) + (t > 240 ? 99 : 0) : t > 300 ? 99 : 1 + (15 - house.length)
    house.sort((a, b) => a.skill - b.skill || a.id - b.id)
    house.forEach((m, k) => (m.hunter = k < nHunt))
    if (tick % C.match.decide_every === 0) {
      for (const m of live) for (const o of live) if (o !== m && sees(m, o)) m.seen.set(o.id, t)
      for (const h of house) if (h.seen.get(0) === t) squadSeen = { t, pos: [...me.pos] as V3 }
      for (const m of live) {
        if (m.brain) {
          const obs = buildObs(m, t, Z, live, npcs, crates, pickups, cubes, shots, drops, tick)
          const t0 = performance.now()
          ;(globalThis as any).__ECODBG = process.env.SIMECODBG === "1" && m.id === 0
          const a = m.brain.act(obs)
          ;(globalThis as any).__ECODBG = false
          const ms = performance.now() - t0
          if (m.id === 0) {
            times.push(ms)
            if (ms > 50) late++
            stateTicks.set(m.brain.state, (stateTicks.get(m.brain.state) ?? 0) + 1)
          }
          if (VERBOSE && m.id === 0 && tick % 40 === 0) console.log(t.toFixed(0), m.brain.state, "hp", m.hp.toFixed(0), "pos", m.pos.map((v) => v.toFixed(0)).join(","), "w", m.weapons.map((w) => w?.kind ?? "-").join("+"), "cubes", m.cubes, "alive", live.length)
          draw.clear()
          m.move = (a.move as V2) ?? [0, 0]
          m.boost = !!a.boost
          m.jump = !!a.jump
          if (a.aim) m.cmdAim = a.aim as V2
          m.fire = (a.fire as [boolean, boolean]) ?? [false, false]
          if (a.pick !== undefined && m.offer) applyUpgrade(m, m.offer.choices[a.pick]?.id)
          if (a.take !== undefined) take(m, a.take, a.drop)
        } else if (FFA) {
          // nearest mech it currently sees (anyone), else roam to the zone
          let tgt: Mech | null = null, bd = Infinity
          for (const o of live) {
            if (o === m || m.seen.get(o.id) !== t) continue
            const d = Math.hypot(o.pos[0] - m.pos[0], o.pos[1] - m.pos[1])
            if (d < bd) (bd = d), (tgt = o)
          }
          m.hunter = true
          if (tgt) houseAct(m, t, Z, tgt, { t, pos: tgt.pos }, R)
          else houseAct(m, t, Z, m, { t: -99, pos: m.pos }, R)
        } else houseAct(m, t, Z, me, OMNI || (m.hunter && (!REAL || REAL_OMNI)) ? { t, pos: me.pos } : squadSeen, R)
      }
      for (const n of npcs) if (n.alive) npcAct(n, t)
    }
    // physics + weapons
    for (const m of live) {
      const dyaw = angDiff(m.cmdAim[0], m.aim[0])
      const my = m.stats.turn_rate * DT
      m.aim[0] = angDiff(m.aim[0] + Math.max(-my, Math.min(my, dyaw)), 0)
      const dp = Math.max(C.mech.min_pitch, Math.min(C.mech.max_pitch, m.cmdAim[1])) - m.aim[1]
      m.aim[1] += Math.max(-C.mech.pitch_rate * DT, Math.min(C.mech.pitch_rate * DT, dp))
      const charging = m.weapons.some((w) => w?.kind === "laser" && (w.charge ?? 0) > 0)
      let ml = Math.hypot(m.move[0], m.move[1])
      const mv: V2 = ml > 1 ? [m.move[0] / ml, m.move[1] / ml] : [m.move[0], m.move[1]]
      ml = Math.min(1, ml)
      let speed = C.mech.walk_speed
      let spend = false
      if (m.boost && m.grounded && ml > 0.1 && m.energy > 0) (speed = C.mech.boost_speed), (m.energy -= C.mech.boost_drain * DT), (spend = true)
      if (charging) speed *= C.mech.charge_move_mult
      const acc = (m.grounded ? C.mech.ground_accel : C.mech.air_accel) * DT
      let dvx = mv[0] * speed - m.vel[0], dvy = mv[1] * speed - m.vel[1]
      const dl = Math.hypot(dvx, dvy)
      if (dl > acc) (dvx *= acc / dl), (dvy *= acc / dl)
      m.vel[0] += dvx
      m.vel[1] += dvy
      if (m.jump && m.grounded) (m.vel[2] = C.mech.jump_speed), (m.grounded = false)
      if (m.boost && !m.grounded && m.energy > 0) {
        m.vel[2] = Math.min(C.mech.max_rise_speed, m.vel[2] + C.mech.jet_accel * DT)
        m.energy -= C.mech.jet_drain * DT
        spend = true
      }
      if (spend) m.spendT = t
      else if (t - m.spendT > C.mech.energy_regen_delay) m.energy = Math.min(C.mech.energy, m.energy + C.mech.energy_regen * DT)
      m.energy = Math.max(0, m.energy)
      m.vel[2] -= C.mech.gravity * DT
      let nx = m.pos[0] + m.vel[0] * DT, ny = m.pos[1] + m.vel[1] * DT
      if (blocked(nx, ny, m.pos[2])) {
        if (!blocked(nx, m.pos[1], m.pos[2])) (ny = m.pos[1]), (m.vel[1] = 0)
        else if (!blocked(m.pos[0], ny, m.pos[2])) (nx = m.pos[0]), (m.vel[0] = 0)
        else (nx = m.pos[0]), (ny = m.pos[1]), (m.vel[0] = 0), (m.vel[1] = 0)
      }
      // mechs push apart
      for (const o of live) {
        if (o === m) continue
        const dx = nx - o.pos[0], dy = ny - o.pos[1], d = Math.hypot(dx, dy)
        if (d < m.radius * 2 && d > 0.01 && !blocked(nx + (dx / d) * 0.3, ny + (dy / d) * 0.3, m.pos[2])) (nx += (dx / d) * 0.3), (ny += (dy / d) * 0.3)
      }
      let nz = m.pos[2] + m.vel[2] * DT
      const floor = MAP.surfAt(nx, ny)
      if (nz <= floor) (nz = floor), (m.vel[2] = 0), (m.grounded = true)
      else m.grounded = nz - floor < 0.05
      m.pos = [nx, ny, nz]
      for (let s = 0; s < 2; s++) {
        const w = m.weapons[s]
        if (!w) continue
        w.cooldown = Math.max(0, w.cooldown - DT)
        const trig = m.fire[s]
        const muz: V3 = [m.pos[0], m.pos[1], m.pos[2] + 7]
        const dir: V3 = [Math.cos(m.aim[1]) * Math.cos(m.aim[0]), Math.cos(m.aim[1]) * Math.sin(m.aim[0]), Math.sin(m.aim[1])]
        if (w.kind === "gun") {
          if ((w.reload ?? 0) > 0) {
            w.reload! -= DT
            if (w.reload! <= 0) (w.reload = 0), (w.ammo = w.stats.mag)
          } else if (trig && w.cooldown <= 0 && (w.ammo ?? 0) > 0) {
            const sp = w.stats.spread_deg * D2R
            const ya = m.aim[0] + gauss(R) * sp, pa = m.aim[1] + gauss(R) * sp
            const d: V3 = [Math.cos(pa) * Math.cos(ya), Math.cos(pa) * Math.sin(ya), Math.sin(pa)]
            shots.push({ by: m.id, pos: [muz[0] + d[0] * 3, muz[1] + d[1] * 3, muz[2] + d[2] * 3], vel: [d[0] * w.stats.speed, d[1] * w.stats.speed, d[2] * w.stats.speed], ttl: w.stats.range / w.stats.speed, dmg: w.stats.damage * dmgMul(m), kind: "gun" })
            w.cooldown = w.stats.cooldown
            w.ammo!--
            if (m.id === 0) st.shots++
            sound(m.pos, "gun", m.id)
            if (w.ammo === 0) w.reload = w.stats.reload
          }
        } else if (w.kind === "laser") {
          if (w.cooldown > 0) w.charge = 0
          else if (trig) {
            w.charge = (w.charge ?? 0) + DT
            if (w.charge >= w.stats.charge + w.stats.hold_s) fireLaser(m, w, muz, dir, t)
          } else if ((w.charge ?? 0) >= w.stats.min_charge) fireLaser(m, w, muz, dir, t)
          else if ((w.charge ?? 0) > 0) w.charge! += DT
        } else if (w.kind === "lightning") {
          if (trig && w.cooldown <= 0 && m.energy >= w.stats.energy) {
            m.energy -= w.stats.energy
            m.spendT = t
            w.cooldown = w.stats.cooldown
            let best: Ent | null = null, bd = Infinity
            for (const o of targets()) {
              if (o === m) continue
              const d = Math.hypot(o.pos[0] - m.pos[0], o.pos[1] - m.pos[1])
              if (d < w.stats.range && d < bd && Math.abs(angDiff(Math.atan2(o.pos[1] - m.pos[1], o.pos[0] - m.pos[0]), m.aim[0])) < (w.stats.cone_deg / 2) * D2R && MAP.los(muz[0], muz[1], muz[2], o.pos[0], o.pos[1], o.pos[2] + o.height / 2)) (bd = d), (best = o)
            }
            if (m.id === 0) (st.ltShots++, best && best.kind === "mech" && st.ltHits++)
            if (best) damage(best, w.stats.damage * dmgMul(m), m, "lightning", m.pos, t)
            sound(m.pos, "lightning", m.id)
          }
        }
      }
    }
    // projectiles
    const next: Shot[] = []
    for (const s of shots) {
      const np: V3 = [s.pos[0] + s.vel[0] * DT, s.pos[1] + s.vel[1] * DT, s.pos[2] + s.vel[2] * DT]
      let hit = false
      for (const o of targets()) {
        if (o.id === s.by) continue
        if (segCyl(s.pos, np, o.pos, o.radius, o.height)) {
          const by = s.by < 100 ? mechs[s.by] : npcs.find((n) => n.id === s.by) ?? null
          damage(o, s.dmg, by, s.kind, s.pos, t)
          if (s.by === 0 && o.kind === "mech") st.hits++
          hit = true
          break
        }
      }
      if (hit || !MAP.los(s.pos[0], s.pos[1], s.pos[2], np[0], np[1], np[2])) continue
      s.pos = np
      s.ttl -= DT
      if (s.ttl > 0) next.push(s)
    }
    shots = next
    // cubes
    for (let k = cubes.length - 1; k >= 0; k--) {
      const c = cubes[k]
      let best: Mech | null = null, bd = C.cubes.pickup_radius
      for (const m of live) {
        const d = Math.hypot(m.pos[0] - c.pos[0], m.pos[1] - c.pos[1])
        if (d <= bd && Math.abs(m.pos[2] - c.pos[2]) < 4) (bd = d), (best = m)
      }
      if (best) {
        cubes.splice(k, 1)
        gainCubes(best, 1)
        best.events.push({ type: "pickup", cubes: best.cubes })
        if (best.id === 0) st.cubes++
      }
    }
    // supply drops
    for (const dt of C.drops?.times ?? []) {
      if (Math.abs(t - dt) < DT / 2) {
        for (let k = 0; k < 50; k++) {
          const a = R() * Math.PI * 2, d = Math.sqrt(R()) * Z.next.r * C.drops.spread
          const x = Z.next.c[0] + Math.cos(a) * d, y = Z.next.c[1] + Math.sin(a) * d
          const n = MAP.nodeOf(x, y)
          if (n >= 0 && MAP.nClear[n] > 6) {
            drops.push({ id: 20000 + drops.length, pos: [x, y, MAP.surfAt(x, y)], landT: t + C.drops.fall_s, holder: null, progress: 0, taken: false })
            break
          }
        }
      }
    }
    for (const d of drops) {
      if (d.taken || t < d.landT) continue
      const inRing = aliveMechs().filter((m) => Math.hypot(m.pos[0] - d.pos[0], m.pos[1] - d.pos[1]) <= C.drops.radius)
      if (inRing.length === 1) {
        if (d.holder !== inRing[0].id) (d.holder = inRing[0].id), (d.progress = 0)
        d.progress += DT
        if (d.progress >= C.drops.capture_s) {
          const m = inRing[0]
          d.taken = true
          gainCubes(m, C.drops.cubes)
          m.hp = m.maxHp
          m.energy = C.mech.energy
          m.events.push({ type: "drop", id: d.id, cubes: m.cubes })
          if (m.id === 0) st.drops++
        }
      } else if (inRing.length === 0) (d.holder = null), (d.progress = 0)
    }
    // zone + regen
    for (const m of aliveMechs()) {
      if (Math.hypot(m.pos[0] - Z.c[0], m.pos[1] - Z.c[1]) > Z.r) damage(m, Z.dps * DT, null, "zone", null, t)
      else if (t - m.lastCombatT > m.stats.regen_delay) m.hp = Math.min(m.maxHp, m.hp + m.stats.regen_per_s * DT)
    }
    if (Math.hypot(me.pos[0] - lastPos[0], me.pos[1] - lastPos[1]) > 1) (lastPos = [...me.pos] as V3), (lastMoveT = t)
    else if (Math.hypot(me.move[0], me.move[1]) > 0.5 && t - lastMoveT > 2) st.stuck++
    tick++
  }
  const me = mechs[0]
  if (process.env.SIMDBG === "1")
    for (const m of mechs) console.log(`  #${m.id} ${m.brain ? (m.brain as any).forceCore || "us" : "house"} alive=${m.alive} death=${m.alive ? "-" : (m.deathTick * DT).toFixed(0)} hp=${m.hp.toFixed(0)} w=${m.weapons.map((w) => w?.kind ?? "-").join("+")} cubes=${m.cubes} upg=${m.upgrades.join(",")} state=${m.brain?.state ?? ""}`)
  const deadBefore = mechs.filter((m) => m.id !== 0 && !m.alive && m.deathTick < me.deathTick).length
  const place = me.alive ? 1 + mechs.filter((m) => m.id !== 0 && m.alive && m.hp > me.hp).length : 16 - deadBefore
  times.sort((a, b) => a - b)
  const topStates = [...stateTicks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}:${v}`).join(" ")
  return {
    seed, place, score: 16 - place, t: Math.round(tick * DT), alive: me.alive, ...st, dealt: Math.round(st.dealt), taken: Math.round(st.taken), byHunter: Math.round(st.byHunter), byOther: Math.round(st.byOther), byNpc: Math.round(st.byNpc), zoneDmg: Math.round(st.zoneDmg),
    p99: times[Math.floor(times.length * 0.99)]?.toFixed(1), max: times[times.length - 1]?.toFixed(1), late, wall: ((performance.now() - t0wall) / 1000).toFixed(1),
    weapons: me.weapons.map((w) => w?.kind ?? "-").join("+"), cubesNow: me.cubes, mode: (me.brain as any)?.w?.mode, upg: me.upgrades.join(","), states: topStates,
  }

  function gainCubes(m: Mech, n: number) {
    for (let k = 0; k < n; k++) {
      m.cubes++
      if (m.cubes <= C.cubes.stat_cap) {
        const add = C.mech.hp * C.cubes.hp_per_cube
        m.maxHp += add
        m.hp += add
      }
      if (C.cubes.upgrade_thresholds.includes(m.cubes)) m.offersPending++
    }
    if (m.brain && !m.offer && m.offersPending > 0) newOffer(m)
  }
  function newOffer(m: Mech) {
    const ok = C.upgrades.filter((u: any) => (!u.requires || m.weapons.some((w) => w?.kind === u.requires)) && m.upgrades.filter((x) => x === u.id).length < u.max)
    const choices = []
    while (choices.length < 3 && ok.length) choices.push(ok.splice(Math.floor(R() * ok.length), 1)[0])
    m.offer = { id: tick, expires: tick * DT + 5, choices: choices.map((u: any) => ({ id: u.id, name: u.name, desc: u.desc })) }
    m.offersPending--
  }
  function applyUpgrade(m: Mech, id: string | undefined) {
    if (!id) return
    m.upgrades.push(id)
    m.events.push({ type: "upgrade", id })
    if (id === "plating") (m.maxHp *= 1.15), (m.hp *= 1.15)
    if (id === "armor") m.armor += 0.08
    if (id === "nanites") (m.stats.regen_per_s *= 1.6), (m.stats.regen_delay -= 1.5)
    if (id === "gyros") m.stats.turn_rate *= 1.3
    if (id === "laser_damage") for (const w of m.weapons) if (w?.kind === "laser") w.stats.damage *= 1.18
    if (id === "laser_charge") for (const w of m.weapons) if (w?.kind === "laser") w.stats.charge *= 0.75
    m.offer = null
    if (m.offersPending > 0) newOffer(m)
  }
  function take(m: Mech, id: number, drop: number | undefined) {
    const p = pickups.find((p) => p.id === id)
    if (!p || Math.hypot(p.pos[0] - m.pos[0], p.pos[1] - m.pos[1]) > C.loot.pickup_radius) return
    let slot = m.weapons.findIndex((w) => !w)
    if (slot < 0 && drop !== undefined) slot = drop
    if (slot < 0 || m.weapons.some((w) => w?.kind === p.kind)) return
    const old = m.weapons[slot]
    const w = mkWeapon(p.kind)
    w.cooldown = Math.max(C.loot.equip_s, w.stats.cooldown ?? 0)
    m.weapons[slot] = w
    pickups.splice(pickups.indexOf(p), 1)
    m.events.push({ type: "took", id: p.id, kind: p.kind, slot })
    if (old) {
      const nid = pid++
      pickups.push({ id: nid, kind: old.kind, pos: [...m.pos] as V3 })
      m.events.push({ type: "dropped", id: nid, kind: old.kind, slot })
    }
  }
  function npcAct(n: Npc, t: number) {
    const home = n.home
    const dHome = Math.hypot(n.pos[0] - home[0], n.pos[1] - home[1])
    let tgt = n.target >= 0 && n.target < 100 ? mechs[n.target] : null
    if (tgt && (!tgt.alive || Math.hypot(tgt.pos[0] - n.pos[0], tgt.pos[1] - n.pos[1]) > C.npc.deaggro_range || dHome > C.npc.chase_leash)) (tgt = null), (n.target = -1)
    if (!tgt && dHome < C.npc.leash)
      for (const m of aliveMechs()) {
        const d = Math.hypot(m.pos[0] - n.pos[0], m.pos[1] - n.pos[1])
        if (d < C.npc.aggro_range && MAP.los(n.pos[0], n.pos[1], n.pos[2] + 3, m.pos[0], m.pos[1], m.pos[2] + 4.5)) (tgt = m), (n.target = m.id)
      }
    let goal = n.goal
    if (tgt) {
      goal = [tgt.pos[0], tgt.pos[1]]
      n.cd -= DT * 2
      if (n.cd <= 0 && MAP.los(n.pos[0], n.pos[1], n.pos[2] + 3, tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5)) {
        n.cd = C.npc.cooldown
        const d = Math.hypot(tgt.pos[0] - n.pos[0], tgt.pos[1] - n.pos[1], tgt.pos[2] + 4.5 - n.pos[2] - 3)
        const sp = C.npc.spread_deg * D2R
        const ya = Math.atan2(tgt.pos[1] - n.pos[1], tgt.pos[0] - n.pos[0]) + gauss(R) * sp
        const pa = Math.asin((tgt.pos[2] + 4.5 - n.pos[2] - 3) / d) + gauss(R) * sp
        const v = C.npc.projectile_speed
        shots.push({ by: n.id, pos: [n.pos[0], n.pos[1], n.pos[2] + 3], vel: [Math.cos(pa) * Math.cos(ya) * v, Math.cos(pa) * Math.sin(ya) * v, Math.sin(pa) * v], ttl: 2, dmg: C.npc.damage, kind: "npc" })
        sound(n.pos, "npc_gun", -1)
      }
    } else if (Math.hypot(goal[0] - n.pos[0], goal[1] - n.pos[1]) < 2 || dHome > C.npc.leash) {
      const a = R() * Math.PI * 2, r = R() * C.npc.leash * 0.8
      n.goal = [home[0] + Math.cos(a) * r, home[1] + Math.sin(a) * r]
      goal = n.goal
    }
    const d = Math.hypot(goal[0] - n.pos[0], goal[1] - n.pos[1])
    if (d > 6) {
      const nx = n.pos[0] + ((goal[0] - n.pos[0]) / d) * C.npc.speed * DT * 2, ny = n.pos[1] + ((goal[1] - n.pos[1]) / d) * C.npc.speed * DT * 2
      if (MAP.surfAt(nx, ny) < n.pos[2] + 1.2) n.pos = [nx, ny, MAP.surfAt(nx, ny)]
    }
  }
}

function blocked(x: number, y: number, z: number) {
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2
    const sx = x + Math.cos(a) * C.mech.radius * 0.9, sy = y + Math.sin(a) * C.mech.radius * 0.9
    if (MAP.cellOf(sx, sy) < 0 || MAP.surfAt(sx, sy) > z + C.mech.step_up) return true
  }
  return false
}

function houseAct(m: Mech, t: number, Z: ReturnType<typeof zoneAt>, us: Mech, intel: { t: number; pos: V3 }, R: () => number) {
  const d = Math.hypot(us.pos[0] - m.pos[0], us.pos[1] - m.pos[1])
  const iSee = us !== m && m.seen.get(us.id) === t
  if (LANCE && !FFA) return lanceAct(m, t, Z, us, d, iSee, R)
  const knows = t - intel.t < 6
  m.fire = [false, false]
  m.boost = false
  m.jump = false
  // hunters fight on sight; the rest of the squad only answers if we hit them or come very close
  const provoked = t - m.hitByUsT < 8
  const fightRange = m.hunter ? 180 : provoked ? 120 : 0
  if (iSee && us.alive && d < fightRange) {
    if (t > (m as any).flipT) ((m as any).flipT = t + 0.4 + R() * 1.2), ((m as any).side = R() < 0.5 ? -1 : 1)
    const s = (m as any).side ?? 1
    const b = Math.atan2(us.pos[1] - m.pos[1], us.pos[0] - m.pos[0])
    const radial = m.hunter ? (d > 150 ? 0.8 : d > 100 ? 0.35 : d < 40 ? -0.5 : 0) : 0
    m.move = [Math.cos(b) * radial - Math.sin(b) * s * 0.6, Math.sin(b) * radial + Math.cos(b) * s * 0.6]
    if (blocked(m.pos[0] + m.move[0] * 4, m.pos[1] + m.move[1] * 4, m.pos[2])) m.move = [Math.cos(b) * radial, Math.sin(b) * radial]
    const w1 = m.weapons[1]
    const laser = w1?.kind === "laser" ? w1 : null
    const err = REAL ? REAL_ERR * (1.6 - m.skill) : (1 - m.skill) * 0.03 + (1 - HARD) * 0.05
    if (laser && laser.cooldown <= 0.05) {
      // hitscan: aim at the body, charge fully, release when on target
      m.cmdAim = [b + gauss(R) * err, Math.atan2(us.pos[2] + 4.5 - m.pos[2] - 7, d)]
      const onTarget = Math.abs(angDiff(b, m.aim[0])) < 0.02 + err
      // slower trigger discipline for weaker squads: wait a little longer before releasing
      const hold = REAL ? laser.stats.charge : laser.stats.charge * (1 + Math.max(0, -HARD) * 0.8)
      m.fire = [false, !((laser.charge ?? 0) >= Math.min(hold, laser.stats.charge + laser.stats.hold_s - 0.2) && onTarget)]
    } else {
      const tl = d / 252 + 0.05
      const px = us.pos[0] + us.vel[0] * tl * (0.4 + 0.6 * m.skill), py = us.pos[1] + us.vel[1] * tl * (0.4 + 0.6 * m.skill)
      m.cmdAim = [Math.atan2(py - m.pos[1], px - m.pos[0]) + gauss(R) * err, Math.atan2(us.pos[2] + 4.5 - m.pos[2] - 7, d)]
      const onTarget = Math.abs(angDiff(m.cmdAim[0], m.aim[0])) < 0.05
      const fireP = REAL ? 0.9 : Math.min(1, Math.max(0.2, 0.8 + 0.4 * HARD))
      m.fire = [onTarget && R() < fireP, w1?.kind === "lightning" && d < 40 && onTarget]
    }
    return
  }
  let goal: V2
  if (m.hunter && us.alive && knows) goal = [intel.pos[0], intel.pos[1]]
  else if (m.hunter && us.alive) goal = [us.pos[0] + Math.cos(m.id) * 60, us.pos[1] + Math.sin(m.id) * 60] // roam toward our area
  else goal = [Z.next.c[0] + Math.cos(m.id * 2.4) * Z.next.r * 0.4, Z.next.c[1] + Math.sin(m.id * 2.4) * Z.next.r * 0.4]
  const r = m.nav!.steer(m.pos[0], m.pos[1], goal[0], goal[1], t, 2500)
  m.move = r.arrived ? [0, 0] : r.dir
  m.jump = r.jump
  m.boost = m.hunter && knows && d > 120 && m.energy > 50
  const look = knows && m.hunter ? Math.atan2(intel.pos[1] - m.pos[1], intel.pos[0] - m.pos[0]) : Math.atan2(m.move[1], m.move[0]) + Math.sin(t + m.id) * 1.2
  m.cmdAim = [look || m.aim[0], 0]
}

function buildObs(m: Mech, t: number, Z: ReturnType<typeof zoneAt>, live: Mech[], npcs: Npc[], crates: Ent[], pickups: { id: number; kind: string; pos: V3 }[], cubes: { id: number; pos: V3 }[], shots: Shot[], drops: any[], tick: number): Observation {
  const mem = C.vision.memory_s
  const vis = (p: V3, h = 0.8) => {
    const d = Math.hypot(p[0] - m.pos[0], p[1] - m.pos[1])
    if (d > C.vision.range) return false
    if (d > C.vision.near_range && Math.abs(angDiff(Math.atan2(p[1] - m.pos[1], p[0] - m.pos[0]), m.aim[0])) > (C.vision.fov_deg / 2) * D2R) return false
    if (CANOPY) return MAP.sees(m.pos[0], m.pos[1], m.pos[2] + 8, p[0], p[1], p[2] + h, C.vision.near_range)
    return MAP.los(m.pos[0], m.pos[1], m.pos[2] + 8, p[0], p[1], p[2] + h)
  }
  for (const n of npcs) if (n.alive && vis(n.pos, 2)) m.seen.set(n.id, t)
  const mechsObs: any[] = live
    .filter((o) => o !== m && t - (m.seen.get(o.id) ?? -99) <= mem)
    .map((o) => ({ id: o.id, kind: "mech", pos: [...o.pos], vel: [...o.vel], aim: [...o.aim], hp: o.hp, max_hp: o.maxHp, cubes: o.cubes, weapons: o.weapons.filter(Boolean).map((w) => w!.kind), charging: o.weapons.some((w) => w?.kind === "laser" && (w.charge ?? 0) > 0) }))
  for (const n of npcs) if (n.alive && t - (m.seen.get(n.id) ?? -99) <= mem) mechsObs.push({ id: n.id, kind: "npc", pos: [...n.pos], vel: [0, 0, 0], aim: [0, 0], hp: n.hp, max_hp: n.maxHp })
  return {
    type: "obs", tick, t, alive: live.length,
    self: {
      id: m.id, pos: [...m.pos] as V3, vel: [...m.vel] as V3, aim: [...m.aim] as V2, hp: m.hp, max_hp: m.maxHp, energy: m.energy, max_energy: C.mech.energy, grounded: m.grounded, cubes: m.cubes, upgrades: [...m.upgrades],
      weapons: m.weapons.map((w) => (w ? { ...w, stats: { ...w.stats } } : null)) as any, in_zone: Math.hypot(m.pos[0] - Z.c[0], m.pos[1] - Z.c[1]) <= Z.r, stats: { ...m.stats },
    },
    mechs: mechsObs,
    projectiles: shots.filter((s) => s.by !== m.id && vis(s.pos, 0)).map((s, k) => ({ id: k, kind: s.kind as any, pos: s.pos, vel: s.vel })),
    crates: crates.filter((c) => c.alive && vis(c.pos, 1.2)).map((c) => ({ id: c.id, pos: c.pos, hp: c.hp })),
    cubes: cubes.filter((c) => vis(c.pos, 0.5)).map((c) => ({ id: c.id, pos: c.pos })),
    pickups: pickups.filter((p) => vis(p.pos)) as any,
    sounds: m.sounds.splice(0), beams: [], events: m.events.splice(0),
    zone: { center: Z.prev.c, radius: Z.prev.r, next_center: Z.next.c, next_radius: Z.next.r, shrink_start: Z.next.t0, shrink_end: Z.next.t1, dps: Z.dps },
    offer: m.offer,
    drops: drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: d.pos, radius: C.drops.radius, lands_in: Math.max(0, d.landT - t), capture_s: C.drops.capture_s, progress: d.progress, holder: d.holder })),
  } as Observation
}

function segCyl(a: V3, b: V3, p: V3, r: number, h: number) {
  for (let k = 0; k <= 8; k++) {
    const f = k / 8
    const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, z = a[2] + (b[2] - a[2]) * f
    if (Math.hypot(x - p[0], y - p[1]) <= r + 0.3 && z >= p[2] && z <= p[2] + h) return true
  }
  return false
}
function rayCyl(o: V3, d: V3, p: V3, r: number, h: number): number | null {
  const ox = o[0] - p[0], oy = o[1] - p[1]
  const a = d[0] * d[0] + d[1] * d[1]
  if (a < 1e-9) return null
  const b = 2 * (ox * d[0] + oy * d[1]), c = ox * ox + oy * oy - r * r
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const t = (-b - Math.sqrt(disc)) / (2 * a)
  if (t < 0) return null
  const z = o[2] + d[2] * t
  return z >= p[2] && z <= p[2] + h ? t : null
}

const results: any[] = []
for (let k = 0; k < N_MATCH; k++) {
  const r = runMatch(SEED + k)
  console.log(JSON.stringify(r))
  results.push(r)
}
const mean = (f: (r: any) => number) => (results.reduce((s, r) => s + f(r), 0) / results.length).toFixed(2)
console.log(`mean score ${mean((r) => r.score)}  survive ${mean((r) => r.t)}s  kills ${mean((r) => r.kills)}  dealt ${mean((r) => r.dealt)}  taken ${mean((r) => r.taken)} (hunter ${mean((r) => r.byHunter)} other ${mean((r) => r.byOther)} npc ${mean((r) => r.byNpc)})  cubes ${mean((r) => r.cubes)}  late ${mean((r) => r.late)}  acc gun ${(results.reduce((a, r) => a + r.hits, 0) / Math.max(1, results.reduce((a, r) => a + r.shots, 0))).toFixed(2)} laser ${(results.reduce((a, r) => a + r.lzHits, 0) / Math.max(1, results.reduce((a, r) => a + r.lzShots, 0))).toFixed(2)} (${mean((r) => r.lzShots)}/m) lightning ${(results.reduce((a, r) => a + r.ltHits, 0) / Math.max(1, results.reduce((a, r) => a + r.ltShots, 0))).toFixed(2)}`)


function lanceAct(m: Mech, t: number, Z: ReturnType<typeof zoneAt>, us: Mech, d: number, iSee: boolean, R: () => number) {
  const tier = (m as any).tier as number
  m.fire = [false, false]
  m.boost = false
  m.jump = false
  const provoked = t - m.hitByUsT < 8
  if (us.alive && iSee && d < L_RANGE[tier] && (m.hunter || provoked)) {
    if (t > (m as any).flipT) ((m as any).flipT = t + 1 + R() * 2), ((m as any).side = R() < 0.5 ? -1 : 1)
    const s = d < 90 ? ((m as any).side ?? 1) : 0
    const b = Math.atan2(us.pos[1] - m.pos[1], us.pos[0] - m.pos[0])
    const radial = d > L_RANGE[tier] * 0.8 ? 0.7 : d < 30 ? -0.5 : 0
    m.move = [Math.cos(b) * radial - Math.sin(b) * s * 0.8, Math.sin(b) * radial + Math.cos(b) * s * 0.8]
    if (blocked(m.pos[0] + m.move[0] * 4, m.pos[1] + m.move[1] * 4, m.pos[2])) m.move = [Math.cos(b) * radial, Math.sin(b) * radial]
    const lead = tier >= 1 ? d / 252 : 0
    const px = us.pos[0] + us.vel[0] * lead, py = us.pos[1] + us.vel[1] * lead
    const err = (L_NOISE[tier] * LF * Math.PI) / 180
    m.cmdAim = [Math.atan2(py - m.pos[1], px - m.pos[0]) + gauss(R) * err, Math.atan2(us.pos[2] + 4.5 - m.pos[2] - 7, d)]
    const onTarget = Math.abs(angDiff(m.cmdAim[0], m.aim[0])) < 0.05
    m.fire = [onTarget, false]
    const w1 = m.weapons[1]
    if (w1?.kind === "laser") m.fire[1] = !((w1.charge ?? 0) >= w1.stats.charge && onTarget)
    return
  }
  const goal: V2 = us.alive && m.hunter && (SCHED || d < L_CHASE[tier]) ? [us.pos[0], us.pos[1]] : [Z.next.c[0] + Math.cos(m.id * 2.4) * Z.next.r * 0.4, Z.next.c[1] + Math.sin(m.id * 2.4) * Z.next.r * 0.4]
  const r = m.nav!.steer(m.pos[0], m.pos[1], goal[0], goal[1], t, 2500)
  m.move = r.arrived ? [0, 0] : r.dir
  m.jump = r.jump
  const look = us.alive && m.hunter ? Math.atan2(us.pos[1] - m.pos[1], us.pos[0] - m.pos[0]) : Math.atan2(m.move[1], m.move[0]) + Math.sin(t + m.id) * 1.2
  m.cmdAim = [look || m.aim[0], 0]
}
