// Robustness: feed mutated real observations to the Brain and count exceptions.
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { Brain } from "../src/brain.ts"
import { draw } from "../mechfight.ts"
import { rng } from "../src/geom.ts"

const kit = "../mechfight-kit"
const lines = gunzipSync(readFileSync(kit + "/check/stream.jsonl.gz")).toString("utf8").trim().split("\n").map((l) => JSON.parse(l))
const hello = lines[0]
hello.map.dir = kit + "/arena"
const obs = lines.filter((m: any) => m.type === "obs")
const R = rng(42)
let errors = 0, n = 0
const seen = new Map<string, number>()
for (let run = 0; run < 12; run++) {
  const b = new Brain(JSON.parse(JSON.stringify(hello)))
  for (const o0 of obs) {
    const o = JSON.parse(JSON.stringify(o0))
    // mutations
    for (const m of o.mechs) {
      if (R() < 0.3) delete m.hp
      if (R() < 0.3) delete m.max_hp
      if (R() < 0.3) delete m.weapons
      if (R() < 0.2) delete m.cubes
      if (R() < 0.1) m.kind = "npc"
    }
    if (R() < 0.1) o.mechs.push({ id: 100 + Math.floor(R() * 12), kind: "npc", pos: [o.self.pos[0] + 20, o.self.pos[1], o.self.pos[2]], vel: [0, 0, 0], aim: [0, 0] })
    if (R() < 0.1) o.self.weapons = [o.self.weapons[0], { kind: ["laser", "lightning", "mortar"][Math.floor(R() * 3)], cooldown: R(), charge: R() * 3, stats: {} }]
    if (R() < 0.05) o.self.weapons = [null, null]
    if (R() < 0.1) o.offer = { id: 1, expires: o.t + 5, choices: [{ id: "plating", name: "", desc: "" }].slice(0, Math.floor(R() * 2)) }
    if (R() < 0.1) o.drops = [{ id: 20000, pos: [o.self.pos[0] + 50, o.self.pos[1], o.self.pos[2]], radius: 8, lands_in: R() * 20, capture_s: 4, progress: 0, holder: R() < 0.5 ? null : 5 }]
    if (R() < 0.1) o.projectiles.push({ id: 1, kind: "mortar", pos: [o.self.pos[0] + 30, o.self.pos[1], o.self.pos[2] + 40], vel: [-10, 0, 5] })
    if (R() < 0.1) o.beams.push({ by: 5, kind: "laser", path: [[0, 0, 0], [1, 1, 1]], age: 0.1 })
    if (R() < 0.1) o.events.push({ type: "damaged", amount: 50, weapon: R() < 0.5 ? "zone" : "laser", bearing: R() < 0.3 ? null : 1, by: R() < 0.3 ? null : 5 })
    if (R() < 0.05) o.self.pos = [R() * 1000 - 500, R() * 700 - 330, 30]
    if (R() < 0.05) o.zone = { center: [0, 0], radius: 10, next_center: [5, 5], next_radius: 0, shrink_start: o.t - 1, shrink_end: o.t + 5, dps: 260 }
    n++
    try {
      const a = b.act(o)
      if (!a.move || !a.aim || a.aim.some((v: number) => !Number.isFinite(v)) || a.move.some((v: number) => !Number.isFinite(v))) throw new Error("bad action " + JSON.stringify(a).slice(0, 120))
    } catch (e: any) {
      errors++
      const k = String(e?.stack ?? e).split("\n").slice(0, 2).join(" | ")
      seen.set(k, (seen.get(k) ?? 0) + 1)
    }
    draw.clear()
  }
}
console.log({ n, errors })
for (const [k, v] of seen) console.log(v, k)
