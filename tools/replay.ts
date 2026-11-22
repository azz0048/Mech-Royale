// Feed the kit's recorded stream through the Brain in-process: timings, states, actions.
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { Brain } from "../src/brain.ts"
import { draw } from "../mechfight.ts"

const kit = process.argv[2] ?? "../mechfight-kit"
const lines = gunzipSync(readFileSync(kit + "/check/stream.jsonl.gz")).toString("utf8").trim().split("\n").map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = kit + "/arena"
let t0 = performance.now()
const b = new Brain(hello)
console.log("init ms", (performance.now() - t0).toFixed(0))
const times: number[] = []
const states = new Map<string, number>()
let fires = 0, takes = 0
for (const msg of lines.slice(1)) {
  if (msg.type !== "obs") continue
  t0 = performance.now()
  const a = b.act(msg)
  times.push(performance.now() - t0)
  draw.clear()
  states.set(b.state, (states.get(b.state) ?? 0) + 1)
  if (a.fire?.some(Boolean)) fires++
  if (a.take !== undefined) takes++
  if (msg.tick % 60 === 0) console.log(msg.t.toFixed(1), b.state, "hp", msg.self.hp, "pos", msg.self.pos.map((v: number) => v.toFixed(0)).join(","), "move", a.move, "aim", a.aim, "fire", a.fire, "mechs", msg.mechs.length)
}
times.sort((a, b) => a - b)
const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(2)
console.log({ n: times.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1), states: Object.fromEntries(states), fires, takes })
