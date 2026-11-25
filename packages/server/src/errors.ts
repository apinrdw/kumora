import { Schema } from "effect"

// The closed set of failures a server function may send to HTTP. Every other
// failure is logged and answered as a bare 500 (CODING_STANDARDS.md).
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
}) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
}) {}

export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
}) {}

// `redirectTo` is a router path with its search, without the app's basepath.
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { redirectTo: Schema.String }
) {}

export const HttpError = Schema.Union([
  NotFound,
  BadRequest,
  Forbidden,
  Conflict,
  Unauthorized,
])
export type HttpError = typeof HttpError.Type

// The JSON body an HTTP error carries from the bridge to the route loader.
export const ErrorBody = Schema.Struct({
  error: Schema.String,
  message: Schema.String,
})
