import { Schema } from "effect"

import { IsoDateTime } from "./time"

/** The model's pattern classification. `insufficient` means it declines a verdict. */
export const Signal = Schema.Literals([
  "accumulation",
  "distribution",
  "mixed",
  "neutral",
  "insufficient",
])
export type Signal = typeof Signal.Type

/** A signal that names a direction. */
export const Pattern = Signal.pick(["accumulation", "distribution", "mixed"])
export type Pattern = typeof Pattern.Type

/** Classifier certainty 0 to 100, never a probability of profit. */
export const Confidence = Schema.Number.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  Schema.brand("Confidence")
)
export type Confidence = typeof Confidence.Type

export const Evidence = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  source: Schema.optionalKey(Schema.String),
  asOf: Schema.optionalKey(IsoDateTime),
})
export type Evidence = typeof Evidence.Type

export const Contribution = Schema.Struct({
  label: Schema.String,
  /** −1 … 1; negative weakens the hypothesis. */
  weight: Schema.Number,
})
export type Contribution = typeof Contribution.Type

export const AIInput = Schema.Struct({
  label: Schema.String,
  source: Schema.optionalKey(Schema.String),
  asOf: Schema.optionalKey(IsoDateTime),
})
export type AIInput = typeof AIInput.Type
