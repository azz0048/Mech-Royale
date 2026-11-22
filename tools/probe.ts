import { GameMap } from "../src/map.ts"
const m = new GameMap("../mechfight-kit/arena")
const [x, y] = [Number(process.argv[2]), Number(process.argv[3])]
const rq = 3.4
const n = m.nodeOf(x, y)
console.log("node", n, "clear", m.nClear[n].toFixed(2), "surf", m.nSurf[n].toFixed(2), "gnd", m.groundAt(x, y).toFixed(2), "cellWall", m.wall[m.cellOf(x, y)], "comp", m.comp(rq)[n])
for (let k = 0; k < 8; k++) {
  const a = (k / 8) * Math.PI * 2
  const px = x + Math.cos(a) * 5, py = y + Math.sin(a) * 5
  const q = m.nodeOf(px, py)
  console.log(`dir ${k * 45}: walk5=${m.walkLine(x, y, px, py, rq)} clear=${m.nClear[q].toFixed(1)} surf=${m.nSurf[q].toFixed(1)}`)
}
