export type V2 = [number, number]
export type V3 = [number, number, number]

export const TAU = Math.PI * 2

/** Signed smallest difference a - b, in (-PI, PI]. */
export function angDiff(a: number, b: number): number {
  let d = (a - b) % TAU
  if (d > Math.PI) d -= TAU
  else if (d <= -Math.PI) d += TAU
  return d
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const dist2 = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay)
export const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
export const yawTo = (ax: number, ay: number, bx: number, by: number) => Math.atan2(by - ay, bx - ax)

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
