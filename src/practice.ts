import { draw, type BotAction, type DropObs, type Hello, type Observation, type SelfObs } from "../mechfight.ts"
import type { GameMap } from "./map.ts"
import type { Navigator } from "./nav.ts"
import type { Track, World } from "./world.ts"
import { aimAt, centerOffset, clampPitch, hitRadius, leadAim, predict2, shellLanding, type Aim } from "./combat.ts"
import { angDiff, clamp, type V2, type V3 } from "./geom.ts"

/** Survival-first upgrade order. */
const UPG = ["plating", "armor", "nanites", "laser_damage", "lightning_efficiency", "gun_rate", "laser_charge", "gun_damage", "capacitor", "reactor", "gyros", "lightning_range", "gun_mag", "sensors", "gun_velocity", "servos", "jets", "lightning_chain", "laser_pierce"]
/** Tunables of the practice core (BOTP env var overrides them in local tests). */
export const PP = {
  laserRange: 145,
  gunRange: 85,
  lightRange: 28,
  retreatHp: 0.38,
  retreatExit: 0.8,
  manyHp: 0.6,
  manyDps: 110,
  finishFrac: 0.3,
  strafe: 0.85,
  drops: false,
  killSites: false,
  /** economy loop: cube/weapon detours even mid-fight, wider farming, opportunistic farm shots */
  econ: false,
  /** conditional "losing" retreat with a 6 s hide window, then heal in cover */
  ttun: false,
  /** never drop the gun: gun + best special (laser preferred) */
  keepGun: false,
  /** strafe flip timing: next flip after strafeMin + rnd * strafeSpan seconds, flip probability */
  strafeMin: 1.0,
  strafeSpan: 1.6,
  strafeP: 0.7,
  /** boost while dodging bullets (energy above this; 999 = never) */
  dodgeBoost: 999,
  /** "losing" thresholds: alone vs healthier target, 2+ close, 3+ close; heal below / inside hide window */
  loseHp1: 0.35,
  loseHp2: 0.55,
  loseHp3: 0.8,
  healHp: 0.55,
  healHide: 0.9,
  hideS: 6,
  cubeHi: 70,
  cubeLo: 40,
  /** ignore weapon pickups more than 2 m above the ground */
  groundOnly: false,
  /** cap speed at 4.6 m/s (silent steps) when calm */
  quiet: false,
  /** go for supply drops from roam when calm (in addition to / instead of the priority mode) */
  dropRoam: true,
  /** v11 fidelity switches (see the diff with the 4.75 reference): */
  duelPick: false,
  laserLightBlock: false,
  aimComp: false,
  gunLos: false,
  cubeMemS: 3,
  /** plain linear gun lead (2 iterations, +0.05 s, vertical clamp 6 m) instead of the strafe model */
  linearLead: false,
  /** practice core: "lance" (Practice, best real 4.75) or "econ" (Econ core) */
  core: "econ" as "lance" | "econ",
  /** econ core preferred fight distances (laser / gun-only / lightning) */
  econLaser: 145,
  econGun: 70,
  econLight: 28,
  /** econ gun lead: "ttun" (linear with track age) or "ours" (strafe model from the firing tick) */
  econAim: "ttun" as "ttun" | "ours",
  /** econ: back off from drones shooting us when badly hurt */
  econDroneBack: false,
  /** free-for-all (econ core): only engage mechs that fight us, are weak, busy with someone else or close; hide from the rest */
  ffaPick: false,
  /** free-for-all (econ core): retreat to cover when two different mechs hit us */
  ffaRetreat: false,
  /** free-for-all (econ core): how long hits / other fights keep a mech engageable (s) */
  ffaMemS: 3,
  /** free-for-all opening: stay out of every known mech's sight, fight only attackers and close mechs */
  ffaLurk: false,
  /** the opening lasts until this time (s) or until this many mechs are left */
  lurkT: 75,
  lurkAlive: 9,
  /** free-for-all: with this many mechs left or fewer, hold a sheltered spot inside the next circle when nothing is targeted (0 = off) */
  ffaHold: 0,
  /** free-for-all: prefer targets that are busy with someone else or weak */
  ffaFocus: false,
  /** free-for-all: without a laser, take cover from a laser carrier beyond this distance unless it is weak (0 = off) */
  ffaOutgun: 70,
  /** apply the laser-carrier cover rule in practice too */
  outgunAll: false,
  /** econ: turn toward an unseen attacker while the target is not the one hitting us; attackers seen later get the hit bonus */
  turnToHit: false,
  /** econ retreat thresholds scale (1 = TTUN values 0.35 / 0.55 / 0.8) */
  econLoseK: 0.3,
  /** econ: heal (no target) below this hp fraction */
  econHealHp: 0.55,
  /** econ: scale of the mid-fight detours to cubes / weapons (1 = TTUN distances) */
  econDetourCube: 1,
  econDetourPick: 1,
  /** econ: weight of the weapon bonus in the out-of-fight loot choice (1 = TTUN) */
  econLootW: 1,
  /** econ: crates (half drop a weapon) - bonus in the loot choice and reach (TTUN: 0 and 150 m) */
  econCrateBonus: 0,
  econCrateR: 150,
  /** econ: target score penalty for laser carriers (positive = prefer others) */
  econTgtLaser: 0,
  /** econ: weight of the target's hp in the target score (TTUN 90 per full health) */
  econTgtHpW: 90,
  /** econ: finish a target below this hp fraction (TTUN 0.2) */
  econFinish: 0.2,
  /** practice: from this time on, stay out of sight and only answer attackers / close mechs (0 = off) */
  lateEvadeT: 0,
  /** econ: upgrade order override (empty = survival-first TTUN order) */
  econUpg: [] as string[],
  /** econ: close in to this distance to finish a target below econFinishHp (0 = off) */
  econFinishR: 14,
  econFinishHp: 0.38,
  /** econ: release a partly charged laser when 80% of its damage already kills the target */
  econLethal: true,
  /** free-for-all: a visible laser charging at us -> break its line of sight (cover within 18 m) or side-step with boost */
  ffaLaserLos: false,
  /** cover = out of sight (tree crowns count beyond near range) instead of out of the line of fire: "ffa" only in free-for-all, "all" always */
  coverSees: "off" as "off" | "ffa" | "all",
  /** hit by a mech we cannot see and nothing targeted: run to cover from the hit bearing instead of looting or healing in place */
  unseenCover: "off" as "off" | "ffa" | "all",
  /** practice ("lance") core, squad-mode methods of the public giddy bot (5.8): */
  /** retreat = TTUN losing rule, held only 1.5 s after the last losing signal */
  sqLose: false,
  /** close in to this distance on a target below sqFinishHp (0 = off) */
  sqFinishR: 0,
  sqFinishHp: 0.38,
  /** release a partly charged laser when 80% of its damage kills */
  sqLethal: false,
  /** go for cubes this close even mid-fight (x0.57 when below half hp; 0 = off) */
  sqFightCube: 0,
  /** only engage mechs that are close, hit us, close in, aim at us, are weak, or late game; max 240 m */
  sqEngage: false,
  /** econ: when idle, explore the nearest unvisited 100 m grid point inside the zone instead of drifting to its centre */
  econExplore: false,
  /** econ (practice): only engage mechs that are close, hit us, close in, aim at us, are weak, or late game */
  econEngage: false,
}
try {
  const env = typeof process !== "undefined" ? process.env.BOTP : undefined
  if (env) Object.assign(PP, JSON.parse(env))
} catch {}
const TICK = 0.05
const SPAN = 0.1

type Host = { m: GameMap; w: World; nav: Navigator; hello: Hello; rnd: () => number; perCube: number; g: number }
type Mode = "zone" | "cover" | "drop" | "cube" | "loot" | "fight" | "roam"
type Seen = { e: Track; d: number; vis: boolean; shoot: boolean }

/**
 * Practice core: decide a movement mode in a fixed priority order, and shoot the best target in
 * every mode. Fight in the open at a fixed range per weapon with lateral strafes, break off only
 * when low or outnumbered, finish weak targets, dodge what can be dodged.
 */
export class Practice {
  h: Host
  state = "init"
  targetId = -1
  retreating = false
  strafeSign = 1
  strafeT = 0
  prevDir: V2 = [1, 0]
  cover: { p: V2; vis: number; tick: number } | null = null
  tick = 0
  wdPos: V2 = [0, 0]
  wdTick = 0
  wdStrikes = 0
  climbUntil = -1
  scanYaw = 0
  hideUntil = -1
  loseAt = -99
  lootBoosting = false
  stuckAcc = 0
  detourUntil = -1
  detourDir: V2 = [1, 0]
  dodgeSide = new Map<number, number>()

  constructor(h: Host) {
    this.h = h
  }

  pickUpgrade(obs: Observation): number {
    let best = 0, bestR = Infinity
    obs.offer!.choices.forEach((c, i) => {
      let r = UPG.indexOf(c.id)
      if (r < 0) r = 50
      if (r < bestR) (bestR = r), (best = i)
    })
    return best
  }

  act(obs: Observation, T0: number): BotAction {
    const { m, w, nav, hello } = this.h
    const cfg = hello.config
    const me = obs.self, t = obs.t
    const [x, y, z] = me.pos
    const st = me.stats
    this.tick++
    const scale = (st.radius ?? 2.5) / (cfg.mech.radius ?? 2.5)
    const rq = (st.radius ?? 2.5) + 0.9
    nav.rq = rq
    nav.costFn = null
    const walk = st.walk_speed ?? 11.7
    const act: BotAction = {}
    if (obs.offer) act.pick = this.pickUpgrade(obs)
    const slots = me.weapons
    const iGun = slots.findIndex((s) => s?.kind === "gun")
    const iLaser = slots.findIndex((s) => s?.kind === "laser")
    const iLight = slots.findIndex((s) => s?.kind === "lightning")
    const hasLaser = iLaser >= 0, hasLight = iLight >= 0
    const gunOnly = !hasLaser && !hasLight
    const hpFrac = me.hp / me.max_hp
    const eye: V3 = [x, y, z + (st.eye_height ?? 8)]
    const muz: V3 = [x, y, z + (st.muzzle_height ?? 7)]
    const dTo = (p: ArrayLike<number>) => Math.hypot(p[0] - x, p[1] - y)

    // ---------- damage intake ----------
    const dpsIn = w.recentDamage(2.5) / 2.5
    let hiddenBearing: number | null = null
    for (let k = w.hurt.length - 1; k >= 0; k--) {
      const h = w.hurt[k]
      if (t - h.t > 1.5) break
      if (h.weapon === "npc" || h.bearing === null) continue
      const tr = h.by !== null ? w.tracks.get(h.by) : undefined
      if (!tr || tr.seenT !== t) {
        hiddenBearing = h.bearing
        break
      }
    }

    // ---------- enemies ----------
    const seen: Seen[] = []
    for (const e of w.liveMechs()) {
      const d = dTo(e.pos)
      if (d > 300) continue
      const es = 1 + this.h.perCube * e.cubes
      const late = performance.now() - T0 > 15 && d > 60
      const vis = late ? false : m.los(eye[0], eye[1], eye[2], e.pos[0], e.pos[1], e.pos[2] + 8 * es)
      const shoot = late ? vis : m.los(muz[0], muz[1], muz[2], e.pos[0], e.pos[1], e.pos[2] + centerOffset(e, this.h.perCube)) || vis
      seen.push({ e, d, vis, shoot })
    }
    const threats = seen.filter((s) => s.vis && s.d < 240)
    const nThreat = threats.length + (hiddenBearing !== null ? 1 : 0)

    // ---------- target ----------
    let T: Seen | null = null
    let ts = Infinity
    const lateGame = obs.zone.next_radius <= 70 || obs.alive <= 3
    for (const s of seen) {
      const e = s.e
      if (PP.sqEngage) {
        const toMe = Math.atan2(y - e.pos[1], x - e.pos[0])
        const aimed = Math.abs(angDiff(e.aim[0], toMe)) < 0.22
        const closing = e.vel[0] * Math.cos(toMe) + e.vel[1] * Math.sin(toMe) > 3
        const eng = s.d < 60 || t - e.hitUsT < 6 || lateGame || (closing && s.d < 180) || (e.hp < 0.4 * e.maxHp && s.d < 160) || (aimed && s.d < 190)
        if (!eng || s.d > 240) continue
      }
      let sc = s.d + 0.2 * e.hp
      if (e.hp <= 0.3 * e.maxHp) sc -= 100
      if (!s.shoot) sc += 400
      if (e.id === this.targetId) sc -= 120
      if (t - e.hitUsT < 4) sc -= 40
      if (s.d > 285) sc += 1000
      if (sc < ts) (ts = sc), (T = s)
    }
    const shootable = T !== null && T.shoot && T.d <= 285
    this.targetId = T ? T.e.id : -1
    const dT = T ? T.d : Infinity

    // ---------- flags ----------
    if (!this.retreating && hpFrac < PP.retreatHp && nThreat > 0) this.retreating = true
    if (this.retreating && (hpFrac > PP.retreatExit || (t - w.lastHurtT > 12 && hpFrac > 0.6))) this.retreating = false
    const many = threats.length >= 3 || (threats.length >= 2 && hpFrac < PP.manyHp) || dpsIn > PP.manyDps || hiddenBearing !== null
    const outranged = !hasLaser && threats.some((s) => s.e.weapons.includes("laser") && s.d > 70)
    const finishing = shootable && T!.e.hp <= PP.finishFrac * T!.e.maxHp && dT < 130 && hpFrac > 0.3 && threats.length <= 2
    const crowd = seen.filter((s) => s.vis && s.d < 150).length
    const finishIn = PP.sqFinishR > 0 && shootable && T!.e.hp < PP.sqFinishHp * T!.e.maxHp && hpFrac > 0.42 && crowd <= 2
    const closeFight = (shootable && dT < 40 && (hasLight || hpFrac > 0.5)) || finishing
    let losing = false
    if (PP.ttun) {
      const n160 = seen.filter((s) => s.d < 160 && (s.vis || t - s.e.hitUsT < 3)).length
      const tFrac = T ? T.e.hp / Math.max(1, T.e.maxHp) : 0
      losing = !finishing && ((hpFrac < PP.loseHp1 && T !== null && tFrac > hpFrac + 0.1) || (n160 >= 2 && hpFrac < PP.loseHp2) || (n160 >= 3 && hpFrac < PP.loseHp3))
      if (losing) this.hideUntil = t + PP.hideS
    }
    if (PP.sqLose) {
      const n160 = seen.filter((s) => s.vis && s.d < 160).length
      const tFrac = T ? T.e.hp / Math.max(1, T.e.maxHp) : 1
      let l = (n160 >= 2 && hpFrac < 0.55) || (n160 >= 3 && hpFrac < 0.8) || (T !== null && hpFrac < 0.35 && tFrac > hpFrac + 0.1)
      if (T !== null && tFrac < 0.25 && hpFrac > 0.2 && n160 <= 2) l = false
      if (l) this.loseAt = t
    }

    // ---------- zone ----------
    const zo = obs.zone
    const cur = w.zoneAt(t)
    const nr = zo.next_radius
    const nc = zo.next_center
    const margin = Math.min(30, 0.3 * nr)
    const dNext = Math.hypot(x - nc[0], y - nc[1])
    const need = Math.max(0, dNext - (nr - margin))
    const timeLeft = t < zo.shrink_start ? zo.shrink_start - t : Math.max(0, zo.shrink_end - t)
    const dCur = Math.hypot(x - cur.c[0], y - cur.c[1])
    const urgent = !me.in_zone || dCur > cur.r - 8
    const mustGo = urgent || (need > 0 && need / walk + 12 > timeLeft)
    const safe = (px: number, py: number) => Math.hypot(px - nc[0], py - nc[1]) <= nr - margin / 2 || (!mustGo && Math.hypot(px - cur.c[0], py - cur.c[1]) <= cur.r - 25)

    // ---------- goals ----------
    const drop = PP.drops ? this.dropGoal(obs, x, y, t, seen, hpFrac, walk) : null
    let cube = this.nearestCube(x, y, z, safe, PP.econ ? (hpFrac > 0.5 ? PP.cubeHi : PP.cubeLo) : 70)
    // the cubes of the mechs we killed lie where they died: go and get them when nobody is close
    if (!cube && PP.killSites && hpFrac > 0.4 && !seen.some((s) => s.d < 60)) {
      for (const k of w.killSites) {
        const d = dTo(k.pos)
        if (d < 150 && safe(k.pos[0], k.pos[1]) && (!cube || d < cube.d)) cube = { pos: k.pos, d }
      }
    }
    const pick = this.wantedPickup(slots, x, y, z, safe, gunOnly ? 240 : 160)
    const needHeal = PP.ttun && !shootable && (hpFrac < PP.healHp || (t < this.hideUntil && hpFrac < PP.healHide)) && !(cube && cube.d < 40)

    // ---------- mode ----------
    let mode: Mode
    const coverNow = PP.sqLose ? t - this.loseAt < 1.5 && !finishIn : PP.ttun ? losing || needHeal : (this.retreating || many || outranged) && !closeFight
    const fightCube = PP.sqFightCube > 0 && shootable && cube !== null && cube.d < PP.sqFightCube * (hpFrac <= 0.5 ? 0.57 : 1)
    if (urgent) mode = "zone"
    else if (coverNow && !(PP.econ && cube && cube.d < 12)) mode = "cover"
    else if (mustGo) mode = "zone"
    else if (drop) mode = "drop"
    else if (PP.econ && cube && hpFrac > 0.35) mode = "cube"
    else if (fightCube) mode = "cube"
    else if (PP.econ && pick && shootable && pick.d < (gunOnly ? 60 : 35)) mode = "loot"
    else if (!PP.econ && cube && hpFrac > 0.35 && threats.length <= 1 && (cube.d < 10 || !shootable || dT > 60)) mode = "cube"
    else if (gunOnly && pick && t - w.lastHurtT > 1.5 && (!shootable || dT > 50 || pick.d < 20)) mode = "loot"
    else if (shootable) mode = "fight"
    else if (pick) mode = "loot"
    else mode = "roam"

    // ---------- movement ----------
    let mv: V2 = [0, 0]
    let boost = false
    let jump = false
    let goalDist = 0
    const go = (gx: number, gy: number) => {
      if (mustGo && mode !== "zone" && Math.hypot(gx - nc[0], gy - nc[1]) > nr) (gx = nc[0]), (gy = nc[1])
      goalDist = Math.hypot(gx - x, gy - y)
      const spent = performance.now() - T0
      const r = nav.steer(x, y, gx, gy, t, spent > 20 ? 300 : spent > 10 ? 1500 : 5000)
      if (r.jump) jump = true
      if (r.boost) boost = true
      return r.arrived ? ([0, 0] as V2) : r.dir
    }
    let farm: Track | null = null
    switch (mode) {
      case "zone": {
        const p = pick && pick.d < 25 ? pick.pos : nc
        mv = go(p[0], p[1])
        if ((urgent && me.energy > 25) || (need > 60 && me.energy > 60)) boost = true
        break
      }
      case "cover": {
        let cth = threats
        if (!cth.length) cth = seen.slice()
        if (hiddenBearing !== null) {
          const ghost: Track = { ...(seen.length ? seen[0].e : ({ cubes: 0, weapons: [], hist: [] } as unknown as Track)), id: -7, pos: [x + Math.cos(hiddenBearing) * 120, y + Math.sin(hiddenBearing) * 120, z] }
          cth = [...cth, { e: ghost, d: 120, vis: true, shoot: true }]
        }
        const c = this.coverPoint(x, y, z, t, cth, mustGo, nc, nr, cur)
        if (c && (c.vis === 0 || !shootable)) {
          mv = go(c.p[0], c.p[1])
          if (PP.ttun && needHeal && !losing) {
            const l = Math.hypot(mv[0], mv[1])
            if (l > 0.4) mv = [(mv[0] / l) * 0.4, (mv[1] / l) * 0.4]
            if (c.vis === 0 && Math.hypot(c.p[0] - x, c.p[1] - y) < 2) mv = [0, 0]
          } else if (t - w.lastHurtT < 2 && me.energy > 30) boost = true
          this.state = needHeal && !losing ? "heal" : "cover"
        } else if (gunOnly && pick && pick.d < 90 && hpFrac > 0.3) {
          mv = go(pick.pos[0], pick.pos[1])
          this.state = "cover-loot"
        } else if (T) {
          const charge = outranged && hpFrac > 0.5 && threats.length <= 1
          mv = this.fightMove(x, y, T, hasLaser, hasLight, finishing, charge, mustGo, nc, nr, t)
          if (charge && dT > 45 && me.energy > 35) boost = true
        }
        break
      }
      case "drop": {
        const dd = Math.hypot(drop!.pos[0] - x, drop!.pos[1] - y)
        if (dd > drop!.radius * 0.6) mv = go(drop!.pos[0], drop!.pos[1])
        if (dd > 60 && me.energy > 50) boost = true
        break
      }
      case "cube":
        mv = go(cube!.pos[0], cube!.pos[1])
        if (cube!.d > 30 && !seen.some((s) => s.vis && s.d < 80)) {
          if (me.energy > 60) this.lootBoosting = true
          if (this.lootBoosting && me.energy > 22) boost = true
        }
        break
      case "loot":
        mv = go(pick!.pos[0], pick!.pos[1])
        if (pick!.d > 30 && !seen.some((s) => s.vis && s.d < 80)) {
          if (me.energy > 60) this.lootBoosting = true
          if (this.lootBoosting && me.energy > 22) boost = true
        }
        if (pick!.d < 14 && pick!.pos[2] - z > 1.5 && me.energy > 20) this.climbUntil = Math.max(this.climbUntil, t + 0.6)
        break
      case "fight": {
        mv = this.fightMove(x, y, T!, hasLaser, hasLight, finishing, false, mustGo, nc, nr, t, finishIn ? PP.sqFinishR : 0)
        // mid-duel pickups when it is safe enough
        const near = threats.filter((s) => s.d < 90).length
        if (PP.duelPick && hpFrac >= 0.42 && near <= 1) {
          const item = this.duelItem(slots, x, y, z, T!.e, safe)
          if (item) mv = this.steerLocal(x, y, [item[0] - x, item[1] - y])
        }
        break
      }
      case "roam": {
        const r = this.roam(obs, x, y, z, t, hpFrac, nThreat, safe, nc, nr)
        if (r) {
          if (r.farm) farm = r.farm
          mv = r.stand ? this.steerLocal(x, y, [r.p[0] - x, r.p[1] - y], 0.4) : go(r.p[0], r.p[1])
        }
        break
      }
    }
    if (mode !== "cover") this.state = mode
    if (me.energy <= 22 || (mode !== "loot" && mode !== "cube")) this.lootBoosting = false
    // dodges
    const dg = this.dodge2(obs, x, y, seen, hasLight && me.energy > 6, urgent)
    if (dg.laser) {
      mv = [dg.v[0] * 0.9 + mv[0] * 0.1, dg.v[1] * 0.9 + mv[1] * 0.1]
      if (me.energy > 30 && me.grounded) boost = true
    } else if (dg.v[0] || dg.v[1]) {
      mv = [mv[0] + dg.v[0], mv[1] + dg.v[1]]
      const l = Math.hypot(mv[0], mv[1])
      if (l > 1) mv = [mv[0] / l, mv[1] / l]
    }
    if (dg.mortarBoost && me.energy > 20) boost = true
    // stuck detector in every mode: wanting to move but barely moving on the ground
    const spd = Math.hypot(me.vel[0], me.vel[1])
    if (Math.hypot(mv[0], mv[1]) > 0.5 && spd < 2.5 && me.grounded) this.stuckAcc += 0.1
    else this.stuckAcc = Math.max(0, this.stuckAcc - 0.1)
    if (this.stuckAcc > 0.6 && t > this.climbUntil && t > this.detourUntil) {
      this.stuckAcc = 0
      const ahead = m.surfAt(x + mv[0] * 4, y + mv[1] * 4) - z
      if (ahead < 40 && me.energy > 35) this.climbUntil = t + 2.5
      else {
        const a = this.h.rnd() * Math.PI * 2
        this.detourDir = [Math.cos(a), Math.sin(a)]
        this.detourUntil = t + 1.5
      }
    }
    if (t < this.detourUntil) mv = this.detourDir
    // watchdog: not making progress toward a far goal
    if (this.tick - this.wdTick >= 25) {
      const moved = Math.hypot(x - this.wdPos[0], y - this.wdPos[1])
      if (goalDist > 20 && moved < 5) {
        this.wdStrikes++
        nav.reset()
        if (this.wdStrikes >= 2 && me.energy > 35) this.climbUntil = t + 2.5
      } else this.wdStrikes = 0
      this.wdPos = [x, y]
      this.wdTick = this.tick
    }
    if (t < this.climbUntil) {
      jump = me.grounded
      boost = me.grounded || me.energy > 5
    }
    // quiet when calm
    if (PP.quiet && nThreat === 0 && (mode === "roam" || mode === "cube" || mode === "cover")) {
      const cap = 4.6 / walk
      const l = Math.hypot(mv[0], mv[1])
      if (l > cap && !boost) mv = [(mv[0] / l) * cap, (mv[1] / l) * cap]
    }
    if (Math.hypot(mv[0], mv[1]) > 0.1) this.prevDir = [mv[0], mv[1]]

    // ---------- firing (independent of mode) ----------
    const fire: [boolean, boolean] = [false, false]
    let aimYP: [number, number] | null = null
    if (!shootable && !farm) farm = this.farmTarget(x, y, z, t, hpFrac, safe)
    const tgt: Track | null = shootable ? T!.e : farm
    const laserCharging = iLaser >= 0 && (slots[iLaser]!.charge ?? 0) > 0
    const turnToHit = hiddenBearing !== null && !(shootable && dT < 45) && !laserCharging
    if (tgt && !turnToHit) {
      const r = this.fireControl(me, muz, tgt, iGun, iLaser, iLight, seen)
      aimYP = r.aim
      fire[0] = r.fire[0]
      fire[1] = r.fire[1]
      if (r.reload) act.reload = true
    } else {
      if (iGun >= 0) {
        const G = slots[iGun]!
        if (((G.ammo ?? 0) < (G.stats.mag ?? 12) * 0.6 && !(G.reload ?? 0)) || (G.ammo ?? 1) === 0) act.reload = true
      }
      if (iLaser >= 0) {
        const L = slots[iLaser]!
        const c = L.charge ?? 0
        if (c > 0) fire[iLaser] = seen.length > 0 && c < (L.stats.charge ?? 0.75) + 1.5
      }
    }
    if (!aimYP) aimYP = this.look(x, y, eye, t, hiddenBearing, seen, mv)
    const yaw = aimYP[0]
    const pitch = clampPitch(me, aimYP[1])

    // ---------- pickups in reach ----------
    const reach = cfg.loot.pickup_radius ?? 4
    for (const p of w.pickups.values()) {
      if (Math.hypot(p.pos[0] - x, p.pos[1] - y) > reach - 0.3 || Math.abs(p.pos[2] - z) > 3.8) continue
      const want = this.wants(p.kind, slots)
      if (want.ok) {
        act.take = p.id
        if (want.drop !== undefined) act.drop = want.drop
        break
      }
    }

    act.move = [Math.round(mv[0] * 100) / 100, Math.round(mv[1] * 100) / 100]
    act.boost = boost
    act.jump = jump
    act.aim = [Math.round(yaw * 1000) / 1000, Math.round(pitch * 1000) / 1000]
    act.fire = fire
    draw.label(`P:${this.state} hp${Math.round(hpFrac * 100)} thr${nThreat}${T ? " →" + T.e.id + "@" + Math.round(dT) : ""}`)
    return act
  }

  /** Should we take this weapon (and drop which slot)? Laser and lightning only. */
  wants(kind: string, slots: SelfObs["weapons"]): { ok: boolean; drop?: number } {
    if (kind !== "laser" && kind !== "lightning") return { ok: false }
    if (slots.some((s) => s?.kind === kind)) return { ok: false }
    const empty = slots.findIndex((s) => !s)
    if (empty >= 0) return { ok: true }
    if (PP.keepGun) {
      // keep the gun; replace the other special only for a clearly better one (laser > lightning > mortar)
      const pref = (k: string) => (k === "laser" ? 3.2 : k === "lightning" ? 2.5 : 1)
      const other = slots.findIndex((s) => s && s.kind !== "gun")
      const charging = slots.some((s) => s?.kind === "laser" && (s.charge ?? 0) > 0)
      if (other >= 0 && !charging && pref(kind) > pref(slots[other]!.kind) + 0.5) return { ok: true, drop: other }
      return { ok: false }
    }
    const mortar = slots.findIndex((s) => s?.kind === "mortar")
    if (mortar >= 0) return { ok: true, drop: mortar }
    const gun = slots.findIndex((s) => s?.kind === "gun")
    const charging = slots.some((s) => s?.kind === "laser" && (s.charge ?? 0) > 0)
    if (gun >= 0 && !charging) return { ok: true, drop: gun }
    return { ok: false }
  }

  private wantedPickup(slots: SelfObs["weapons"], x: number, y: number, z: number, safe: (x: number, y: number) => boolean, maxD: number): { pos: V3; d: number } | null {
    let best: { pos: V3; d: number } | null = null
    for (const p of this.h.w.pickups.values()) {
      if (!this.wants(p.kind, slots).ok) continue
      // ground level only: roof pickups cost long exposed climbs
      if (PP.groundOnly ? p.pos[2] - this.h.m.groundAt(p.pos[0], p.pos[1]) > 6 : Math.abs(p.pos[2] - z) > 25) continue
      const d = Math.hypot(p.pos[0] - x, p.pos[1] - y)
      if (d > maxD || (d > 30 && !safe(p.pos[0], p.pos[1]))) continue
      if (!best || d < best.d) best = { pos: p.pos, d }
    }
    return best
  }

  private nearestCube(x: number, y: number, z: number, safe: (x: number, y: number) => boolean, maxD: number): { pos: V3; d: number } | null {
    let best: { pos: V3; d: number } | null = null
    for (const c of this.h.w.cubes.values()) {
      if (this.h.w.t - c.seenT > PP.cubeMemS) continue
      if (Math.abs(c.pos[2] - z) > 4) continue
      const d = Math.hypot(c.pos[0] - x, c.pos[1] - y)
      if (d > maxD || !safe(c.pos[0], c.pos[1])) continue
      if (!best || d < best.d) best = { pos: c.pos, d }
    }
    return best
  }

  /** A cube or wanted weapon close by during a duel, not closer to the enemy than to us. */
  private duelItem(slots: SelfObs["weapons"], x: number, y: number, z: number, foe: Track, safe: (x: number, y: number) => boolean): V2 | null {
    let best: V2 | null = null
    let bs = Infinity
    const consider = (p: V3, lim: number, credit: number) => {
      if (Math.abs(p[2] - z) > 4 || !safe(p[0], p[1])) return
      const d = Math.hypot(p[0] - x, p[1] - y)
      if (d > lim) return
      const de = Math.hypot(p[0] - foe.pos[0], p[1] - foe.pos[1])
      if (de < Math.min(0.8 * Math.hypot(foe.pos[0] - x, foe.pos[1] - y), d + 14)) return
      if (!this.h.m.walkLine(x, y, p[0], p[1], this.h.nav.rq)) return
      if (d - credit < bs) (bs = d - credit), (best = [p[0], p[1]])
    }
    for (const c of this.h.w.cubes.values()) consider(c.pos, this.h.w.t - this.h.w.lastHurtT < 1 ? 20 : 32, 15)
    const one = slots.filter(Boolean).length <= 1
    for (const p of this.h.w.pickups.values()) if (this.wants(p.kind, slots).ok) consider(p.pos, one ? 48 : 28, one ? 25 : 8)
    return best
  }

  /** Supply drop worth it: gain vs time, not contested, at most one firing lane. */
  private dropGoal(obs: Observation, x: number, y: number, t: number, seen: Seen[], hpFrac: number, walk: number): DropObs | null {
    const cfg = this.h.hello.config
    const dc = cfg.drops
    if (!dc) return null
    const me = obs.self
    const cap = Number(cfg.cubes.stat_cap ?? 10)
    const hpc = Number(cfg.cubes.hp_per_cube ?? 0.04)
    let best: DropObs | null = null
    let bs = -Infinity
    for (const d of obs.drops) {
      if (d.holder !== null && d.holder !== me.id && d.progress > 1.5) continue
      const gain = (1 - hpFrac) * (dc.repair ?? 1) + Math.min(Math.max(0, cap - me.cubes), dc.cubes ?? 3) * hpc * 2
      if (gain < 0.05) continue
      const dist = Math.hypot(d.pos[0] - x, d.pos[1] - y)
      const eta = Math.max(0, dist - 0.5 * d.radius) / walk
      const prog = d.holder === me.id ? d.progress : 0
      const needT = Math.max(eta, d.lands_in) + d.capture_s - prog
      if (needT > 9 + 12 * gain || d.lands_in > eta + 5) continue
      if (this.h.w.zoneMargin(d.pos[0], d.pos[1], t + needT + 1) < 2) continue
      let contested = false
      let lanes = 0
      for (const s of seen) {
        const de = Math.hypot(s.e.pos[0] - d.pos[0], s.e.pos[1] - d.pos[1])
        if (de < 1.25 * d.radius && s.e.hp / Math.max(1, s.e.maxHp) > 0.2) contested = true
        const aggressor = t - s.e.hitUsT < 7.5 || Math.abs(angDiff(s.e.aim[0], Math.atan2(y - s.e.pos[1], x - s.e.pos[0]))) < 0.2
        if (aggressor && de < 0.75 * (cfg.weapons.gun.range ?? 230) && this.h.m.los(s.e.pos[0], s.e.pos[1], s.e.pos[2] + 8, d.pos[0], d.pos[1], d.pos[2] + 4.5)) lanes++
      }
      if (contested || lanes > 1 || (lanes === 1 && needT > 7 + 4 * gain)) continue
      const sc = (gain + prog / d.capture_s) / (1 + needT + 2 * lanes)
      if (sc > bs) (bs = sc), (best = d)
    }
    return best
  }

  /** Idle priorities: cubes, crates and drones to farm, remembered crates, the next centre. */
  private roam(obs: Observation, x: number, y: number, z: number, t: number, hpFrac: number, nThreat: number, safe: (x: number, y: number) => boolean, nc: V2, nr: number): { p: V2; stand?: boolean; farm?: Track } | null {
    const w = this.h.w, m = this.h.m
    const cube = this.nearestCube(x, y, z, safe, nThreat ? 20 : 120)
    if (cube) return { p: [cube.pos[0], cube.pos[1]] }
    if (PP.dropRoam && nThreat === 0 && hpFrac > 0.45) {
      const meId = obs.self.id
      for (const d of obs.drops) {
        const dd = Math.hypot(d.pos[0] - x, d.pos[1] - y)
        if (dd < 170 && d.lands_in < dd / 11.7 + 8 && !(d.holder !== null && d.holder !== meId && d.progress > 1.5) && safe(d.pos[0], d.pos[1])) {
          if (dd < d.radius * 0.6) return { p: [x, y], stand: true }
          return { p: [d.pos[0], d.pos[1]] }
        }
      }
    }
    // farm: crates within 150 m, drones within 140 m when healthy
    const muz: V3 = [x, y, z + 7]
    const cands: { tr: Track; d: number; stand: number }[] = []
    for (const c of w.crates.values()) {
      const d = Math.hypot(c.pos[0] - x, c.pos[1] - y)
      if (d < 150 && (!PP.econ || hpFrac > 0.45) && safe(c.pos[0], c.pos[1]) && Math.abs(c.pos[2] - m.groundAt(c.pos[0], c.pos[1])) < 3)
        cands.push({ tr: { id: c.id, kind: "npc", pos: c.pos, vel: [0, 0, 0], aim: [0, 0], hp: c.hp, maxHp: 300, cubes: 0, weapons: [], charging: false, seenT: t, firstT: 0, hitUsT: -99, hitByUsT: -99, laserT: -99, hist: [], hurtByOtherT: -99 }, d, stand: 22 })
    }
    if (hpFrac > (PP.econ ? 0.5 : 0.55)) for (const n of w.liveNpcs()) {
      const d = Math.hypot(n.pos[0] - x, n.pos[1] - y)
      if (d < (PP.econ ? 170 : 140) && safe(n.pos[0], n.pos[1])) cands.push({ tr: n, d: PP.econ ? d - 20 : d + 30, stand: 50 })
    }
    cands.sort((a, b) => a.d - b.d)
    for (const c of cands.slice(0, 4)) {
      const tp = c.tr.pos
      const d = Math.hypot(tp[0] - x, tp[1] - y)
      const los = m.los(muz[0], muz[1], muz[2], tp[0], tp[1], tp[2] + (c.tr.id >= 1000 ? 1.2 : 1.75))
      if (los && d <= c.stand + 8) {
        const away = d < c.stand - 6 ? -1 : 0
        return { p: [x + ((tp[0] - x) / d) * away * 5, y + ((tp[1] - y) / d) * away * 5], stand: true, farm: c.tr }
      }
      if (hpFrac > 0.6 && nThreat === 0 && d > 20 && d < 260) return { p: [tp[0], tp[1]], farm: los ? c.tr : undefined }
    }
    if (Math.hypot(nc[0] - x, nc[1] - y) > Math.max(0.55 * nr, 15)) return { p: [nc[0], nc[1]] }
    return null
  }

  /** Linear lead: target position + velocity x flight time (2 passes), vertical lead clamped to 6 m. */
  private leadLinear(o: V3, tr: Track, speed: number, delay: number, zOff: number): Aim {
    const c: V3 = [tr.pos[0], tr.pos[1], tr.pos[2] + zOff]
    let tt = Math.hypot(c[0] - o[0], c[1] - o[1], c[2] - o[2]) / speed + delay
    let p: V3 = c
    for (let k = 0; k < 2; k++) {
      p = [c[0] + tr.vel[0] * tt, c[1] + tr.vel[1] * tt, c[2] + clamp(tr.vel[2] * tt, -6, 6)]
      tt = Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]) / speed + delay
    }
    return aimAt(o, p)
  }

  /** Farm target when no mech can be shot (any mode): crates within 150 m, drones within 140 m when healthy. */
  private farmTarget(x: number, y: number, z: number, t: number, hpFrac: number, safe: (x: number, y: number) => boolean): Track | null {
    const w = this.h.w, m = this.h.m
    const c4: { tr: Track; sc: number }[] = []
    for (const c of w.crates.values()) {
      const d = Math.hypot(c.pos[0] - x, c.pos[1] - y)
      if (d < 150 && c.pos[2] < z + 6)
        c4.push({ tr: { id: c.id, kind: "npc", pos: c.pos, vel: [0, 0, 0], aim: [0, 0], hp: c.hp, maxHp: 300, cubes: 0, weapons: [], charging: false, seenT: t, firstT: 0, hitUsT: -99, hitByUsT: -99, laserT: -99, hist: [], hurtByOtherT: -99 }, sc: d })
    }
    if (hpFrac > 0.55)
      for (const n of w.liveNpcs()) {
        const d = Math.hypot(n.pos[0] - x, n.pos[1] - y)
        if (d < 140) c4.push({ tr: n, sc: d + 30 })
      }
    c4.sort((a, b) => a.sc - b.sc)
    for (const c of c4.slice(0, 4)) {
      const p = c.tr.pos
      if (!safe(p[0], p[1])) continue
      if (m.los(x, y, z + 7, p[0], p[1], p[2] + (c.tr.id >= 1000 ? 1.2 : 1.75))) return c.tr
    }
    return null
  }

  /** Reference dodge rules: charged lasers aimed at us (fixed side, wall check), bullets, mortar landings. */
  private dodge2(obs: Observation, x: number, y: number, seen: Seen[], zapper: boolean, urgent: boolean): { v: V2; laser: boolean; mortarBoost: boolean } {
    const m = this.h.m, rq = this.h.nav.rq
    let vx = 0, vy = 0, laser = false, mortarBoost = false
    for (const s of seen) {
      const e = s.e
      if (!s.vis || !e.charging || s.d < 5 || s.d > 290) continue
      if (zapper && s.d < 40) continue
      const ax = Math.cos(e.aim[0]), ay = Math.sin(e.aim[0])
      const rx = x - e.pos[0], ry = y - e.pos[1]
      const along = rx * ax + ry * ay
      const cross = rx * ay - ry * ax
      if (along <= 0 || Math.abs(cross) > 7 + 0.03 * along) continue
      let side = this.dodgeSide.get(e.id) ?? 0
      if (!side) side = cross >= 0 ? 1 : -1
      // perpendicular to its aim, away from the beam line
      let dx = ay * side, dy = -ax * side
      if (!m.walkLine(x, y, x + dx * 4, y + dy * 4, rq)) {
        side = -side
        dx = -dx
        dy = -dy
        if (!m.walkLine(x, y, x + dx * 4, y + dy * 4, rq)) continue
      }
      this.dodgeSide.set(e.id, side)
      vx += dx
      vy += dy
      laser = true
    }
    const g = this.h.hello.config.weapons.mortar.gravity ?? 22
    for (const p of obs.projectiles) {
      if (p.kind === "mortar") {
        const L = shellLanding(m, p.pos, p.vel, g)
        if (L && L.t < 3.5) {
          const d = Math.hypot(L.x - x, L.y - y)
          if (d < 13) {
            vx += ((x - L.x) / Math.max(1, d)) * 2
            vy += ((y - L.y) / Math.max(1, d)) * 2
            if (L.t < 1.2 && d < 9) mortarBoost = true
          }
        }
        continue
      }
      const rx = x - p.pos[0], ry = y - p.pos[1]
      const vv = p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1]
      if (vv < 1) continue
      const tc = (rx * p.vel[0] + ry * p.vel[1]) / vv
      if (tc < 0.02 || tc > 0.45) continue
      const cx = p.pos[0] + p.vel[0] * tc - x, cy = p.pos[1] + p.vel[1] * tc - y
      const cd = Math.hypot(cx, cy)
      if (cd < 3.8) {
        const l = Math.max(0.3, cd)
        vx += (-cx / l) * 0.5
        vy += (-cy / l) * 0.5
      }
    }
    if (laser) {
      const l = Math.hypot(vx, vy) || 1
      vx /= l
      vy /= l
    }
    if (urgent) (vx *= 0.5), (vy *= 0.5)
    return { v: [vx, vy], laser, mortarBoost }
  }

  /** Nearest crate (120 m) or drone (110 m) in line of fire, to shoot while doing something else. */
  private farmInSight(x: number, y: number, z: number, t: number): Track | null {
    const w = this.h.w, m = this.h.m
    const mz = z + 7
    let best: Track | null = null
    let bd = Infinity
    for (const c of w.crates.values()) {
      const d = Math.hypot(c.pos[0] - x, c.pos[1] - y)
      if (d < 120 && d < bd && m.los(x, y, mz, c.pos[0], c.pos[1], c.pos[2] + 1.2))
        (bd = d), (best = { id: c.id, kind: "npc", pos: c.pos, vel: [0, 0, 0], aim: [0, 0], hp: c.hp, maxHp: 300, cubes: 0, weapons: [], charging: false, seenT: t, firstT: 0, hitUsT: -99, hitByUsT: -99, laserT: -99, hist: [], hurtByOtherT: -99 })
    }
    for (const n of w.liveNpcs()) {
      const d = Math.hypot(n.pos[0] - x, n.pos[1] - y)
      if (d < 110 && d < bd && m.los(x, y, mz, n.pos[0], n.pos[1], n.pos[2] + 1.75)) (bd = d), (best = n)
    }
    return best
  }

  /** Fixed range per weapon, radial correction plus a lateral strafe that flips at random. */
  private fightMove(x: number, y: number, T: Seen, hasLaser: boolean, hasLight: boolean, finishing: boolean, charge: boolean, mustGo: boolean, nc: V2, nr: number, t: number, finishR = 0): V2 {
    const d = T.d
    let pref = hasLaser ? PP.laserRange : hasLight ? PP.lightRange : PP.gunRange
    if (hasLaser && hasLight && d < 60) pref = PP.lightRange
    if (finishing) pref = hasLight ? PP.lightRange : 55
    if (charge) pref = 22
    if (finishR > 0) pref = finishR
    const ux = (T.e.pos[0] - x) / Math.max(1, d), uy = (T.e.pos[1] - y) / Math.max(1, d)
    const radial = clamp((d - pref) / 30, -1, 1)
    if (t > this.strafeT) {
      if (this.h.rnd() < PP.strafeP) this.strafeSign = -this.strafeSign
      this.strafeT = t + PP.strafeMin + this.h.rnd() * PP.strafeSpan
    }
    const s = this.strafeSign * PP.strafe
    let gx = x + (ux * radial - uy * s) * 20, gy = y + (uy * radial + ux * s) * 20
    if (mustGo && Math.hypot(gx - nc[0], gy - nc[1]) > nr) (gx = nc[0]), (gy = nc[1])
    return this.steerLocal(x, y, [gx - x, gy - y])
  }

  /** Pick the best of 16 headings: toward the wish, a bit of inertia, away from walls. */
  steerLocal(x: number, y: number, wish: V2, speed = 1): V2 {
    const m = this.h.m, rq = this.h.nav.rq
    const wl = Math.hypot(wish[0], wish[1])
    if (wl < 0.01) return [0, 0]
    const wx = wish[0] / wl, wy = wish[1] / wl
    let best: V2 = [0, 0]
    let bs = -Infinity
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      const dx = Math.cos(a), dy = Math.sin(a)
      let sc = dx * wx + dy * wy + 0.15 * (dx * this.prevDir[0] + dy * this.prevDir[1])
      if (!m.walkLine(x, y, x + dx * 3, y + dy * 3, rq)) sc -= 2.5
      else if (!m.walkLine(x, y, x + dx * 6, y + dy * 6, rq)) sc -= 1.2
      else if (!m.walkLine(x, y, x + dx * 10, y + dy * 10, rq)) sc -= 0.5
      if (sc > bs) (bs = sc), (best = [dx, dy])
    }
    const sp = Math.min(speed, wl > 3 ? 1 : wl / 3)
    return [best[0] * sp, best[1] * sp]
  }

  /** Cover: fewest of the 3 nearest threats see it, close, away from them, inside the zone. */
  private coverPoint(x: number, y: number, z: number, t: number, threats: Seen[], mustGo: boolean, nc: V2, nr: number, cur: { c: V2; r: number }): { p: V2; vis: number } | null {
    const m = this.h.m, rq = this.h.nav.rq
    const three = threats.slice().sort((a, b) => a.d - b.d).slice(0, 3)
    const visAt = (px: number, py: number) => {
      const pz = m.surfAt(px, py) + 7.2
      let v = 0
      for (const s of three) if (m.los(s.e.pos[0], s.e.pos[1], s.e.pos[2] + 8, px, py, pz)) v++
      return v
    }
    const c = this.cover
    if (c && c.vis === 0 && this.tick - c.tick < 40) {
      if ((this.tick - c.tick) % 3 !== 0 || visAt(c.p[0], c.p[1]) === 0) return c
    } else if (c && this.tick - c.tick < 4) return c
    let ax = 0, ay = 0
    for (const s of three) (ax += x - s.e.pos[0]), (ay += y - s.e.pos[1])
    const al = Math.hypot(ax, ay) || 1
    ax /= al
    ay /= al
    let best: { p: V2; vis: number } | null = null
    let bs = Infinity
    const radii = [7, 14, 22, 32, 44, 58, 75]
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2
      const dx = Math.cos(a), dy = Math.sin(a)
      let px = x, py = y, prev = 0
      for (const r of radii) {
        const nx2 = x + dx * r, ny2 = y + dy * r
        if (!m.walkLine(px, py, nx2, ny2, rq)) break
        px = nx2
        py = ny2
        prev = r
        const vis = visAt(px, py)
        let sc = 100 * vis + 0.8 * r - 12 * (dx * ax + dy * ay)
        if (mustGo && Math.hypot(px - nc[0], py - nc[1]) > nr) sc += 150
        else if (Math.hypot(px - cur.c[0], py - cur.c[1]) > cur.r - 5) sc += 300
        if (sc < bs) (bs = sc), (best = { p: [px, py], vis })
      }
      if (prev === 0) continue
    }
    this.cover = best ? { ...best, tick: this.tick } : null
    return best
  }

  /** Sidesteps: charged laser lines, incoming bullets, mortar landings. */
  private dodge(obs: Observation, x: number, y: number, seen: Seen[]): V2 {
    let dx = 0, dy = 0
    for (const s of seen) {
      const e = s.e
      if (!e.charging) continue
      const ax = Math.cos(e.aim[0]), ay = Math.sin(e.aim[0])
      const rx = x - e.pos[0], ry = y - e.pos[1]
      const along = rx * ax + ry * ay
      const cross = rx * ay - ry * ax
      if (along > 0 && Math.abs(cross) <= 7 + 0.03 * along) {
        const sgn = cross >= 0 ? 1 : -1
        dx += -ay * -sgn * 0.9
        dy += ax * -sgn * 0.9
      }
    }
    const g = this.h.hello.config.weapons.mortar.gravity ?? 22
    for (const p of obs.projectiles) {
      if (p.kind === "mortar") {
        const L = shellLanding(this.h.m, p.pos, p.vel, g)
        if (L && L.t < 3.5) {
          const d = Math.hypot(L.x - x, L.y - y)
          if (d < 13) (dx += ((x - L.x) / Math.max(1, d)) * 2), (dy += ((y - L.y) / Math.max(1, d)) * 2)
        }
        continue
      }
      // bullet: closest approach in the next 0.45 s
      const rx = x - p.pos[0], ry = y - p.pos[1]
      const vv = p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1]
      if (vv < 1) continue
      const tc = (rx * p.vel[0] + ry * p.vel[1]) / vv
      if (tc < 0.02 || tc > 0.45) continue
      const cx = p.pos[0] + p.vel[0] * tc - x, cy = p.pos[1] + p.vel[1] * tc - y
      const cd = Math.hypot(cx, cy)
      if (cd < 3.8) {
        const l = Math.max(0.3, cd)
        dx += (-cx / l) * 0.5
        dy += (-cy / l) * 0.5
      }
    }
    return [dx, dy]
  }

  /** Where to look with nothing to shoot. */
  private look(x: number, y: number, eye: V3, t: number, hiddenBearing: number | null, seen: Seen[], mv: V2): [number, number] {
    const w = this.h.w
    if (hiddenBearing !== null) return [hiddenBearing, 0]
    const h = w.hurt.length ? w.hurt[w.hurt.length - 1] : null
    if (h && t - h.t < 3 && h.bearing !== null) return [h.bearing, 0]
    let near: Seen | null = null
    for (const s of seen) if (!near || s.d < near.d) near = s
    if (near) {
      const a = aimAt(eye, [near.e.pos[0], near.e.pos[1], near.e.pos[2] + 4.5])
      return [a.yaw, a.pitch]
    }
    const loud = w.heard.filter((s) => t - s.t < 2 && s.dist !== "far")
    if (loud.length) return [loud[loud.length - 1].bearing, 0]
    this.scanYaw += 0.35
    return [this.scanYaw, 0]
  }

  /**
   * Aim and triggers. Shots are timed for the tick they will actually leave: hold a trigger when
   * the weapon becomes ready within this decision, lead from that moment and from where our
   * muzzle will be then.
   */
  private fireControl(me: SelfObs, muz0: V3, tr: Track, iGun: number, iLaser: number, iLight: number, seen: Seen[]): { aim: [number, number]; fire: [boolean, boolean]; reload: boolean } {
    const { m, g, perCube } = this.h
    const slots = me.weapons
    const turn = me.stats.turn_rate ?? 4, ptch = me.stats.pitch_rate ?? 3
    const off = centerOffset(tr, perCube)
    const rad = tr.kind === "npc" ? (tr.id >= 1000 ? 1.4 : 1.8) : hitRadius(tr, perCube)
    const fire: [boolean, boolean] = [false, false]
    let reload = false
    const at = (delay: number): V3 => [muz0[0] + me.vel[0] * delay, muz0[1] + me.vel[1] * delay, muz0[2] + me.vel[2] * delay]
    const errAfter = (a: Aim, delay0: number): [number, number] => {
      const delay = PP.aimComp ? delay0 : 0
      const ey = Math.max(0, Math.abs(angDiff(a.yaw, me.aim[0])) - turn * delay)
      const ep = Math.max(0, Math.abs(a.pitch - me.aim[1]) - ptch * delay)
      return [ey, ep]
    }
    // laser
    let laserAim: Aim | null = null
    let laserReady = false
    if (iLaser >= 0) {
      const L = slots[iLaser]!
      const charge = L.charge ?? 0
      const full = L.stats.charge ?? 0.75
      const range = L.stats.range ?? 280
      const o = at(TICK)
      const p = predict2(m, tr, 0.1, g).p
      laserAim = aimAt(o, [p[0], p[1], p[2] + off])
      const d = laserAim.dist
      const lightNear = PP.laserLightBlock && seen.some((s) => s.e.weapons.includes("lightning") && s.d < 1.1 * (this.h.hello.config.weapons.lightning.range ?? 45))
      if (charge > 0) {
        const [ey, ep] = errAfter(laserAim, TICK)
        const ok = ey <= Math.atan2(1.6 * rad, d) + 0.012 && ep <= 1.5 * (Math.atan2(3, d) + 0.004)
        const left = full + (L.stats.hold_s ?? 2) - charge
        fire[iLaser] = !((charge >= full - 0.02 && ok) || (left < 0.25 && !ok) || left < 0.12)
        if (PP.sqLethal && ok && tr.kind === "mech" && charge >= (L.stats.min_charge ?? 0.15) && charge < full - 0.05) {
          const cc = this.h.hello.config.cubes
          const frac = (L.stats.min_frac ?? 0.35) + (1 - (L.stats.min_frac ?? 0.35)) * (charge / full)
          let dmg = (L.stats.damage ?? 315) * frac * (1 + (cc.damage_per_cube ?? 0.04) * Math.min(me.cubes, cc.stat_cap ?? 10))
          if (tr.weapons.includes("mortar")) dmg *= 1 + (L.stats.cookoff ?? 0.6)
          if (dmg * 0.8 >= tr.hp) fire[iLaser] = false
        }
        laserReady = charge >= full - 0.1
      } else if (L.cooldown <= 0.05 && d < range - 5 && !lightNear && (tr.kind === "mech" || tr.id < 1000 || iGun < 0)) {
        fire[iLaser] = true
      }
    }
    // gun
    let gunAim: Aim | null = null
    if (iGun >= 0) {
      const G = slots[iGun]!
      const delay = Math.max(1, Math.ceil(Math.max(0, G.cooldown) / TICK - 1e-6)) * TICK
      const o = at(delay)
      gunAim = PP.linearLead ? this.leadLinear(o, tr, G.stats.speed ?? 252, delay, off) : leadAim(m, o, tr, G.stats.speed ?? 252, delay, off, g)
      const d = gunAim.dist
      const [ey, ep] = errAfter(gunAim, delay)
      const ammo = G.ammo ?? 1
      const ok = ey <= Math.atan2(1.6 * rad, d) + 0.012 && ep <= Math.atan2(3, d) + 0.004
      const clear = !PP.gunLos || m.los(o[0], o[1], o[2], gunAim.pt[0], gunAim.pt[1], gunAim.pt[2])
      if (delay <= SPAN + 1e-6 && !(G.reload ?? 0) && ammo > 0 && d < (G.stats.range ?? 230) - 3 && ok && clear) fire[iGun] = true
      if (ammo === 0 && !(G.reload ?? 0)) reload = true
    }
    // lightning
    if (iLight >= 0) {
      const L = slots[iLight]!
      const delay = Math.max(1, Math.ceil(Math.max(0, L.cooldown) / TICK - 1e-6)) * TICK
      const d = Math.hypot(tr.pos[0] - muz0[0], tr.pos[1] - muz0[1])
      const b = Math.atan2(tr.pos[1] - muz0[1], tr.pos[0] - muz0[0])
      const cone = ((L.stats.cone_deg ?? 30) * Math.PI) / 180
      if (delay <= SPAN + 1e-6 && d < (L.stats.range ?? 45) - 1 && me.energy >= (L.stats.energy ?? 3) + 1 && Math.abs(angDiff(b, me.aim[0])) <= 0.4 * cone) fire[iLight] = true
    }
    const a = laserReady && laserAim ? laserAim : gunAim ?? laserAim ?? aimAt(muz0, [tr.pos[0], tr.pos[1], tr.pos[2] + off])
    return { aim: [a.yaw, a.pitch], fire, reload }
  }
}
