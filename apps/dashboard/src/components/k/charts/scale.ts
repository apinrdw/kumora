/**
 * Round [lo, hi] outward to a 1-2-5 step so axis labels read 9.200, 9.225…
 * rather than 9.193, 9.227…. Returns the padded domain and its ticks.
 */
export function niceScale(
  lo: number,
  hi: number,
  count = 4
): { domain: [number, number]; ticks: Array<number> } {
  const span = hi - lo || Math.abs(hi) || 1
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag
  const start = Math.floor(lo / step) * step
  const end = Math.ceil(hi / step) * step
  const ticks: Array<number> = []
  for (let t = start; t <= end + step / 2; t += step) ticks.push(t)
  return { domain: [start, end], ticks }
}
