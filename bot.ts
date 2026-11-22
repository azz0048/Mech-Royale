import { log, run, type Bot, type Hello, type Observation } from "./mechfight.ts"
import { Brain } from "./src/brain.ts"

/** Minimal fallback if the full brain cannot start (e.g. map missing): go to the zone, shoot what we see. */
function fallback(): Bot {
  return {
    name: "not-even-close",
    act(obs: Observation) {
      const [x, y, z] = obs.self.pos
      const g = obs.zone.next_center
      const yaw = Math.atan2(g[1] - y, g[0] - x)
      const e = obs.mechs.filter((m) => m.kind === "mech").sort((a, b) => Math.hypot(a.pos[0] - x, a.pos[1] - y) - Math.hypot(b.pos[0] - x, b.pos[1] - y))[0]
      if (!e) return { move: [Math.cos(yaw), Math.sin(yaw)], aim: [yaw, 0], boost: !obs.self.in_zone, ...(obs.offer && { pick: 0 }) }
      const d = Math.hypot(e.pos[0] - x, e.pos[1] - y)
      return { move: [Math.cos(yaw), Math.sin(yaw)], aim: [Math.atan2(e.pos[1] - y, e.pos[0] - x), Math.atan2(e.pos[2] + 4.5 - z - 7, d)], fire: [true, false], ...(obs.offer && { pick: 0 }) }
    },
  }
}

run((hello: Hello) => {
  for (const dir of [hello.map?.dir, "/arena"]) {
    if (!dir) continue
    try {
      return new Brain({ ...hello, map: { ...hello.map, dir } })
    } catch (e) {
      log(`brain failed with map dir ${dir}:`, e)
    }
  }
  return fallback()
})
