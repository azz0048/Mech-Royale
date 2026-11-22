import { readFileSync } from "node:fs"

/** Bridge or overhang whose underside is at least this far above the ground: walk under it. */
export const HEAD_CLEAR = 10.5
/** Bridge deck whose underside is less than this above the ground: walk on top of it. */
export const LOW_DECK = 4
/** Max rise between two adjacent 2 m nav nodes (orthogonal / diagonal). */
const RISE_ORTHO = 2.0
const RISE_DIAG = 2.8

type Prism = { kind: string; base: number; top: number; ring: number[]; holes?: number[][] }

/**
 * Static map model: terrain heights, a 1 m solid raster for line of sight, and a 2 m nav grid
 * with wall clearance. Built once at hello from /arena.
 */
export class GameMap {
  minX: number
  minY: number
  step: number
  vnx: number
  vny: number
  hscale: number
  hts: Int16Array
  /** cells (1 m) */
  nx: number
  ny: number
  gnd: Float32Array
  solLo: Float32Array
  solHi: Float32Array
  surf: Float32Array
  wall: Uint8Array
  clear: Float32Array
  /** nav nodes (2 cells) */
  NW: number
  NH: number
  nClear: Float32Array
  nSurf: Float32Array
  /** per nav node, how exposed a standing mech is (0..255): to ground observers >= 45 m / < 45 m */
  openFar: Uint8Array
  openNear: Uint8Array
  /** per nav node: bit k set when sector k (of 16) has long open sightlines */
  openMask: Uint16Array
  private comps = new Map<number, Int32Array>()

  constructor(dir: string, stepUp = 1.2) {
    const w = JSON.parse(readFileSync(dir + "/v2/world.json", "utf8"))
    const t = w.terrain
    this.minX = t.minX
    this.minY = t.minY
    this.step = t.step
    this.vnx = t.nx
    this.vny = t.ny
    this.hscale = t.scale ?? 0.01
    const buf = readFileSync(dir + "/v2/" + (t.file ?? "terrain.i16"))
    this.hts = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    const nx = (this.nx = this.vnx - 1)
    const ny = (this.ny = this.vny - 1)
    const N = nx * ny
    const s = this.step
    this.gnd = new Float32Array(N)
    this.solLo = new Float32Array(N).fill(Infinity)
    this.solHi = new Float32Array(N).fill(-Infinity)
    this.surf = new Float32Array(N)
    this.wall = new Uint8Array(N)
    const hs = this.hscale
    const H = this.hts
    const vnx = this.vnx
    const steep = 1.19 * s
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * vnx + i
        const a = H[k] * hs, b = H[k + 1] * hs, c = H[k + vnx] * hs, d = H[k + vnx + 1] * hs
        const ci = j * nx + i
        const g = (a + b + c + d) * 0.25
        this.gnd[ci] = g
        this.surf[ci] = g
        if (Math.abs(a - b) > steep || Math.abs(c - d) > steep || Math.abs(a - c) > steep || Math.abs(b - d) > steep) this.wall[ci] = 1
      }
    // map edge
    const b = w.bounds
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const x = this.minX + (i + 0.5) * s, y = this.minY + (j + 0.5) * s
        if (x < b.minX + 1 || x > b.maxX - 1 || y < b.minY + 1 || y > b.maxY - 1) this.wall[j * nx + i] = 1
      }
    for (const p of w.prisms as Prism[]) this.raster(p, stepUp)
    this.loadTrees(w)
    this.clear = this.distanceTransform()
    // nav nodes
    const NW = (this.NW = Math.floor(nx / 2))
    const NH = (this.NH = Math.floor(ny / 2))
    this.nClear = new Float32Array(NW * NH)
    this.nSurf = new Float32Array(NW * NH)
    for (let J = 0; J < NH; J++)
      for (let I = 0; I < NW; I++) {
        const c0 = 2 * J * nx + 2 * I
        const cs = [c0, c0 + 1, c0 + nx, c0 + nx + 1]
        let cl = Infinity, sf = -Infinity
        for (const c of cs) {
          if (this.clear[c] < cl) cl = this.clear[c]
          if (this.surf[c] > sf) sf = this.surf[c]
        }
        this.nClear[J * NW + I] = cl
        this.nSurf[J * NW + I] = sf
      }
    this.openFar = new Uint8Array(NW * NH)
    this.openNear = new Uint8Array(NW * NH)
    this.openMask = new Uint16Array(NW * NH)
    this.computeOpenness()
  }

  /** Height of the tallest thing in a cell (terrain or solid). */
  topAt(c: number): number {
    const g = this.gnd[c], h = this.solHi[c]
    return h > g ? h : g
  }

  /**
   * Openness on a 4 m lattice: from the top of a mech standing on the node, cast 16 horizon rays
   * and count the ground observers (eye 8 m) that would see it, near (< 45 m) and far (45-160 m).
   */
  private computeOpenness() {
    const NW = this.NW, NH = this.NH, s = this.step
    const RAYS = 16, MAXR = 160
    const cs: number[] = [], sn: number[] = []
    for (let k = 0; k < RAYS; k++) (cs[k] = Math.cos((k / RAYS) * Math.PI * 2)), (sn[k] = Math.sin((k / RAYS) * Math.PI * 2))
    const nx = this.nx, ny = this.ny, gnd = this.gnd, wall = this.wall
    for (let J = 0; J < NH; J += 2)
      for (let I = 0; I < NW; I += 2) {
        const n = J * NW + I
        if (this.nClear[n] < 2.9) continue
        const x = this.nodeX(n), y = this.nodeY(n), zt = this.nSurf[n] + 9
        let fv = 0, ft = 0, nv = 0, nt = 0, mask = 0
        for (let k = 0; k < RAYS; k++) {
          let smax = -Infinity, rv = 0, rt = 0
          for (let r = 2; r <= MAXR; r += 2) {
            const i = Math.floor((x + cs[k] * r - this.minX) / s), j = Math.floor((y + sn[k] * r - this.minY) / s)
            if (i < 0 || j < 0 || i >= nx || j >= ny) break
            const c = j * nx + i
            if (!wall[c]) {
              const vis = (gnd[c] + 8 - zt) / r > smax
              if (r < 45) (nt++, vis && nv++)
              else (rt++, vis && rv++)
            }
            const o = (this.topAt(c) - zt) / r
            if (o > smax) smax = o
          }
          ft += rt
          fv += rv
          if (rt > 0 && rv / rt > 0.3) mask |= 1 << k
        }
        const of = ft ? Math.round((255 * fv) / ft) : 0, on = nt ? Math.round((255 * nv) / nt) : 0
        // fill the 2x2 block of nav nodes this lattice point stands for
        for (let dj = 0; dj < 2; dj++)
          for (let di = 0; di < 2; di++) {
            const I2 = I + di, J2 = J + dj
            if (I2 >= NW || J2 >= NH) continue
            const q = J2 * NW + I2
            this.openFar[q] = of
            this.openNear[q] = on
            this.openMask[q] = mask
          }
      }
  }

  private raster(p: Prism, stepUp: number) {
    const rings = [p.ring, ...(p.holes ?? [])]
    let ymin = Infinity, ymax = -Infinity
    for (let k = 1; k < p.ring.length; k += 2) {
      if (p.ring[k] < ymin) ymin = p.ring[k]
      if (p.ring[k] > ymax) ymax = p.ring[k]
    }
    const s = this.step, nx = this.nx, ny = this.ny
    const j0 = Math.max(0, Math.ceil((ymin - this.minY) / s - 0.5))
    const j1 = Math.min(ny - 1, Math.floor((ymax - this.minY) / s - 0.5))
    const xs: number[] = []
    for (let j = j0; j <= j1; j++) {
      const yc = this.minY + (j + 0.5) * s
      xs.length = 0
      for (const r of rings) {
        const n = r.length >> 1
        for (let e = 0; e < n; e++) {
          const x1 = r[2 * e], y1 = r[2 * e + 1]
          const f = (e + 1) % n
          const x2 = r[2 * f], y2 = r[2 * f + 1]
          if (y1 <= yc !== y2 <= yc) xs.push(x1 + ((yc - y1) * (x2 - x1)) / (y2 - y1))
        }
      }
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.minX) / s - 0.5))
        const i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - this.minX) / s - 0.5))
        for (let i = i0; i <= i1; i++) {
          const c = j * nx + i
          if (p.base < this.solLo[c]) this.solLo[c] = p.base
          if (p.top > this.solHi[c]) this.solHi[c] = p.top
          const g = this.gnd[c]
          const clr = p.base - g
          if (clr >= HEAD_CLEAR) continue
          if (p.kind === "bridge" && clr < LOW_DECK) {
            if (p.top > this.surf[c]) this.surf[c] = p.top
          } else if (clr >= LOW_DECK) this.wall[c] = 1
          else {
            if (p.top > this.surf[c]) this.surf[c] = p.top
            if (p.top - g > stepUp) this.wall[c] = 1
          }
        }
      }
    }
  }

  private distanceTransform(): Float32Array {
    const nx = this.nx, ny = this.ny
    const d = new Float32Array(nx * ny)
    const BIG = 1e6
    for (let c = 0; c < d.length; c++) d[c] = this.wall[c] ? 0 : BIG
    const D = Math.SQRT2
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i
        let v = d[c]
        if (v === 0) continue
        if (i > 0 && d[c - 1] + 1 < v) v = d[c - 1] + 1
        if (j > 0) {
          if (d[c - nx] + 1 < v) v = d[c - nx] + 1
          if (i > 0 && d[c - nx - 1] + D < v) v = d[c - nx - 1] + D
          if (i < nx - 1 && d[c - nx + 1] + D < v) v = d[c - nx + 1] + D
        }
        d[c] = v
      }
    for (let j = ny - 1; j >= 0; j--)
      for (let i = nx - 1; i >= 0; i--) {
        const c = j * nx + i
        let v = d[c]
        if (v === 0) continue
        if (i < nx - 1 && d[c + 1] + 1 < v) v = d[c + 1] + 1
        if (j < ny - 1) {
          if (d[c + nx] + 1 < v) v = d[c + nx] + 1
          if (i < nx - 1 && d[c + nx + 1] + D < v) v = d[c + nx + 1] + D
          if (i > 0 && d[c + nx - 1] + D < v) v = d[c + nx - 1] + D
        }
        d[c] = v
      }
    const s = this.step
    for (let c = 0; c < d.length; c++) d[c] *= s
    return d
  }

  /** Terrain height (bilinear), ignoring buildings. */
  groundAt(x: number, y: number): number {
    let fx = (x - this.minX) / this.step
    let fy = (y - this.minY) / this.step
    let i = Math.floor(fx), j = Math.floor(fy)
    if (i < 0) (i = 0), (fx = 0)
    else if (i > this.vnx - 2) (i = this.vnx - 2), (fx = i + 1)
    if (j < 0) (j = 0), (fy = 0)
    else if (j > this.vny - 2) (j = this.vny - 2), (fy = j + 1)
    const tx = fx - i, ty = fy - j
    const k = j * this.vnx + i
    const H = this.hts
    const h0 = H[k] * (1 - tx) + H[k + 1] * tx
    const h1 = H[k + this.vnx] * (1 - tx) + H[k + this.vnx + 1] * tx
    return (h0 * (1 - ty) + h1 * ty) * this.hscale
  }

  cellOf(x: number, y: number): number {
    const i = Math.floor((x - this.minX) / this.step), j = Math.floor((y - this.minY) / this.step)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1
    return j * this.nx + i
  }

  /** Walkable surface height at (x, y): terrain, deck or roof. */
  surfAt(x: number, y: number): number {
    const c = this.cellOf(x, y)
    return c < 0 ? this.groundAt(x, y) : this.surf[c]
  }

  // ---- trees: crowns fade sight (beyond near range), trunks stop it; shots ignore both ----
  treeN = 0
  tcx = new Float32Array(0)
  tcy = new Float32Array(0)
  tcz = new Float32Array(0)
  tcr = new Float32Array(0)
  trz = new Float32Array(0)
  tgrid: Int32Array[] = []
  tgw = 0
  tgh = 0
  readonly TG = 8
  canopyDensity = 0.35
  canopyBlockT = 0.25
  private tstamp = new Uint32Array(0)
  private tgen = 1

  private loadTrees(w: any) {
    const tr = w.trees
    if (!tr || !tr.fields || !tr.data) return
    const F: string[] = tr.fields, D: number[] = tr.data, nf = F.length
    const ix = (k: string) => F.indexOf(k)
    const iX = ix("x"), iY = ix("y"), iZ = ix("z"), iH = ix("height"), iR = ix("crownR"), iB = ix("crownBase"), iCX = ix("crownX"), iCY = ix("crownY")
    const n = Math.floor(D.length / nf)
    this.treeN = n
    this.tcx = new Float32Array(n)
    this.tcy = new Float32Array(n)
    this.tcz = new Float32Array(n)
    this.tcr = new Float32Array(n)
    this.trz = new Float32Array(n)
    this.tstamp = new Uint32Array(n)
    if (w.rules?.canopyDensity !== undefined) this.canopyDensity = w.rules.canopyDensity
    if (w.rules?.canopyBlockT !== undefined) this.canopyBlockT = w.rules.canopyBlockT
    const G = this.TG
    this.tgw = Math.ceil((this.nx * this.step) / G) + 1
    this.tgh = Math.ceil((this.ny * this.step) / G) + 1
    const cells: number[][] = Array.from({ length: this.tgw * this.tgh }, () => [])
    for (let k = 0; k < n; k++) {
      const o = k * nf
      const x = D[o + iX], y = D[o + iY], z = D[o + iZ], h = D[o + iH], cr = D[o + iR], cb = D[o + iB]
      const cx = iCX >= 0 && D[o + iCX] !== null && !Number.isNaN(D[o + iCX]) ? D[o + iCX] : x
      const cy = iCY >= 0 && D[o + iCY] !== null && !Number.isNaN(D[o + iCY]) ? D[o + iCY] : y
      const v = z + cb, top = z + h
      this.tcx[k] = cx
      this.tcy[k] = cy
      this.tcz[k] = (v + top) / 2
      this.tcr[k] = cr
      this.trz[k] = Math.max((top - v) / 2, 0.5)
      const i0 = Math.floor((cx - cr - this.minX) / G), i1 = Math.floor((cx + cr - this.minX) / G)
      const j0 = Math.floor((cy - cr - this.minY) / G), j1 = Math.floor((cy + cr - this.minY) / G)
      for (let j = Math.max(0, j0); j <= Math.min(this.tgh - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(this.tgw - 1, i1); i++) cells[j * this.tgw + i].push(k)
    }
    this.tgrid = cells.map((c) => Int32Array.from(c))
  }

  /** Light that passes the tree crowns between two points (1 = clear, 0 = fully blocked; exits early once blocked). */
  canopyT(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    if (!this.treeN) return 1
    const G = this.TG, dx = x1 - x0, dy = y1 - y0, dz = z1 - z0
    const L = Math.hypot(dx, dy, dz)
    const limit = Math.log(1 / this.canopyBlockT) / this.canopyDensity + 0.01
    const gen = ++this.tgen
    let acc = 0
    // walk the 8 m tree cells along the horizontal segment
    const gx = (x0 - this.minX) / G, gy = (y0 - this.minY) / G, ex = (x1 - this.minX) / G, ey = (y1 - this.minY) / G
    let i = Math.floor(gx), j = Math.floor(gy)
    const ie = Math.floor(ex), je = Math.floor(ey)
    const ddx = ex - gx, ddy = ey - gy
    const si = ddx > 0 ? 1 : -1, sj = ddy > 0 ? 1 : -1
    const tdx = ddx !== 0 ? Math.abs(1 / ddx) : Infinity, tdy = ddy !== 0 ? Math.abs(1 / ddy) : Infinity
    let tmx = ddx > 0 ? (i + 1 - gx) / ddx : ddx < 0 ? (gx - i) / -ddx : Infinity
    let tmy = ddy > 0 ? (j + 1 - gy) / ddy : ddy < 0 ? (gy - j) / -ddy : Infinity
    const steps = Math.abs(ie - i) + Math.abs(je - j) + 1
    for (let k = 0; k < steps; k++) {
      if (i >= 0 && j >= 0 && i < this.tgw && j < this.tgh) {
        const list = this.tgrid[j * this.tgw + i]
        for (let q = 0; q < list.length; q++) {
          const tr = list[q]
          if (this.tstamp[tr] === gen) continue
          this.tstamp[tr] = gen
          const R = this.tcr[tr], RZ = this.trz[tr]
          const cx = (x0 - this.tcx[tr]) / R, cy = (y0 - this.tcy[tr]) / R, cz = (z0 - this.tcz[tr]) / RZ
          const vx = dx / R, vy = dy / R, vz = dz / RZ
          const A = vx * vx + vy * vy + vz * vz
          if (A < 1e-9) continue
          const B = 2 * (cx * vx + cy * vy + cz * vz), C = cx * cx + cy * cy + cz * cz - 1
          const disc = B * B - 4 * A * C
          if (disc <= 0) continue
          const sq = Math.sqrt(disc)
          const ta = (-B - sq) / (2 * A), tb = (-B + sq) / (2 * A)
          if (tb < 0 || ta > 1) continue
          acc += (Math.min(tb, 1) - Math.max(ta, 0)) * L
          if (acc > limit) return 0
        }
      }
      if (tmx < tmy) (i += si), (tmx += tdx)
      else (j += sj), (tmy += tdy)
    }
    return Math.exp(-this.canopyDensity * acc)
  }

  /** Server vision test from an eye to a point: solids block; beyond `near` m, dense crowns block too. */
  sees(ex: number, ey: number, ez: number, x: number, y: number, z: number, near = 45): boolean {
    if (!this.los(ex, ey, ez, x, y, z)) return false
    if (Math.hypot(x - ex, y - ey) <= near) return true
    return this.canopyT(ex, ey, ez, x, y, z) >= this.canopyBlockT
  }

  /** Line of sight / shot path between two points, blocked by solids and terrain (not trees). */
  los(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const s = this.step, nx = this.nx, ny = this.ny
    const gx = (x0 - this.minX) / s, gy = (y0 - this.minY) / s
    const ex = (x1 - this.minX) / s, ey = (y1 - this.minY) / s
    const dx = ex - gx, dy = ey - gy, dz = z1 - z0
    let i = Math.floor(gx), j = Math.floor(gy)
    const ie = Math.floor(ex), je = Math.floor(ey)
    const si = dx > 0 ? 1 : -1, sj = dy > 0 ? 1 : -1
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity
    let tmx = dx > 0 ? (i + 1 - gx) / dx : dx < 0 ? (gx - i) / -dx : Infinity
    let tmy = dy > 0 ? (j + 1 - gy) / dy : dy < 0 ? (gy - j) / -dy : Infinity
    let t0 = 0
    const n = Math.abs(ie - i) + Math.abs(je - j) + 1
    const gnd = this.gnd, lo = this.solLo, hi = this.solHi
    for (let k = 0; k < n; k++) {
      const t1 = tmx < tmy ? (tmx < 1 ? tmx : 1) : tmy < 1 ? tmy : 1
      if (i >= 0 && j >= 0 && i < nx && j < ny) {
        const c = j * nx + i
        const za = z0 + dz * t0, zb = z0 + dz * t1
        const zl = za < zb ? za : zb, zh = za < zb ? zb : za
        if (zl < gnd[c] - 0.3) return false
        if (zh >= lo[c] && zl <= hi[c]) return false
      }
      if (tmx < tmy) {
        i += si
        t0 = tmx
        tmx += tdx
      } else {
        j += sj
        t0 = tmy
        tmy += tdy
      }
    }
    return true
  }

  // ---- nav grid ----
  nodeOf(x: number, y: number): number {
    const I = Math.floor((x - this.minX) / (2 * this.step)), J = Math.floor((y - this.minY) / (2 * this.step))
    if (I < 0 || J < 0 || I >= this.NW || J >= this.NH) return -1
    return J * this.NW + I
  }
  nodeX(n: number) {
    return this.minX + (2 * (n % this.NW) + 1) * this.step
  }
  nodeY(n: number) {
    return this.minY + (2 * Math.floor(n / this.NW) + 1) * this.step
  }
  passable(n: number, rq: number) {
    return n >= 0 && this.nClear[n] >= rq
  }
  /** Can a mech step from node a to adjacent node b? */
  stepOk(a: number, b: number, diag: boolean) {
    return this.nSurf[b] - this.nSurf[a] <= (diag ? RISE_DIAG : RISE_ORTHO)
  }

  /** Connected components of the nav graph for a clearance requirement (cached). */
  comp(rq: number): Int32Array {
    const key = Math.round(rq * 10)
    let c = this.comps.get(key)
    if (c) return c
    const NW = this.NW, NH = this.NH, N = NW * NH
    c = new Int32Array(N).fill(-1)
    const q = new Int32Array(N)
    let id = 0
    for (let s0 = 0; s0 < N; s0++) {
      if (c[s0] >= 0 || this.nClear[s0] < rq) continue
      let qh = 0, qt = 0
      q[qt++] = s0
      c[s0] = id
      while (qh < qt) {
        const n = q[qh++]
        const I = n % NW, J = (n - I) / NW
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue
            const I2 = I + di, J2 = J + dj
            if (I2 < 0 || J2 < 0 || I2 >= NW || J2 >= NH) continue
            const m = J2 * NW + I2
            if (c[m] >= 0 || this.nClear[m] < rq) continue
            const diag = di !== 0 && dj !== 0
            if (diag && (this.nClear[J * NW + I2] < rq || this.nClear[J2 * NW + I] < rq)) continue
            if (!this.stepOk(n, m, diag)) continue
            c[m] = id
            q[qt++] = m
          }
      }
      id++
    }
    this.comps.set(key, c)
    return c
  }

  /** Nearest passable node to (x, y), optionally in component `want` (ring search, O(maxR^2)). */
  snap(x: number, y: number, rq: number, want = -1, maxR = 40): number {
    const NW = this.NW, NH = this.NH
    const I0 = Math.floor((x - this.minX) / (2 * this.step)), J0 = Math.floor((y - this.minY) / (2 * this.step))
    const comp = want >= 0 ? this.comp(rq) : null
    let best = -1, bestD = Infinity
    const test = (I: number, J: number) => {
      if (I < 0 || J < 0 || I >= NW || J >= NH) return
      const n = J * NW + I
      if (this.nClear[n] < rq) return
      if (comp && comp[n] !== want) return
      const d = (I - I0) * (I - I0) + (J - J0) * (J - J0)
      if (d < bestD) (bestD = d), (best = n)
    }
    test(I0, J0)
    for (let r = 1; r <= maxR; r++) {
      if (best >= 0 && r * r > bestD) break
      for (let k = -r; k <= r; k++) {
        test(I0 + k, J0 - r)
        test(I0 + k, J0 + r)
      }
      for (let k = -r + 1; k <= r - 1; k++) {
        test(I0 - r, J0 + k)
        test(I0 + r, J0 + k)
      }
    }
    return best
  }

  /** Straight walk from (x0,y0) to (x1,y1) stays on passable nodes without big steps up. */
  walkLine(x0: number, y0: number, x1: number, y1: number, rq: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0)
    const n = Math.max(1, Math.ceil(d / 1.0))
    let prev = this.nodeOf(x0, y0)
    for (let k = 1; k <= n; k++) {
      const f = k / n
      const m = this.nodeOf(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)
      if (m === prev) continue
      if (!this.passable(m, rq)) return false
      if (prev >= 0 && this.nSurf[m] - this.nSurf[prev] > RISE_DIAG) return false
      prev = m
    }
    return true
  }
}
