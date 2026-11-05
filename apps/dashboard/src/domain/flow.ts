export type FlowPoint = {
  /** Axis label, unique per point: a session date or a broker code. */
  label: string
  /** Net value in Rupiah; positive = net buy. */
  net: number
}
