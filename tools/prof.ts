// Profile slow decisions: replay a jsonl stream through the Brain, time wrapped methods per tick.
import { readFileSync } from "node:fs"
import { Brain } from "../src/brain.ts"
import { draw } from "../mechfight.ts"
const file = process.argv[2]
const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = "../mechfight-kit/arena"
const file2 = file
const b: any = new Brain(hello)
const acc = new Map<string, number>()
const wrap = (obj: any, name: string, label: string) => {
  const f = obj[name].bind(obj)
  obj[name] = (...a: any[]) => {
    const t0 = performance.now()
    try { return f(...a) } finally { acc.set(label, (acc.get(label) ?? 0) + performance.now() - t0) }
  }
}
wrap(b.nav, "steer", "nav.steer")
wrap(b.nav.pf, "run", "astar.run")
wrap(b.nav.pf, "begin", "astar.begin")
wrap(b.m, "snap", "snap")
wrap(b.m, "comp", "comp")
wrap(b.m, "walkLine", "walkLine")
for (const k of ["coverPoint", "roam", "dropGoal", "steerLocal", "fireControl", "dodge", "wantedPickup", "duelItem", "fightMove", "look"]) wrap(b.practice, k, "P." + k)
for (const k of ["zoneGoal", "needRotate", "lootGoal", "dropGoal", "replan", "fireControl", "lookDir", "mortarDodge", "findCover"]) wrap(b, k, k)
const times: number[] = []
for (const o of lines.slice(1)) {
  if (o.type !== "obs") continue
  acc.clear()
  const t0 = performance.now()
  b.act(o)
  const ms = performance.now() - t0
  times.push(ms)
  draw.clear()
  if (ms > 4) console.log(o.t, b.state, ms.toFixed(1), [...acc.entries()].filter(([, v]) => v > 0.5).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" "))
}
times.sort((a, b) => a - b)
console.log("p99", times[Math.floor(times.length * 0.99)].toFixed(2), "max", times[times.length - 1].toFixed(1))
