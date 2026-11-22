import type { GameMap } from "./map.ts"

const SQ2 = Math.SQRT2

/**
 * Resumable A* on the map's 2 m nav grid. `begin()` sets a search up, `run(budget)` expands at most
 * `budget` nodes so a long search can spread over several decisions. Extra per-node costs come from
 * `costFn` (zone, exposure...).
 */
export class Pathfinder {
  m: GameMap
  N: number
  g: Float32Array
  parent: Int32Array
  seen: Uint32Array
  closed: Uint32Array
  gen = 1
  heapN: Int32Array
  heapF: Float32Array
  hs = 0
  start = -1
  goal = -1
  rq = 3.4
  gx = 0
  gy = 0
  state: "idle" | "running" | "done" | "fail" = "idle"
  result: number[] = []
  bestNode = -1
  bestH = Infinity
  costFn: ((n: number) => number) | null = null
  hw = 1

  constructor(m: GameMap) {
    this.m = m
    this.N = m.NW * m.NH
    this.g = new Float32Array(this.N)
    this.parent = new Int32Array(this.N)
    this.seen = new Uint32Array(this.N)
    this.closed = new Uint32Array(this.N)
    this.heapN = new Int32Array(this.N * 4)
    this.heapF = new Float32Array(this.N * 4)
  }

  private h(n: number) {
    const NW = this.m.NW
    const dx = Math.abs((n % NW) - (this.goal % NW))
    const dy = Math.abs(Math.floor(n / NW) - Math.floor(this.goal / NW))
    return (dx > dy ? dx + (SQ2 - 1) * dy : dy + (SQ2 - 1) * dx) * this.hw
  }

  private push(n: number, f: number) {
    if (this.hs >= this.heapN.length) return
    let i = this.hs++
    const H = this.heapN, F = this.heapF
    while (i > 0) {
      const p = (i - 1) >> 1
      if (F[p] <= f) break
      H[i] = H[p]
      F[i] = F[p]
      i = p
    }
    H[i] = n
    F[i] = f
  }

  private pop(): number {
    const H = this.heapN, F = this.heapF
    const top = H[0]
    const n = H[--this.hs], f = F[this.hs]
    let i = 0
    const size = this.hs
    for (;;) {
      let c = 2 * i + 1
      if (c >= size) break
      if (c + 1 < size && F[c + 1] < F[c]) c++
      if (F[c] >= f) break
      H[i] = H[c]
      F[i] = F[c]
      i = c
    }
    H[i] = n
    F[i] = f
    return top
  }

  /** Start a search from node `s` to node `t`. Both must be passable and in the same component. */
  begin(s: number, t: number, rq: number) {
    this.gen++
    this.hs = 0
    this.start = s
    this.goal = t
    this.rq = rq
    this.state = "running"
    this.result = []
    this.g[s] = 0
    this.parent[s] = -1
    this.seen[s] = this.gen
    this.bestNode = s
    this.bestH = Infinity
    this.push(s, this.h(s))
  }

  /** Expand up to `budget` nodes. Returns the state. */
  run(budget: number): "running" | "done" | "fail" | "idle" {
    if (this.state !== "running") return this.state
    const m = this.m, NW = m.NW, NH = m.NH, rq = this.rq
    const g = this.g, parent = this.parent, seen = this.seen, closed = this.closed, gen = this.gen
    const nClear = m.nClear
    while (budget-- > 0) {
      if (this.hs === 0) {
        this.state = "fail"
        return this.state
      }
      const n = this.pop()
      if (closed[n] === gen) continue
      closed[n] = gen
      if (n === this.goal) {
        this.finish(n)
        return this.state
      }
      const hn = this.h(n)
      if (hn < this.bestH) (this.bestH = hn), (this.bestNode = n)
      const I = n % NW, J = (n - I) / NW
      for (let dj = -1; dj <= 1; dj++) {
        const J2 = J + dj
        if (J2 < 0 || J2 >= NH) continue
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue
          const I2 = I + di
          if (I2 < 0 || I2 >= NW) continue
          const v = J2 * NW + I2
          if (closed[v] === gen || nClear[v] < rq) continue
          const diag = di !== 0 && dj !== 0
          if (diag && (nClear[J * NW + I2] < rq || nClear[J2 * NW + I] < rq)) continue
          if (!m.stepOk(n, v, diag)) continue
          let w = diag ? SQ2 : 1
          // prefer some room from walls
          const cl = nClear[v]
          if (cl < rq + 1.5) w *= 1.25
          if (this.costFn) w *= 1 + this.costFn(v)
          const ng = g[n] + w
          if (seen[v] === gen && ng >= g[v]) continue
          seen[v] = gen
          g[v] = ng
          parent[v] = n
          this.push(v, ng + this.h(v))
        }
      }
    }
    return this.state
  }

  private finish(n: number) {
    const out: number[] = []
    for (let k = n; k >= 0; k = this.parent[k]) {
      out.push(k)
      if (k === this.start) break
    }
    out.reverse()
    this.result = out
    this.state = "done"
  }
}

/**
 * Path follower: asks the pathfinder for a route to a goal, replans when the goal moves or we
 * drift, and returns a unit move direction toward the farthest directly walkable path node.
 */
export class Navigator {
  m: GameMap
  pf: Pathfinder
  path: number[] = []
  pathGoal: [number, number] | null = null
  idx = 0
  pending: [number, number] | null = null
  lastPlanT = -99
  lastProgT = 0
  lastProgPos: [number, number] = [0, 0]
  stuckUntil = 0
  stuckSide = 1
  rq = 3.4
  costFn: ((n: number) => number) | null = null
  /** opening move until this time: "hop" turns 60 deg left + jump + boost, "side" turns + boosts on the ground, "jet" jumps + boosts, "boost" boosts */
  openUntil = 0
  openMode: "hop" | "side" | "jet" | "boost" = "hop"

  constructor(m: GameMap) {
    this.m = m
    this.pf = new Pathfinder(m)
  }

  /** Clear the route (e.g. when we stop navigating). */
  reset() {
    this.path = []
    this.pathGoal = null
    this.pending = null
    this.pf.state = "idle"
  }

  /** Forget everything, including progress and stuck timers (after a warmup on a fake match). */
  resetAll() {
    this.reset()
    this.idx = 0
    this.lastPlanT = -99
    this.lastProgT = 0
    this.lastProgPos = [0, 0]
    this.stuckUntil = 0
    this.stuckSide = 1
    this.costFn = null
  }

  /**
   * Move direction toward (gx, gy) from (x, y) at time t. Returns null when arrived.
   * `budget` limits A* expansions this decision.
   */
  steer(x: number, y: number, gx: number, gy: number, t: number, budget = 5000): { dir: [number, number]; jump: boolean; boost: boolean; arrived: boolean } {
    const m = this.m, rq = this.rq
    const dGoal = Math.hypot(gx - x, gy - y)
    // stuck detection
    if (Math.hypot(x - this.lastProgPos[0], y - this.lastProgPos[1]) > 1.5) {
      this.lastProgPos = [x, y]
      this.lastProgT = t
    }
    let jump = false, boost = false
    if (dGoal > 3 && t - this.lastProgT > 1.5) {
      this.stuckUntil = t + 0.8
      this.stuckSide = -this.stuckSide
      this.lastProgT = t
      this.lastPlanT = -99 // replan
      this.path = []
    }
    if (dGoal < 2.5) return { dir: [0, 0], jump, boost, arrived: true }
    // direct line?
    if (dGoal < (this.costFn ? 15 : 60) && m.walkLine(x, y, gx, gy, rq)) {
      this.path = []
      const d = [(gx - x) / dGoal, (gy - y) / dGoal] as [number, number]
      return this.applyStuck(d, t, jump, boost)
    }
    // (re)plan
    const goalMoved = !this.pathGoal || Math.hypot(this.pathGoal[0] - gx, this.pathGoal[1] - gy) > 6
    if (this.pf.state === "running" && this.pending && Math.hypot(this.pending[0] - gx, this.pending[1] - gy) <= 6) {
      this.pf.run(budget)
      if (this.pf.state === "done") this.adopt()
      else if (this.pf.state === "fail") this.pf.state = "idle"
    } else if (goalMoved || this.path.length === 0 || t - this.lastPlanT > 4 || this.offPath(x, y)) {
      this.plan(x, y, gx, gy, t, budget)
    }
    // follow
    let tx = gx, ty = gy
    if (this.path.length) {
      // advance index to closest node ahead
      let best = this.idx, bd = Infinity
      for (let k = this.idx; k < Math.min(this.path.length, this.idx + 12); k++) {
        const n = this.path[k]
        const d = Math.hypot(m.nodeX(n) - x, m.nodeY(n) - y)
        if (d < bd) (bd = d), (best = k)
      }
      this.idx = best
      // farthest directly walkable node within a window
      let pick = Math.min(this.idx + 1, this.path.length - 1)
      for (let k = Math.min(this.path.length - 1, this.idx + 25); k > this.idx; k--) {
        const n = this.path[k]
        if (m.walkLine(x, y, m.nodeX(n), m.nodeY(n), rq)) {
          pick = k
          break
        }
      }
      const n = this.path[pick]
      tx = m.nodeX(n)
      ty = m.nodeY(n)
      if (pick === this.path.length - 1 && Math.hypot(tx - x, ty - y) < 3) {
        tx = gx
        ty = gy
      }
    }
    const dd = Math.hypot(tx - x, ty - y) || 1
    return this.applyStuck([(tx - x) / dd, (ty - y) / dd], t, jump, boost)
  }

  private applyStuck(d: [number, number], t: number, jump: boolean, boost: boolean) {
    if (t < this.openUntil) {
      const md = this.openMode
      if (md === "hop" || md === "side") d = [d[0] * 0.5 - d[1] * 0.85, d[1] * 0.5 + d[0] * 0.85]
      return { dir: d, jump: md === "hop" || md === "jet", boost: true, arrived: false }
    }
    if (t < this.stuckUntil) {
      // side-step and hop
      const s = this.stuckSide
      d = [d[0] * 0.5 - d[1] * s * 0.85, d[1] * 0.5 + d[0] * s * 0.85]
      jump = true
      boost = true
    }
    return { dir: d, jump, boost, arrived: false }
  }

  private offPath(x: number, y: number) {
    if (!this.path.length) return true
    const n = this.path[Math.min(this.idx, this.path.length - 1)]
    return Math.hypot(this.m.nodeX(n) - x, this.m.nodeY(n) - y) > 8
  }

  private plan(x: number, y: number, gx: number, gy: number, t: number, budget: number) {
    const m = this.m, rq = this.rq
    this.lastPlanT = t
    const comp = m.comp(rq)
    const s = m.snap(x, y, rq, -1, 6)
    if (s < 0) return
    const g = m.snap(gx, gy, rq, comp[s], 40)
    if (g < 0) return
    this.pending = [gx, gy]
    this.pf.costFn = this.costFn
    this.pf.hw = this.costFn ? 1.5 : 1
    this.pf.begin(s, g, rq)
    this.pf.run(budget)
    if (this.pf.state === "done") this.adopt()
    else if (this.pf.state === "fail") this.pf.state = "idle"
  }

  private adopt() {
    this.path = this.pf.result
    this.pathGoal = this.pending
    this.idx = 0
    this.pf.state = "idle"
  }
}
