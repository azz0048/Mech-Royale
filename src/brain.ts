import { draw, log, type BotAction, type DropObs, type Hello, type Observation, type SelfObs, type WeaponObs } from "../mechfight.ts"
import { GameMap } from "./map.ts"
import { Navigator } from "./nav.ts"
import { World, type Track } from "./world.ts"
import { aimAt, centerOffset, clampPitch, hitProb, hitRadius, leadAim, missDist, predict2, shellLanding, type Aim } from "./combat.ts"
import { planPeek, Viewshed, type PeekPlan } from "./cover.ts"
import { assess, RP, type Risk } from "./risk.ts"
import { Practice, PP } from "./practice.ts"
import { Econ } from "./econ.ts"
import { angDiff, rng, type V2, type V3 } from "./geom.ts"

const UPG_FFA = ["gyros", "plating", "armor", "nanites", "laser_damage", "laser_charge", "lightning_efficiency", "gun_damage", "sensors", "gyros", "gun_rate", "servos", "jets", "lightning_range", "reactor", "capacitor", "gun_mag", "gun_velocity", "lightning_chain", "laser_pierce"]
const UPG_PRACTICE = ["gyros", "plating", "laser_damage", "nanites", "armor", "laser_charge", "lightning_efficiency", "gun_damage", "gun_rate", "gyros", "sensors", "lightning_range", "servos", "gun_mag", "gun_velocity", "jets", "reactor", "capacitor", "lightning_chain", "laser_pierce"]
const LOUD = new Set(["gun", "laser", "laser_charge", "lightning", "mortar", "explosion", "step", "boost", "jet", "reload"])

type Goal = { pos: V2; kind: "pickup" | "cube" | "farm" | "explore"; id: number }
type LaserMode = "off" | "charge" | "shoot"

export class Brain {
  name = "not-even-close"
  hello: Hello
  m: GameMap
  w: World
  nav: Navigator
  rnd: () => number
  perCube: number
  g: number
  // movement memory
  jinkSign = 1
  jinkT = 0
  holdGoal: V2 | null = null
  holdKey = ""
  scanYaw = 0
  exploreGoal: V2 | null = null
  exploreT = -99
  // combat memory
  targetId = -1
  regen = false
  lastKillT = -99
  plan: PeekPlan | null = null
  peekPhase: "hide" | "out" = "hide"
  peekSince = 0
  peekHp = 0
  peekShots = 0
  state = "init"
  slowTicks = 0
  evadeUntil = -1
  // ninja: live viewsheds of the most dangerous known enemies
  vsPool: Viewshed[] = []
  vsIds: number[] = []
  vsActive = 0
  holdT = -99
  camping = false
  ninja = false
  hasLightning = false
  meObs: SelfObs | null = null
  practice: Practice
  econ: Econ
  cover: V2 | null = null
  coverT = -99
  risk: Risk | null = null
  anchor: V2 = [0, 0]
  anchorT = 0
  unstickUntil = -1
  unstickSide = 1

  /** core forced regardless of the detected mode (simulator opponents) */
  forceCore: "" | "econ" | "practice" = ""

  constructor(hello: Hello, opts: { map?: GameMap; core?: "econ" | "practice"; noWarm?: boolean } = {}) {
    const t0 = performance.now()
    this.hello = hello
    const cfg = hello.config
    this.forceCore = opts.core ?? ""
    this.m = opts.map ?? new GameMap(hello.map.dir, cfg.mech.step_up ?? 1.2)
    this.w = new World(this.m, hello)
    this.nav = new Navigator(this.m)
    this.rnd = rng(((hello.seed ?? 1) ^ 0x5bd1e995) + RP.salt * 7919)
    this.perCube = Number(cfg.cubes.size_per_cube ?? 0.05)
    this.g = cfg.mech.gravity ?? 22
    this.practice = new Practice(this)
    this.econ = new Econ(this)
    if (!opts.noWarm) this.warmup()
    log(`brain ready in ${(performance.now() - t0).toFixed(0)} ms`)
  }

  /** Exercise the hot paths once so the JIT has compiled them before the first fight. */
  private warmup() {
    const m = this.m
    const rq = (this.hello.config.mech.radius ?? 2.5) + 0.9
    const comp = m.comp(rq)
    const per = this.perCube
    for (let c = 0; c <= 14; c++) m.comp((this.hello.config.mech.radius ?? 2.5) * (1 + per * c) + 0.9)
    const r = rng(7)
    let n = 0
    for (let k = 0; k < 3000; k++) {
      const a = r() * 900 - 450, b = r() * 600 - 300
      if (m.los(a, b, 5, a + r() * 200 - 100, b + r() * 200 - 100, 4)) n++
    }
    for (let k = 0; k < 12; k++) {
      const s = m.snap(r() * 600 - 300, r() * 400 - 200, rq, -1, 20)
      if (s < 0) continue
      const t = m.snap(m.nodeX(s) + r() * 300 - 150, m.nodeY(s) + r() * 300 - 150, rq, comp[s], 30)
      if (t < 0) continue
      this.nav.pf.begin(s, t, rq)
      this.nav.pf.run(60000)
      n += this.nav.pf.result.length
    }
    this.nav.pf.state = "idle"
    for (let k = 0; k < 200; k++) n += m.walkLine(0, 0, r() * 50, r() * 50, rq) ? 1 : 0
    // compile the combat paths too (cover planner, risk, aim) on fake data
    const cfg = this.hello.config
    const fakeMe: any = { pos: [0, 0, 0], vel: [3, 1, 0], aim: [0, 0], hp: 1400, max_hp: 1400, energy: 100, cubes: 0, weapons: [{ kind: "gun", cooldown: 0, ammo: 12, reload: 0, stats: cfg.weapons.gun }, { kind: "laser", cooldown: 0, charge: 0, stats: cfg.weapons.laser }], stats: { ...cfg.mech } }
    for (let k = 0; k < 40; k++) {
      const s0 = m.snap(r() * 600 - 300, r() * 400 - 200, rq, -1, 20)
      if (s0 < 0) continue
      const x = m.nodeX(s0), y = m.nodeY(s0)
      const tr: Track = { id: 5, kind: "mech", pos: [x + 80 * Math.cos(k), y + 80 * Math.sin(k), m.surfAt(x, y)], vel: [5, -3, 0], aim: [1, 0], hp: 1000, maxHp: 1400, cubes: 1, weapons: ["gun", "laser"], charging: false, seenT: 0, firstT: 0, hitUsT: -99, hitByUsT: -99, laserT: -99, hist: [[0, 5, -3], [0.1, 5, -3], [0.2, -5, 3], [0.3, -5, 3], [0.4, 5, -3]], hurtByOtherT: -99 }
      fakeMe.pos = [x, y, m.surfAt(x, y)]
      const p = planPeek(m, x, y, rq, comp, comp[s0], [tr], tr, 1, this.perCube, 0, () => true)
      if (p.hide) n++
      for (let j = 0; j < 10; j++) {
        n += assess(m, this.w, fakeMe, x, y, tr, cfg, this.perCube).ttd > 0 ? 1 : 0
        n += leadAim(m, [x, y, fakeMe.pos[2] + 7], tr, 252, 0.05, 4.5, this.g).dist > 0 ? 1 : 0
        n += hitProb(1, 1, 2.5) > 0 ? 1 : 0
      }
    }
    // compile the practice core on a fake match (separate world, nothing leaks into the real one)
    try {
      const s0 = m.snap(0, -60, rq, -1, 30)
      if (s0 >= 0) {
        const x = m.nodeX(s0), y = m.nodeY(s0), zz = m.surfAt(x, y)
        const tw = new World(m, this.hello)
        const tp = new Practice({ m, w: tw, nav: this.nav, hello: this.hello, rnd: rng(3), perCube: this.perCube, g: this.g })
        const te = new Econ({ m, w: tw, nav: this.nav, hello: this.hello, rnd: rng(4), perCube: this.perCube, g: this.g })
        const obs: any = {
          type: "obs", tick: 0, t: 0, alive: 16, offer: null, drops: [], beams: [], sounds: [], events: [], projectiles: [], crates: [], cubes: [], pickups: [],
          self: { ...fakeMe, id: 0, pos: [x, y, zz], vel: [0, 0, 0], max_energy: 100, grounded: true, upgrades: [], in_zone: true },
          mechs: [{ id: 5, kind: "mech", pos: [x + 90, y + 20, zz], vel: [6, -2, 0], aim: [3, 0], hp: 900, max_hp: 1400, cubes: 0, weapons: ["gun", "laser"], charging: false }],
          zone: { center: cfg.zone.start_center, radius: cfg.zone.start_radius, next_center: cfg.zone.start_center, next_radius: 380, shrink_start: 60, shrink_end: 110, dps: 20 },
        }
        for (let k = 0; k < 40; k++) {
          obs.tick = 2 * k
          obs.t = 0.1 * k
          obs.mechs[0].pos = [x + 90 + Math.sin(k) * 10, y + 20, zz]
          obs.self.hp = k < 20 ? 1400 : 400
          tw.update(obs)
          tp.act(obs, performance.now())
          te.act(obs, performance.now())
        }
        draw.clear()
      }
    } catch (e) {
      log("practice warmup failed", e)
    }
    // the fake match ran up to t = 3.9 s on our navigator: forget its stuck timers too
    if (RP.warmNav) this.nav.reset()
    else this.nav.resetAll()
    if (RP.openMode !== "none") (this.nav.openMode = RP.openMode), (this.nav.openUntil = RP.openT)
    if (n < 0) log(n)
  }

  pickUpgrade(obs: Observation): number {
    const list = RP.upg.length ? RP.upg : this.w.mode === "practice" ? UPG_PRACTICE : UPG_FFA
    let best = 0, bestR = Infinity
    obs.offer!.choices.forEach((c, i) => {
      let r = list.indexOf(c.id)
      if (r < 0) r = 50
      if (r < bestR) (bestR = r), (best = i)
    })
    return best
  }

  act(obs: Observation): BotAction {
    const T0 = performance.now()
    const w = this.w, m = this.m
    w.update(obs)
    // practice (house squad): aggressive core; free-for-all: ninja core below
    if (RP.openCancel && obs.t < this.nav.openUntil && obs.events.some((ev) => ev.type === "damaged" && ev.weapon !== "zone" && ev.weapon !== "npc")) this.nav.openUntil = 0
    const ffaEcon = w.mode === "ffa" && RP.ffaCore === "econ" && !this.forceCore
    if (this.forceCore || ffaEcon || ((w.mode !== "ffa" || RP.ffaPractice) && !RP.legacy)) {
      const core = ffaEcon || (this.forceCore || PP.core) === "econ" ? this.econ : this.practice
      this.econ.ffa = ffaEcon
      const a = core.act(obs, T0)
      this.state = core.state
      const ms = performance.now() - T0
      if (ms > 25) this.slowTicks++
      if (ms > 12) log(`slow act ${ms.toFixed(1)} ms at t=${obs.t} state=${this.state}`)
      return a
    }
    const me = obs.self, t = obs.t
    const [x, y, z] = me.pos
    const st = me.stats
    const scale = (st.radius ?? 2.5) / (this.hello.config.mech.radius ?? 2.5)
    const rq = (st.radius ?? 2.5) + 0.9
    this.nav.rq = rq
    const act: BotAction = {}
    if (obs.offer) act.pick = this.pickUpgrade(obs)
    const muz: V3 = [x, y, z + (st.muzzle_height ?? 7)]
    const eyeZ = z + (st.eye_height ?? 8)
    const hpFrac = me.hp / me.max_hp
    const slots = me.weapons
    const iGun = slots.findIndex((s) => s?.kind === "gun")
    const iLaser = slots.findIndex((s) => s?.kind === "laser")
    const iLight = slots.findIndex((s) => s?.kind === "lightning")
    const enemies = w.liveMechs()
    const dTo = (p: ArrayLike<number>) => Math.hypot(p[0] - x, p[1] - y)
    const losTo = (tr: Track) => m.los(muz[0], muz[1], muz[2], tr.pos[0], tr.pos[1], tr.pos[2] + centerOffset(tr, this.perCube))
    let nearestD = Infinity
    for (const e of enemies) nearestD = Math.min(nearestD, dTo(e.pos))
    const hitRecently = t - w.lastHurtT < 4
    const attackers = new Set(w.hurt.filter((h) => t - h.t < 5 && h.by !== null && h.weapon !== "npc").map((h) => h.by))

    // ---------- choose the main threat ----------
    let T: Track | null = null
    let ts = -Infinity
    const npcAttackers = w.liveNpcs().filter((n) => t - n.hitUsT < 4 && dTo(n.pos) < 60)
    for (const e of [...enemies, ...npcAttackers]) {
      const d = dTo(e.pos)
      if (d > 300) continue
      let sc = -d * 0.015
      if (Math.abs(e.vel[2]) > 1.5 && e.kind === "mech") sc += 1.5
      if (e.kind === "npc") sc += 3 + (d < 25 ? 3 : 0)
      else if (t - e.hitUsT < 6) sc += 5
      if (e.id === this.targetId) sc += 2
      if (e.charging && this.aimedAtUs(e, x, y)) sc += 3
      sc += (1 - e.hp / Math.max(1, e.maxHp)) * 1.5
      if (sc > ts) (ts = sc), (T = e)
    }
    const engage = T !== null && this.shouldEngage(T, x, y, t)
    this.targetId = engage && T ? T.id : -1

    // ---------- regen / retreat state ----------
    const threatsNear = enemies.filter((e) => dTo(e.pos) < 160 && t - e.seenT < 1).length
    const lowHp = attackers.size >= 2 || threatsNear >= 2 ? RP.regenLowMulti : RP.regenLow
    const justKilled = obs.events.some((ev) => ev.type === "kill") || t - this.lastKillT < 3
    if (obs.events.some((ev) => ev.type === "kill")) this.lastKillT = t
    // a nearly dead target is worth finishing before breaking off
    const finishing = T !== null && engage && T.hp / Math.max(1, T.maxHp) < 0.2 && T.hp < me.hp * 0.5
    if (!this.regen && !finishing && ((hpFrac < lowHp && (hitRecently || nearestD < 120)) || (justKilled && hpFrac < RP.healAfterKill))) this.regen = true
    if (this.regen && (hpFrac > 0.9 || (t - w.lastHurtT > 10 && hpFrac > 0.75 && nearestD > 140))) this.regen = false
    // risk: never stay in a losing trade or under several guns
    const cfg = this.hello.config
    const risk = (this.risk = assess(m, w, me, x, y, engage ? T : null, cfg, this.perCube))
    if (engage && !finishing && risk.level === "danger") this.evadeUntil = Math.max(this.evadeUntil, t + RP.evadeDur)
    const evading = t < this.evadeUntil

    // ---------- movement / mode ----------
    let mv: V2 = [0, 0]
    let boost = false
    let jump = false
    let speedCap = 1
    let laserMode: LaserMode = "off"
    let shootT: Track | null = null
    let gunOk = false
    let lightOk = false
    const go = (gx: number, gy: number, budget = 5000) => {
      // stay well inside the 50 ms budget: shrink path search when this decision is already slow
      const spent = performance.now() - T0
      const r = this.nav.steer(x, y, gx, gy, t, spent > 20 ? 300 : spent > 10 ? Math.min(budget, 1500) : budget)
      if (r.jump) jump = true
      if (r.boost) boost = true
      return r
    }
    const zoneNow = w.zoneMargin(x, y, t)
    const zoneSoon = w.zoneMargin(x, y, t + 10)
    this.meObs = me
    this.hasLightning = iLight >= 0
    this.updateViewsheds(t, x, y)
    // ninja features only in free-for-all (practice house bots hunt us wherever we hide)
    const ffa = w.mode === "ffa"
    this.nav.costFn = ffa && this.vsActive > 0 ? (n: number) => 3 * this.exposedAt(n) + (0.3 * m.openFar[n]) / 255 : null
    if (ffa !== this.ninja) (this.ninja = ffa), (this.holdGoal = null)
    const zGoal = ffa ? this.zoneGoal(obs, x, y, rq) : this.zoneGoalPractice(obs, x, y, rq)
    const rotate = this.needRotate(obs, x, y, t)
    const dodge = this.mortarDodge(obs, x, y)
    const comp = m.comp(rq)
    const sNode = m.snap(x, y, rq, -1, 4)
    const myComp = sNode >= 0 ? comp[sNode] : -1
    const zoneOk = (px: number, py: number) => w.zoneMargin(px, py, t + 8) > 4
    let drop: DropObs | null = null

    if (dodge) {
      this.state = "dodge"
      mv = dodge
      boost = me.energy > 15
      if (engage && T) (shootT = T), (gunOk = true), (lightOk = true)
    } else if (zoneSoon < 4 || zoneNow < 8) {
      this.state = "zone"
      const r = go(zGoal[0], zGoal[1])
      mv = r.dir
      if (zoneNow < 2 || zoneSoon < -15) boost = boost || me.energy > 10
      if (engage && T) (shootT = T), (gunOk = true), (lightOk = true), (laserMode = "shoot")
    } else if (engage && T) {
      const d = dTo(T.pos)
      const lightRange = iLight >= 0 ? (slots[iLight]!.stats.range ?? 45) : 0
      const brawlD = iLight >= 0 && me.energy > 25 ? lightRange * 0.93 : 26
      // a laser sniper out of arc range: refuse the long duel, stay out of its sight until it comes
      // into lightning range (each arc shorts its laser for 2 s) or its laser is cooling down
      const sniper = T.kind === "mech" && T.weapons.includes("laser") && iLight >= 0 && d > brawlD && !finishing
      const theirLaserDown = t - T.laserT < 1.4 && !T.charging
      shootT = T
      if (this.regen || evading) {
        // break line of sight from every threat (and heal)
        this.state = this.regen ? "regen" : "evade"
        this.replan(x, y, rq, comp, myComp, enemies, T, scale, t, zoneOk, 0.5)
        const hide = this.plan?.hide
        if (hide && !(this.plan!.hiddenNow && Math.hypot(hide[0] - x, hide[1] - y) < 1.5)) {
          const r = go(hide[0], hide[1])
          mv = r.dir
          if (!r.arrived && (hitRecently || evading)) boost = me.energy > 20
        } else if (!hide) mv = this.jink(x, y, T, rq, t, 0.9, -0.8)
        // healing only starts after regen_delay s without taking (or dealing) damage: while we are
        // being hit anyway, firing back costs nothing
        const regenBlocked = t - w.lastHurtT < (me.stats.regen_delay ?? 5)
        const settled = !hide || this.plan!.hiddenNow
        gunOk = regenBlocked
        lightOk = regenBlocked
        laserMode = iLaser < 0 ? "off" : regenBlocked && settled ? "shoot" : this.plan?.hiddenNow ? "charge" : "off"
      } else if (sniper && !theirLaserDown && RP.doctrine) {
        this.state = "deny"
        this.replan(x, y, rq, comp, myComp, enemies, T, scale, t, zoneOk, 0.35)
        const hide = this.plan?.hide
        if (hide && !(this.plan!.hiddenNow && Math.hypot(hide[0] - x, hide[1] - y) < 1.5)) {
          const r = go(hide[0], hide[1])
          mv = r.dir
          if (!r.arrived && hitRecently) boost = me.energy > 30
        } else if (!hide) {
          // no cover: close the distance hard, zig-zagging, to get it into arc range
          mv = this.jink(x, y, T, rq, t, 0.6, 0.8)
          boost = me.energy > 45
        }
        const regenBlocked = t - w.lastHurtT < (me.stats.regen_delay ?? 5)
        gunOk = regenBlocked
        lightOk = true
        laserMode = iLaser >= 0 ? (this.plan?.hiddenNow ? "charge" : regenBlocked ? "shoot" : "off") : "off"
      } else if (d < brawlD && (risk.adv > RP.brawlAdv * (t > RP.lateT ? 1.4 : 1) || finishing)) {
        this.state = "brawl"
        mv = this.brawlMove(x, y, T, iLight >= 0 && me.energy > 25, rq, t)
        gunOk = true
        lightOk = true
        laserMode = "shoot"
      } else {
        this.replan(x, y, rq, comp, myComp, enemies, T, scale, t, zoneOk, 0.35)
        const P = this.plan!
        if (!P.hide || !P.peek) {
          // nowhere to hide nearby: strafe at range if we win the trade, else head for farther cover
          this.state = "open"
          mv = this.fightMove(x, y, T, iLight >= 0 && me.energy > 30, iLaser >= 0, rq, t, hpFrac)
          if (risk.level === "risky" && !finishing) {
            if (!this.cover || t - this.coverT > 1) (this.cover = this.findCover(x, y, T.pos, rq, t)), (this.coverT = t)
            if (this.cover) {
              this.state = "to-cover"
              mv = go(this.cover[0], this.cover[1]).dir
            }
          }
          gunOk = true
          lightOk = true
          laserMode = "shoot"
        } else {
          // stepping out must be a trade we win
          const pk = assess(m, w, me, P.peek[0], P.peek[1], T, cfg, this.perCube)
          const lateF = t > RP.lateT ? 1.6 : t > 250 ? 1.25 : 1
          const okOut = finishing || (pk.ttd > RP.outTtd && pk.adv > RP.outAdv * lateF)
          const r = this.peekStep(obs, x, y, T, P, iGun, iLaser, me.hp, t, okOut)
          this.state = "peek-" + this.peekPhase
          const dest = r.dest
          if (Math.hypot(dest[0] - x, dest[1] - y) > 1.2) {
            if (m.walkLine(x, y, dest[0], dest[1], rq)) {
              const dl = Math.hypot(dest[0] - x, dest[1] - y)
              mv = [(dest[0] - x) / dl, (dest[1] - y) / dl]
            } else mv = go(dest[0], dest[1]).dir
          }
          // hit while "hidden": someone sees us anyway, so shooting back is free
          gunOk = this.peekPhase === "out" || (t - w.lastHurtT < 1.5 && P.shotNow)
          lightOk = true
          laserMode = r.laser
        }
      }
    } else if (this.regen && !this.dropGoal(obs, x, y, t, enemies, hpFrac)) {
      // healing with nobody engaged: stay out of sight of whoever is around, keep still
      this.state = "heal"
      let near: Track | null = null
      for (const e of enemies) if (!near || dTo(e.pos) < dTo(near.pos)) near = e
      if (near && dTo(near.pos) < 220) {
        this.replan(x, y, rq, comp, myComp, enemies, near, scale, t, zoneOk, 0.6)
        const hide = this.plan?.hide
        if (hide && !this.plan!.hiddenNow) mv = go(hide[0], hide[1]).dir
        else if (!hide) mv = this.jink(x, y, near, rq, t, 0.8, -0.7)
      }
      // shot by someone we cannot see: do not stand still
      const h = w.hurt.length ? w.hurt[w.hurt.length - 1] : null
      if (h && t - h.t < 1.5 && Math.hypot(mv[0], mv[1]) < 0.1) {
        const b = h.bearing ?? this.scanYaw
        const ghost = { ...(near ?? ({} as Track)), pos: [x + Math.cos(b) * 60, y + Math.sin(b) * 60, z] as V3 } as Track
        mv = this.jink(x, y, ghost, rq, t, 0.8, -0.7)
      }
      if (iLaser >= 0) laserMode = "charge"
    } else if ((drop = this.dropGoal(obs, x, y, t, enemies, hpFrac))) {
      this.state = "drop"
      const dd = Math.hypot(drop.pos[0] - x, drop.pos[1] - y)
      if (dd > Math.max(1.5, drop.radius - 4)) {
        const r = go(drop.pos[0], drop.pos[1])
        mv = r.dir
        if (dd > 60 && me.energy > 50 && drop.lands_in < dd / 11) boost = true
      }
    } else if (rotate) {
      this.state = "rotate"
      const r = go(zGoal[0], zGoal[1])
      mv = r.dir
      if (Math.hypot(zGoal[0] - x, zGoal[1] - y) > 100 && me.energy > 60 && nearestD > 120) boost = true
    } else {
      const goal = this.lootGoal(obs, x, y, slots, nearestD, t, hpFrac)
      if (goal) {
        this.state = goal.kind
        const tr = goal.kind === "farm" ? this.farmTrack(goal.id) : null
        if (tr) {
          shootT = tr
          gunOk = true
          lightOk = true
          laserMode = tr.id < 1000 ? "shoot" : "off"
          const d = dTo(tr.pos)
          const want = iLight >= 0 && me.energy > 30 ? 30 : 42
          if (d > want || !losTo(tr)) mv = go(goal.pos[0], goal.pos[1]).dir
          else mv = this.jink(x, y, tr, rq, t, 0.5)
        } else mv = go(goal.pos[0], goal.pos[1]).dir
        if (goal.kind === "explore" && me.energy > 80 && Math.hypot(goal.pos[0] - x, goal.pos[1] - y) > 60) boost = true
      } else {
        this.state = "hold"
        const r = go(zGoal[0], zGoal[1])
        mv = r.arrived ? [0, 0] : r.dir
        if (Math.hypot(zGoal[0] - x, zGoal[1] - y) > 120 && me.energy > 70 && nearestD > 150) boost = true
        if (enemies.length || w.heard.some((h) => h.dist === "near")) speedCap = 0.4
      }
      // visible but not engaged enemies: don't wander into them
      if (T && !engage && dTo(T.pos) < 120) speedCap = Math.min(speedCap, 0.4)
    }
    if (this.state !== "peek-hide" && this.state !== "peek-out") this.peekPhase = "hide"
    // generic unstick: wanting to move but not moving
    if (Math.hypot(x - this.anchor[0], y - this.anchor[1]) > 1) (this.anchor = [x, y]), (this.anchorT = t)
    else if (Math.hypot(mv[0], mv[1]) > 0.5 && t - this.anchorT > 1.5) {
      this.unstickUntil = t + 0.7
      this.unstickSide = this.rnd() < 0.5 ? -1 : 1
      this.anchorT = t
    }
    if (t < this.unstickUntil) {
      const s = this.unstickSide
      mv = [mv[0] * 0.3 - mv[1] * s, mv[1] * 0.3 + mv[0] * s]
      jump = true
    }
    const ml = Math.hypot(mv[0], mv[1])
    if (ml > speedCap) mv = [(mv[0] / ml) * speedCap, (mv[1] / ml) * speedCap]

    // ---------- fire control ----------
    const fire: [boolean, boolean] = [false, false]
    let aim: Aim | null = null
    if (shootT) {
      const r = this.fireControl(me, muz, shootT, iGun, iLaser, iLight, laserMode, gunOk, lightOk, engage || shootT.kind === "npc", t)
      aim = r.aim
      fire[0] = r.fire[0]
      fire[1] = r.fire[1]
      if (r.reload) act.reload = true
    } else {
      if (iGun >= 0) {
        const G = slots[iGun]!
        if ((G.ammo ?? 0) < (G.stats.mag ?? 12) * 0.6 && !(G.reload ?? 0) && nearestD > 60) act.reload = true
      }
      if (iLaser >= 0) {
        const L = slots[iLaser]!
        const c = L.charge ?? 0
        if (c > 0) fire[iLaser] = c < (L.stats.charge ?? 0.75) + (L.stats.hold_s ?? 2) - 0.3
      }
    }

    // ---------- aim / look ----------
    let yaw: number, pitch = 0
    if (aim) {
      yaw = aim.yaw
      pitch = aim.pitch
    } else {
      const look = this.lookDir(x, y, z, eyeZ, enemies, t, mv)
      yaw = look[0]
      pitch = look[1]
    }
    pitch = clampPitch(me, pitch)

    // ---------- loot pickup ----------
    const safe = nearestD > 80 && !hitRecently
    const reach = this.hello.config.loot.pickup_radius ?? 4
    for (const p of w.pickups.values()) {
      if (Math.hypot(p.pos[0] - x, p.pos[1] - y) > reach - 0.3 || Math.abs(p.pos[2] - z) > 3.8) continue
      const want = this.wants(p.kind, slots, safe)
      if (want.ok) {
        act.take = p.id
        if (want.drop !== undefined) act.drop = want.drop
        break
      }
    }

    act.move = [round2(mv[0]), round2(mv[1])]
    act.boost = boost
    act.jump = jump
    act.aim = [round3(yaw), round3(pitch)]
    act.fire = fire

    this.camping = this.state === "hold" && this.holdGoal !== null && Math.hypot(this.holdGoal[0] - x, this.holdGoal[1] - y) < 5
    // ---------- debug ----------
    const ms = performance.now() - T0
    if (ms > 25) this.slowTicks++
    if (ms > 12) log(`slow act ${ms.toFixed(1)} ms at t=${t} state=${this.state}`)
    draw.label(`${this.state} ${w.mode[0]} ${risk.level[0]}${risk.adv < 9 ? risk.adv.toFixed(1) : ""} hp${Math.round(hpFrac * 100)} e${Math.round(me.energy)} ${shootT ? "→" + shootT.id : ""} ${ms.toFixed(0)}ms`)
    if (shootT) draw.line(muz, [shootT.pos[0], shootT.pos[1], shootT.pos[2] + 4], "#ff4040")
    if (this.plan && t - this.plan.t < 1) {
      if (this.plan.hide) draw.point([this.plan.hide[0], this.plan.hide[1], z + 1], "#40ff60", 5)
      if (this.plan.peek) draw.point([this.plan.peek[0], this.plan.peek[1], z + 1], "#ffb040", 5)
    }
    return act
  }

  /** Should we fight this mech (vs. keep a low profile)? */
  private shouldEngage(e: Track, x: number, y: number, t: number): boolean {
    const d = Math.hypot(e.pos[0] - x, e.pos[1] - y)
    if (e.kind === "npc") return t - e.hitUsT < 4 && d < 60
    // it is fighting us
    if (t - e.hitUsT < 8) return true
    if (t - e.hitByUsT < 6) return true
    if (d < 35) return true
    if (this.aimedAtUs(e, x, y, 0.2) && d < 160 && t - e.seenT < 0.5) return true
    if (e.charging && this.aimedAtUs(e, x, y, 0.15) && d < 290) return true
    // late game: only fight what is fighting us (surviving into the collapse is worth more)
    if (t > RP.lateT) return false
    // easy prey (a kill is a placement point)
    if (e.hp / Math.max(1, e.maxHp) < 0.35 && d < 130) return true
    if (this.w.mode === "ffa" && Math.abs(angDiff(e.aim[0], Math.atan2(y - e.pos[1], x - e.pos[0]))) > 2.2 && d < 90) return true
    // camping in the nest: pick off favourable targets only, when the trade is clearly ours
    if (this.ninja && this.camping && this.meObs && d < 200) {
      const backTurned = Math.abs(angDiff(e.aim[0], Math.atan2(y - e.pos[1], x - e.pos[0]))) > 2
      const fav = e.hp / Math.max(1, e.maxHp) < 0.5 || Math.abs(e.vel[2]) > 1.5 || (t - e.laserT < 1.3 && !e.charging) || t - e.hurtByOtherT < 3 || backTurned
      if (fav && assess(this.m, this.w, this.meObs, x, y, e, this.hello.config, this.perCube).adv > RP.campAdv) return true
    }
    return false
  }

  private aimedAtUs(e: Track, x: number, y: number, tol = 0.12) {
    return Math.abs(angDiff(e.aim[0], Math.atan2(y - e.pos[1], x - e.pos[0]))) < tol
  }

  private replan(x: number, y: number, rq: number, comp: Int32Array, myComp: number, enemies: Track[], T: Track, scale: number, t: number, zoneOk: (px: number, py: number) => boolean, every: number) {
    const P = this.plan
    // we thought we were hidden but got hit: the plan is wrong, redo it now
    const fooled = P && P.hiddenNow && t - this.w.lastHurtT < 0.25
    if (P && P.tid === T.id && t - P.t < every && !fooled) return
    // the threats that matter: target + nearest recently known mechs + unseen shooters by bearing
    const w = this.w
    const known: Track[] = []
    for (const e of w.tracks.values()) if (e.kind === "mech" && t - e.seenT < 4 && Math.hypot(e.pos[0] - x, e.pos[1] - y) < 230) known.push(e)
    known.sort((a, b) => Math.hypot(a.pos[0] - x, a.pos[1] - y) - Math.hypot(b.pos[0] - x, b.pos[1] - y))
    const threats = known.slice(0, 4)
    if (!threats.includes(T)) threats.unshift(T)
    const z = this.m.surfAt(x, y)
    for (const h of w.hurt) {
      if (t - h.t > 2 || h.bearing === null || h.weapon === "npc") continue
      const tr = h.by !== null ? w.tracks.get(h.by) : undefined
      if (tr && t - tr.seenT < 1) continue
      threats.push({ ...T, id: -1, pos: [x + Math.cos(h.bearing) * 70, y + Math.sin(h.bearing) * 70, z], cubes: 0 })
      break
    }
    this.plan = planPeek(this.m, x, y, rq, comp, myComp, threats, T, scale, this.perCube, t, zoneOk)
  }

  /** One step of the peek cycle: hide (charge / reload / heal), step out, shoot, hide again. */
  private peekStep(obs: Observation, x: number, y: number, T: Track, P: PeekPlan, iGun: number, iLaser: number, hp: number, t: number, okOut: boolean): { dest: V2; laser: LaserMode } {
    const me = obs.self
    const hide = P.hide!, peek = P.peek!
    const L = iLaser >= 0 ? me.weapons[iLaser]! : null
    const G = iGun >= 0 ? me.weapons[iGun]! : null
    const charge = L?.charge ?? 0
    const full = L ? (L.stats.charge ?? 0.75) : 0
    if (this.peekPhase === "hide") {
      const atHide = Math.hypot(hide[0] - x, hide[1] - y) < 1.8 || P.hiddenNow
      let ready = false
      if (L && L.cooldown <= 0.05 && charge >= full - 0.05) ready = true
      if (!L && G && (G.ammo ?? 0) >= 4 && !(G.reload ?? 0) && G.cooldown <= 0) ready = true
      if (L && G && L.cooldown > 0.3 && (G.ammo ?? 0) >= 4 && !(G.reload ?? 0)) ready = true
      // a laser carrier holding a charge is waiting for us to show: let it fire first (it auto-fires
      // after hold_s), then step out during its cooldown
      const theyFiredRecently = t - T.laserT < 1.3
      const waitLaser = T.weapons.includes("laser") && T.charging && !theyFiredRecently && t - this.peekSince < 3.5
      if (atHide && ready && okOut && !waitLaser && t - this.peekSince > 0.4) {
        this.peekPhase = "out"
        this.peekSince = t
        this.peekHp = hp
        this.peekShots = 0
      }
      return { dest: hide, laser: L && L.cooldown <= 0.05 ? "charge" : "off" }
    }
    // out: shoot, then go back
    const out = t - this.peekSince
    const hurt = this.peekHp - hp
    const laserDone = L ? charge === 0 && L.cooldown > 0.2 && out > 0.15 : true
    const gunDone = G ? (G.ammo ?? 0) === 0 || (G.reload ?? 0) > 0 : true
    // their laser is charging at us and ours is not about to fire: duck back now
    const ourReady = L ? charge >= full - 0.05 && L.cooldown <= 0.05 : false
    const danger = T.charging && this.aimedAtUs(T, x, y, 0.15) && !ourReady
    const done = (L ? laserDone && (out > 0.9 || gunDone) : gunDone || out > 1.6) || out > 2.6 || hurt > 220 || danger
    if (done) {
      this.peekPhase = "hide"
      this.peekSince = t
      return { dest: hide, laser: "off" }
    }
    return { dest: P.shotNow ? [x, y] : peek, laser: "shoot" }
  }

  /** Aim and triggers against `tr`. */
  private fireControl(me: SelfObs, muz0: V3, tr: Track, iGun: number, iLaser: number, iLight: number, laserMode: LaserMode, gunOk: boolean, lightOk: boolean, allowed: boolean, t: number): { aim: Aim; fire: [boolean, boolean]; reload: boolean } {
    const m = this.m
    const slots = me.weapons
    const turn = me.stats.turn_rate ?? 4
    const LAT = 0.05
    // where our muzzle will be when the shot leaves (bullets do not inherit our velocity)
    const muz: V3 = [muz0[0] + me.vel[0] * LAT, muz0[1] + me.vel[1] * LAT, muz0[2] + me.vel[2] * LAT]
    const off = centerOffset(tr, this.perCube)
    const radius = hitRadius(tr, this.perCube)
    const pr = predict2(m, tr, LAT, this.g)
    const direct = aimAt(muz, [pr.p[0], pr.p[1], pr.p[2] + off], pr.sigma)
    const d = direct.dist
    const los = m.los(muz[0], muz[1], muz[2], direct.pt[0], direct.pt[1], direct.pt[2])
    const fire: [boolean, boolean] = [false, false]
    let aim = direct
    let reload = false
    let laserBusy = false
    if (iLaser >= 0) {
      const L = slots[iLaser]!
      const charge = L.charge ?? 0
      const full = L.stats.charge ?? 0.75
      const range = L.stats.range ?? 280
      const left = full + (L.stats.hold_s ?? 2) - charge
      if (laserMode === "charge") {
        if (charge > 0 || L.cooldown <= 0.05) fire[iLaser] = left > 0.3
        laserBusy = charge > 0
      } else if (laserMode === "shoot" && allowed) {
        if (charge > 0) {
          laserBusy = true
          // hitscan: release only when the beam will land (aim after slew + target drift over one tick)
          const p = hitProb(missDist(me, direct, LAT), direct.sigma, radius)
          const ok = d <= range && los && p > RP.laserNeed
          fire[iLaser] = !((charge >= full - 0.02 && ok) || left < 0.2)
        } else if (L.cooldown <= 0.05 && d <= range * 0.97 && los && !this.shortRisk(tr, d)) {
          fire[iLaser] = true
          laserBusy = true
        }
      } else if (charge > 0) fire[iLaser] = left > 0.3
    }
    let lightningOn = false
    if (iLight >= 0 && lightOk && allowed) {
      const L = slots[iLight]!
      const range = L.stats.range ?? 45
      const half = (((L.stats.cone_deg ?? 30) * Math.PI) / 180) * 0.5
      const reserve = tr.kind === "npc" || tr.hp / tr.maxHp < 0.25 ? 6 : 18
      if (d < range * 0.92 && me.energy > reserve) {
        lightningOn = true
        // the arc takes the nearest thing in the cone: steer the cone off nearer drones/crates
        const yaw = this.lightningYaw(muz, tr, direct.yaw, d, half)
        if (yaw !== null) {
          aim = { ...direct, yaw }
          const ey = Math.abs(angDiff(yaw, me.aim[0])) - turn * LAT
          if (L.cooldown <= 0.1 && ey < half * 0.55 && los) fire[iLight] = true
        }
      }
    }
    if (iGun >= 0) {
      const G = slots[iGun]!
      const lead = leadAim(m, muz, tr, G.stats.speed ?? 252, LAT, off, this.g)
      if (!laserBusy && !lightningOn) aim = lead
      const ammo = G.ammo ?? 1
      const okRange = lead.dist <= (G.stats.range ?? 230) * 0.98
      const laserOk = !laserBusy || d < 40
      const spread = (((G.stats.spread_deg ?? 0.6) * Math.PI) / 180) * lead.dist
      const p = hitProb(missDist(me, lead, LAT), Math.hypot(lead.sigma, spread), radius + 0.3)
      const need = tr.kind === "npc" ? 0.2 : RP.gunNeed
      const gunLos = m.los(muz[0], muz[1], muz[2], lead.pt[0], lead.pt[1], lead.pt[2])
      if (gunOk && allowed && G.cooldown <= 0.1 && ammo > 0 && !(G.reload ?? 0) && okRange && laserOk && gunLos && p > need) fire[iGun] = true
      if (ammo === 0 && !(G.reload ?? 0)) reload = true
      if (!gunOk && ammo < (G.stats.mag ?? 12) * 0.5 && !(G.reload ?? 0)) reload = true
    }
    return { aim, fire, reload }
  }

  /** A yaw that keeps `tr` in the lightning cone but nearer drones, crates and mechs out of it. */
  private lightningYaw(muz: V3, tr: Track, yaw0: number, d: number, half: number): number | null {
    const w = this.w
    const blockers: [number, number][] = []
    const add = (x: number, y: number, id: number) => {
      if (id === tr.id) return
      const bd = Math.hypot(x - muz[0], y - muz[1])
      if (bd < d) blockers.push([Math.atan2(y - muz[1], x - muz[0]), bd])
    }
    for (const e of w.tracks.values()) if (e.seenT === w.t) add(e.pos[0], e.pos[1], e.id)
    for (const c of w.crates.values()) add(c.pos[0], c.pos[1], c.id)
    if (!blockers.length) return yaw0
    for (const off of [0, 0.35, -0.35, 0.6, -0.6, 0.8, -0.8]) {
      const y = yaw0 + off * half
      if (blockers.every(([b]) => Math.abs(angDiff(b, y)) > half * 1.05)) return y
    }
    return null
  }

  /** Is this target holding lightning close enough to short our laser? */
  private shortRisk(tr: Track, d: number) {
    return tr.weapons.includes("lightning") && d < 50
  }

  /** Track for a farm goal id (NPC from tracks, crate from memory). */
  private farmTrack(id: number): Track | null {
    const tr = this.w.tracks.get(id)
    if (tr) return tr.seenT === this.w.t ? tr : null
    const c = this.w.crates.get(id)
    if (!c) return null
    return { id: c.id, kind: "npc", pos: c.pos, vel: [0, 0, 0], aim: [0, 0], hp: c.hp, maxHp: 300, cubes: 0, weapons: [], charging: false, seenT: this.w.t, firstT: 0, hitUsT: -99, hitByUsT: -99, laserT: -99, hist: [], hurtByOtherT: -99 }
  }

  /** Should we take a weapon of this kind? (and which slot to drop) */
  wants(kind: string, slots: SelfObs["weapons"], safe: boolean): { ok: boolean; drop?: number } {
    if (kind !== "laser" && kind !== "lightning") return { ok: false }
    if (slots.some((s) => s?.kind === kind)) return { ok: false }
    const empty = slots.findIndex((s) => !s)
    if (empty >= 0) return { ok: true }
    const mortar = slots.findIndex((s) => s?.kind === "mortar")
    if (mortar >= 0 && !(slots[mortar] as WeaponObs).charge) return { ok: true, drop: mortar }
    const gun = slots.findIndex((s) => s?.kind === "gun")
    if (gun >= 0 && safe && !RP.keepGun) return { ok: true, drop: gun }
    return { ok: false }
  }

  /** Start moving to the next circle early enough, before its shrink starts. */
  private needRotate(obs: Observation, x: number, y: number, t: number): boolean {
    const z = obs.zone
    const R = z.next_radius
    const d = Math.hypot(x - z.next_center[0], y - z.next_center[1])
    const late = R <= RP.lateRadius
    const inner = R <= 0 ? 4 : R <= 25 ? R * 0.4 : late || R < 45 ? R * 0.5 : R * 0.75
    if (d <= inner) return false
    // endgame: be on the final circle early, every meter from the last point costs zone damage
    if (late) return true
    const travel = (d - inner) / 10 + 12
    return t > z.shrink_start - travel - 10
  }

  /** Keep live viewsheds for the (up to) 3 most dangerous known mechs. */
  private updateViewsheds(t: number, x: number, y: number) {
    const w = this.w
    const cand: Track[] = []
    for (const e of w.tracks.values()) if (e.kind === "mech" && t - e.seenT < 4 && Math.hypot(e.pos[0] - x, e.pos[1] - y) < 260) cand.push(e)
    const danger = (e: Track) => Math.hypot(e.pos[0] - x, e.pos[1] - y) - (t - e.hitUsT < 6 ? 200 : 0) - (e.weapons.includes("laser") ? 40 : 0)
    cand.sort((a, b) => danger(a) - danger(b))
    let recomputed = 0
    this.vsActive = Math.min(3, cand.length)
    for (let i = 0; i < this.vsActive; i++) {
      const e = cand[i]
      const vs = (this.vsPool[i] ??= new Viewshed(this.m))
      const ez = e.pos[2] + 8 * (1 + this.perCube * e.cubes) + (e.weapons.includes("laser") ? 2 : 0)
      const stale = this.vsIds[i] !== e.id || Math.hypot(vs.ex - e.pos[0], vs.ey - e.pos[1]) > 4 || Math.abs(vs.ez - ez) > 2 || t - vs.t > 0.6
      if (stale && recomputed < 2) {
        vs.compute(e.pos[0], e.pos[1], ez, t)
        this.vsIds[i] = e.id
        recomputed++
      }
    }
  }

  /** How many tracked enemies would see a mech standing on nav node n. */
  exposedAt(n: number): number {
    let c = 0
    for (let i = 0; i < this.vsActive; i++) if (this.vsPool[i].seen(n)) c++
    return c
  }

  /** Practice hold spot (v6): inside the next circle, hugging a wall. */
  private zoneGoalPractice(obs: Observation, x: number, y: number, rq: number): V2 {
    const z = obs.zone
    const key = `${z.next_center[0]},${z.next_center[1]},${z.next_radius}`
    if (this.holdKey === key && this.holdGoal) return this.holdGoal
    const [cx, cy] = z.next_center
    const R = z.next_radius
    const want = R <= 0 ? 0 : R <= 25 ? R * 0.2 : R <= RP.lateRadius ? R * 0.35 : R < 45 ? R * 0.3 : R * 0.55
    const d = Math.hypot(x - cx, y - cy)
    let gx = x, gy = y
    if (d > want) {
      gx = cx + ((x - cx) / d) * want
      gy = cy + ((y - cy) / d) * want
    }
    const m = this.m
    const comp = m.comp(rq)
    const s = m.snap(x, y, rq, -1, 6)
    const myComp = s >= 0 ? comp[s] : -1
    const n = m.snap(gx, gy, rq, myComp, 60)
    if (n >= 0) (gx = m.nodeX(n)), (gy = m.nodeY(n))
    // prefer a spot hugging a wall nearby (fewer angles to be shot from)
    if (R >= 45 && R > RP.lateRadius) {
      let bs = Infinity
      let bx = gx, by = gy
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2
        for (const r of [0, 8, 16, 26, 38]) {
          if (r === 0 && k > 0) continue
          const px = gx + Math.cos(a) * r, py = gy + Math.sin(a) * r
          const q = m.nodeOf(px, py)
          if (!m.passable(q, rq) || (myComp >= 0 && comp[q] !== myComp)) continue
          if (Math.hypot(px - cx, py - cy) > R * 0.7) continue
          const cl = m.nClear[q]
          const sc = r * 0.15 + (cl > rq + 2.5 ? 6 : 0) + Math.abs(cl - (rq + 1)) * 0.8
          if (sc < bs) (bs = sc), (bx = m.nodeX(q)), (by = m.nodeY(q))
        }
      }
      gx = bx
      gy = by
    }
    this.holdGoal = [gx, gy]
    this.holdKey = key
    return this.holdGoal
  }

  /**
   * Our nest inside the next circle: a reachable spot few observers can see from afar (openness
   * map), out of the live viewsheds, close to us. Recomputed when the zone plan changes or when a
   * known enemy can see the current one (we have been found).
   */
  private zoneGoal(obs: Observation, x: number, y: number, rq: number): V2 {
    const z = obs.zone
    const t = obs.t
    const key = `${z.next_center[0]},${z.next_center[1]},${z.next_radius}`
    const m = this.m
    const holdNode = this.holdGoal ? m.nodeOf(this.holdGoal[0], this.holdGoal[1]) : -1
    const spotted = this.holdGoal !== null && this.exposedAt(holdNode) > 0 && t - this.holdT > 4
    if (this.holdKey === key && this.holdGoal && !spotted) return this.holdGoal
    const [cx, cy] = z.next_center
    const R = z.next_radius
    const late = R <= RP.lateRadius
    const want = R <= 0 ? 0 : R <= 25 ? R * 0.2 : late ? R * 0.35 : R < 45 ? R * 0.3 : R * 0.55
    const d = Math.hypot(x - cx, y - cy)
    let gx = x, gy = y
    if (d > want) {
      gx = cx + ((x - cx) / d) * want
      gy = cy + ((y - cy) / d) * want
    }
    const comp = m.comp(rq)
    const s0 = m.snap(x, y, rq, -1, 6)
    const myComp = s0 >= 0 ? comp[s0] : -1
    const n0 = m.snap(gx, gy, rq, myComp, 60)
    if (n0 >= 0) (gx = m.nodeX(n0)), (gy = m.nodeY(n0))
    // late: stay within a few meters of the final area; earlier: anywhere comfortably inside
    const limit = late ? Math.max(5, want + 5) : R * 0.7
    const rings = late ? [0, 3, 6, 10] : [0, 6, 12, 20, 30, 42, 56]
    let best = Infinity
    let bx = gx, by = gy
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2
      for (const r of rings) {
        if (r === 0 && k > 0) continue
        const px = gx + Math.cos(a) * r, py = gy + Math.sin(a) * r
        const q = m.nodeOf(px, py)
        if (!m.passable(q, rq) || (myComp >= 0 && comp[q] !== myComp)) continue
        if (Math.hypot(px - cx, py - cy) > limit) continue
        const far = m.openFar[q] / 255, near = m.openNear[q] / 255
        let cost = 3 * far + (this.hasLightning ? -0.5 : 0.3) * near
        cost += 0.012 * Math.hypot(px - x, py - y) + 0.02 * r
        cost += 2.5 * this.exposedAt(q)
        if (m.nClear[q] > rq + 3) cost += 0.3
        if (late) cost += 0.08 * Math.hypot(px - cx, py - cy)
        if (cost < best) (best = cost), (bx = m.nodeX(q)), (by = m.nodeY(q))
      }
    }
    this.holdGoal = [bx, by]
    this.holdKey = key
    this.holdT = t
    return this.holdGoal
  }

  /** A supply drop worth going for: reachable, not contested, inside the zone. */
  private dropGoal(obs: Observation, x: number, y: number, t: number, enemies: Track[], hpFrac: number): DropObs | null {
    let best: DropObs | null = null
    let bd = Infinity
    const meId = obs.self.id
    for (const d of obs.drops) {
      const dist = Math.hypot(d.pos[0] - x, d.pos[1] - y)
      const maxD = hpFrac < 0.6 ? 320 : 240
      if (dist > maxD) continue
      const travel = dist / 11
      if (d.lands_in > travel + 8) continue
      if (d.holder !== null && d.holder !== meId) continue
      if (enemies.some((e) => Math.hypot(e.pos[0] - d.pos[0], e.pos[1] - d.pos[1]) < 45 && this.w.t - e.seenT < 1)) continue
      if (this.w.zoneMargin(d.pos[0], d.pos[1], t + travel + 6) < 3) continue
      if (dist < bd) (bd = dist), (best = d)
    }
    return best
  }

  /** Where to go when nothing threatens us: weapons, cubes, farm targets, exploring. */
  private lootGoal(obs: Observation, x: number, y: number, slots: SelfObs["weapons"], nearestD: number, t: number, hpFrac: number): Goal | null {
    const w = this.w, m = this.m
    let best: Goal | null = null
    let bs = Infinity
    const late = t > RP.lateT
    const consider = (pos: V2, kind: Goal["kind"], id: number, weight: number, maxD: number) => {
      const d = Math.hypot(pos[0] - x, pos[1] - y)
      if (d > (late ? Math.min(maxD, 15) : maxD)) return
      if (w.zoneMargin(pos[0], pos[1], t + d / 10 + 8) < 6) return
      const sc = d * weight
      if (sc < bs) (bs = sc), (best = { pos, kind, id })
    }
    const armed = slots.some((s) => s?.kind === "laser") && slots.some((s) => s?.kind === "lightning")
    for (const p of w.pickups.values()) {
      if (!this.wants(p.kind, slots, nearestD > 80).ok) continue
      const c = m.cellOf(p.pos[0], p.pos[1])
      if (c < 0 || m.wall[c] || Math.abs(p.pos[2] - m.groundAt(p.pos[0], p.pos[1])) > 2.5) continue
      consider([p.pos[0], p.pos[1]], "pickup", p.id, p.kind === "lightning" ? 0.35 : 0.55, nearestD > 100 ? 260 : 100)
    }
    for (const c of w.cubes.values()) {
      if (Math.abs(c.pos[2] - m.surfAt(c.pos[0], c.pos[1])) > 3) continue
      consider([c.pos[0], c.pos[1]], "cube", c.id, 0.45, nearestD > 60 ? 140 : 40)
    }
    // go back to where we killed someone: its cubes are there
    if (nearestD > 80 && hpFrac > 0.6) for (const k of w.killSites) consider([k.pos[0], k.pos[1]], "cube", -2, 0.5, 160)
    // farm drones and crates for cubes (and crate weapons) while it is calm
    if (nearestD > 140 && hpFrac > 0.5 && !late && w.recentDamage(5) === 0) {
      for (const n of w.liveNpcs()) consider([n.pos[0], n.pos[1]], "farm", n.id, 1.1, 130)
      for (const c of w.crates.values())
        if (Math.abs(c.pos[2] - m.groundAt(c.pos[0], c.pos[1])) < 3) consider([c.pos[0], c.pos[1]], "farm", c.id, armed ? 1.3 : 0.9, 110)
    }
    if (best) return best
    // nothing known: explore while we still miss a weapon
    if (!armed && t < 240 && nearestD > 100) {
      if (!this.exploreGoal || t - this.exploreT > 14 || Math.hypot(this.exploreGoal[0] - x, this.exploreGoal[1] - y) < 6) {
        this.exploreGoal = this.pickExplore(obs, x, y)
        this.exploreT = t
      }
      if (this.exploreGoal) return { pos: this.exploreGoal, kind: "explore", id: -1 }
    }
    return null
  }

  private pickExplore(obs: Observation, x: number, y: number): V2 | null {
    const m = this.m
    const rq = this.nav.rq
    const comp = m.comp(rq)
    const s = m.snap(x, y, rq, -1, 4)
    if (s < 0) return null
    const z = obs.zone
    for (let k = 0; k < 30; k++) {
      const a = this.rnd() * Math.PI * 2, r = 50 + this.rnd() * 90
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r
      if (Math.hypot(px - z.next_center[0], py - z.next_center[1]) > z.next_radius * 0.85) continue
      const n = m.nodeOf(px, py)
      if (!m.passable(n, rq) || comp[n] !== comp[s]) continue
      return [px, py]
    }
    return null
  }

  /** Close-range fight: circle-strafe at lightning range, or keep 25-40 m with the gun. */
  private brawlMove(x: number, y: number, tr: Track, lightning: boolean, rq: number, t: number): V2 {
    const d = Math.hypot(tr.pos[0] - x, tr.pos[1] - y)
    const [lo, hi] = lightning ? [12, 30] : [22, 40]
    const radial = d > hi ? 0.7 : d < lo ? -0.7 : 0
    return this.jink(x, y, tr, rq, t, 0.95, radial)
  }

  /** Open-ground fight: strafe with random direction changes, keeping a preferred range. */
  private fightMove(x: number, y: number, tr: Track, lightning: boolean, laser: boolean, rq: number, t: number, hpFrac: number): V2 {
    const d = Math.hypot(tr.pos[0] - x, tr.pos[1] - y)
    let lo = 30, hi = 70
    if (lightning && (hpFrac > 0.5 || tr.hp / tr.maxHp < 0.35)) (lo = 10), (hi = 30)
    else if (laser) (lo = 60), (hi = 170)
    if (d > hi + 20) return this.nav.steer(x, y, tr.pos[0], tr.pos[1], t, 4000).dir
    const radial = d > hi ? 0.8 : d < lo ? -0.8 : 0
    return this.jink(x, y, tr, rq, t, 0.9, radial)
  }

  private jink(x: number, y: number, tr: Track | null, rq: number, t: number, amp: number, radial = 0): V2 {
    if (t > this.jinkT) {
      this.jinkSign = this.rnd() < 0.5 ? -1 : 1
      this.jinkT = t + 0.3 + this.rnd() * 0.5
    }
    const b = tr ? Math.atan2(tr.pos[1] - y, tr.pos[0] - x) : this.scanYaw
    const rx = Math.cos(b), ry = Math.sin(b)
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = this.jinkSign
      let dx = rx * radial + -ry * s * amp, dy = ry * radial + rx * s * amp
      const l = Math.hypot(dx, dy) || 1
      dx /= l
      dy /= l
      if (this.m.walkLine(x, y, x + dx * 5, y + dy * 5, this.nav.rq) && this.w.zoneMargin(x + dx * 8, y + dy * 8, t + 3) > 3) return [dx, dy]
      this.jinkSign = -this.jinkSign
    }
    // never freeze under fire: best walkable direction, preferring sideways and staying in the zone
    let best: V2 = [0, 0]
    let bs = -Infinity
    const want = Math.atan2(ry * radial + rx * this.jinkSign, rx * radial - ry * this.jinkSign)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2
      const dx = Math.cos(a), dy = Math.sin(a)
      if (!this.m.walkLine(x, y, x + dx * 5, y + dy * 5, this.nav.rq)) continue
      const sc = -Math.abs(angDiff(a, want)) + this.w.zoneMargin(x + dx * 8, y + dy * 8, t + 3) * 0.05
      if (sc > bs) (bs = sc), (best = [dx, dy])
    }
    return best
  }

  /** A reachable point up to 45 m away, hidden from `threat`, inside the zone. */
  private findCover(x: number, y: number, threat: V3, rq: number, t: number): V2 | null {
    const m = this.m, w = this.w
    const comp = m.comp(rq)
    const s = m.snap(x, y, rq, -1, 4)
    const myComp = s >= 0 ? comp[s] : -1
    let best: V2 | null = null
    let bs = -Infinity
    const tz = threat[2] + 8
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      for (const r of [10, 20, 32, 45]) {
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r
        const n = m.nodeOf(px, py)
        if (!m.passable(n, rq) || (myComp >= 0 && comp[n] !== myComp)) continue
        if (w.zoneMargin(px, py, t + 8) < 5) continue
        const hidden = !m.los(threat[0], threat[1], tz, px, py, m.surfAt(px, py) + 5)
        let sc = (hidden ? 60 : 0) + 0.25 * Math.hypot(px - threat[0], py - threat[1]) - 0.6 * r
        if (!m.walkLine(x, y, px, py, rq)) sc -= 12
        if (sc > bs) (bs = sc), (best = [px, py])
      }
    }
    return best
  }

  /** Move away from a mortar shell about to land near us. */
  private mortarDodge(obs: Observation, x: number, y: number): V2 | null {
    const mo = this.hello.config.weapons.mortar
    const g = mo.gravity ?? 22
    const r = (mo.splash_radius ?? 7) * 1.4 + 3
    for (const p of obs.projectiles) {
      if (p.kind !== "mortar") continue
      const L = shellLanding(this.m, p.pos, p.vel, g)
      if (!L || L.t > 3) continue
      const d = Math.hypot(L.x - x, L.y - y)
      if (d < r) {
        const dx = x - L.x, dy = y - L.y
        const l = Math.hypot(dx, dy) || 1
        return [dx / l, dy / l]
      }
    }
    return null
  }

  /** Where to look when we are not shooting. */
  private lookDir(x: number, y: number, z: number, eyeZ: number, enemies: Track[], t: number, mv: V2): [number, number] {
    const w = this.w
    const lastHurt = w.hurt.length ? w.hurt[w.hurt.length - 1] : null
    if (lastHurt && t - lastHurt.t < 2.5 && lastHurt.bearing !== null) return [lastHurt.bearing, 0]
    let near: Track | null = null
    let nd = Infinity
    for (const e of enemies) {
      const d = Math.hypot(e.pos[0] - x, e.pos[1] - y)
      if (d < nd) (nd = d), (near = e)
    }
    if (near) {
      const a = aimAt([x, y, eyeZ], [near.pos[0], near.pos[1], near.pos[2] + 4.5])
      return [a.yaw, a.pitch]
    }
    const loud = w.heard.filter((h) => LOUD.has(h.kind) && t - h.t < 2.5)
    if (loud.length) return [loud[loud.length - 1].bearing, 0]
    const ml = Math.hypot(mv[0], mv[1])
    if (ml > 0.3) {
      const my = Math.atan2(mv[1], mv[0])
      this.scanYaw = my
      return [my + Math.sin(t * 1.3) * 1.1, 0]
    }
    // holding: watch the open sectors of our spot (where enemies can come from or be shot)
    const q = this.m.nodeOf(x, y)
    const mask = q >= 0 && this.ninja ? this.m.openMask[q] : 0
    if (mask) {
      const secs: number[] = []
      for (let k = 0; k < 16; k++) if (mask & (1 << k)) secs.push((k / 16) * Math.PI * 2)
      const i = Math.floor(t / 1.2) % secs.length
      return [secs[i], 0]
    }
    this.scanYaw += 0.3
    return [this.scanYaw, 0]
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100
const round3 = (v: number) => Math.round(v * 1000) / 1000
