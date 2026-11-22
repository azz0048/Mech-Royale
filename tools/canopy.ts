// How much do tree crowns hide a standing mech from far observers, on top of buildings and terrain?
import { GameMap } from "../src/map.ts"
const m = new GameMap("../mechfight-kit/arena")
const rq = 3.4
const R = Number(process.argv[2] ?? 120)
let tot = 0
const hist = { los: new Array(17).fill(0), can: new Array(17).fill(0) }
for (let n = 0; n < m.NW * m.NH; n += 3) {
  if (!m.passable(n, rq)) continue
  const x = m.nodeX(n), y = m.nodeY(n), z = m.surfAt(x, y)
  tot++
  let hl = 0, hc = 0
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2
    const ex = x + Math.cos(a) * R, ey = y + Math.sin(a) * R, ez = m.surfAt(ex, ey) + 8
    const lc = m.los(ex, ey, ez, x, y, z + 4.5), lt = m.los(ex, ey, ez, x, y, z + 9)
    if (!lc && !lt) hl++
    const c = m.sees(ex, ey, ez, x, y, z + 4.5), top = m.sees(ex, ey, ez, x, y, z + 9)
    if (!c && !top) hc++
  }
  hist.los[hl]++
  hist.can[hc]++
}
const share = (h: number[], k: number) => ((h.slice(k).reduce((a, b) => a + b, 0) / tot) * 100).toFixed(1) + "%"
console.log(`observers at ${R} m, eye 8 m; share of nav points hidden from at least k of 16 directions`)
for (const k of [4, 8, 12, 14, 16]) console.log(`k=${k}: buildings/terrain only ${share(hist.los, k)}   + tree crowns ${share(hist.can, k)}`)
