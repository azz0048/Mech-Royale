import { GameMap } from "../src/map.ts"
const dir = process.argv[2] ?? "../mechfight-kit/arena"
let t0 = performance.now()
const m = new GameMap(dir)
const tBuild = performance.now() - t0
let walls = 0
for (let c = 0; c < m.wall.length; c++) walls += m.wall[c]
const rq = 3.4
let pass = 0
for (let n = 0; n < m.nClear.length; n++) if (m.nClear[n] >= rq) pass++
t0 = performance.now()
const comp = m.comp(rq)
const tComp = performance.now() - t0
const sizes = new Map<number, number>()
for (const c of comp) if (c >= 0) sizes.set(c, (sizes.get(c) ?? 0) + 1)
const top = [...sizes.values()].sort((a, b) => b - a).slice(0, 5)
console.log({ tBuild: tBuild.toFixed(0), cells: m.wall.length, wallPct: ((100 * walls) / m.wall.length).toFixed(1), nodes: m.nClear.length, passPct: ((100 * pass) / m.nClear.length).toFixed(1), tComp: tComp.toFixed(1), comps: sizes.size, top })
// spawn point of recorded stream and oval center
for (const [x, y] of [[320.21, -280.29], [-217.98, -22.04], [0, 0], [41.3, -72.8], [-116, -32], [-423, -57]]) {
  const n = m.nodeOf(x, y)
  console.log(`(${x},${y}) gnd=${m.groundAt(x, y).toFixed(2)} surf=${m.surfAt(x, y).toFixed(2)} clear=${m.nClear[n].toFixed(1)} comp=${comp[n]}`)
}
// LOS benchmark
let ok = 0
t0 = performance.now()
for (let k = 0; k < 20000; k++) {
  const a = Math.random() * 800 - 400, b = Math.random() * 500 - 250
  const ang = Math.random() * 6.28, d = 50 + Math.random() * 200
  const x1 = a + Math.cos(ang) * d, y1 = b + Math.sin(ang) * d
  if (m.los(a, b, m.groundAt(a, b) + 8, x1, y1, m.groundAt(x1, y1) + 4.5)) ok++
}
console.log("los 20k rays ms", (performance.now() - t0).toFixed(1), "clear%", (ok / 200).toFixed(1))
