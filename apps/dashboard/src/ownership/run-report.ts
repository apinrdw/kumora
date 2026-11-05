/** The operator's `_scripts/lapor.py`, outside this repo, sends one of these. Change the two together. */
const OUTCOMES = ["new-files", "nothing-new", "blocked", "failed"] as const
type Outcome = (typeof OUTCOMES)[number]

const isOutcome = (value: unknown): value is Outcome =>
  OUTCOMES.some((outcome) => outcome === value)

const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** The operator's `_scripts/lapor.py`, outside this repo, sends these JSON keys. Change the two together. */
export type RunReport = {
  /** Normalised to UTC, so instants sort as text whatever offset was sent. */
  readonly ranAt: string
  readonly outcome: Outcome
  readonly detail: string | null
  readonly filesSent: number
}

const instant = (value: unknown) => {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

const isFileCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

const isDetail = (value: unknown): value is string | null =>
  value === null || typeof value === "string"

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Null for anything but the contract's shape. */
export const parseRunReport = (text: string): RunReport | null => {
  const body = parseJson(text) as Record<string, unknown> | null
  if (typeof body !== "object" || body === null) return null
  const { ranAt, outcome, detail, filesSent } = body
  const at = instant(ranAt)
  if (at === null || !isOutcome(outcome)) return null
  if (!isDetail(detail) || !isFileCount(filesSent)) return null
  return { ranAt: at, outcome, detail, filesSent }
}
