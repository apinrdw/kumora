// The route-loader side of the bridge. It runs in the browser and during SSR,
// so it never imports bridge.ts or reaches cloudflare:workers.
import {
  createSerializationAdapter,
  isRedirect,
  notFound,
} from "@tanstack/react-router"
import { Effect, Option, Schema } from "effect"

import {
  BadRequest,
  Conflict,
  ErrorBody,
  Forbidden,
  NotFound,
} from "./errors.ts"

// The HTTP errors a loader receives as values. Unauthorized arrives as a
// router redirect instead, and the router follows it.
export const LoaderError = Schema.Union([
  NotFound,
  BadRequest,
  Forbidden,
  Conflict,
])
export type LoaderError = typeof LoaderError.Type

const ErrorBodyJson = Schema.fromJsonString(ErrorBody)

const decodeBody = Effect.fnUntraced(function* (response: Response) {
  const text = yield* Effect.tryPromise(() => response.clone().text())
  const { error, message } = yield* Schema.decodeEffect(ErrorBodyJson)(text)
  return yield* Schema.decodeUnknownEffect(LoaderError)({
    _tag: error,
    message,
  })
})

// A failure outside the closed set (a redirect, a notFound(), a 500, a network
// failure) dies with the thrown value unchanged, so runPromise rejects with it
// and the router handles it as it would without Effect.
const decodeFailure = Effect.fnUntraced(function* (thrown: unknown) {
  if (!(thrown instanceof Response) || isRedirect(thrown))
    return yield* Effect.die(thrown)
  const decoded = yield* Effect.option(decodeBody(thrown))
  if (Option.isNone(decoded)) return yield* Effect.die(thrown)
  return yield* Effect.fail(decoded.value)
})

// Calls a server function from a route loader. A closed-set HTTP error comes
// back as a typed failure, which runLoader hands to the router.
export const loadServerFn = Effect.fnUntraced(function* <A>(
  call: () => Promise<A>
): Effect.fn.Return<A, LoaderError> {
  return yield* Effect.tryPromise({
    try: call,
    catch: (thrown) => thrown,
  }).pipe(Effect.catch(decodeFailure))
})

// Runs a route loader's Effect for the router. It needs no services, so it runs
// without the client runtime, which loaders could not use during SSR. A
// NotFound dies as the router's notFound(), for the route's notFoundComponent;
// the other closed-set errors reject as themselves, for its errorComponent.
export const runLoader = <A>(
  effect: Effect.Effect<A, LoaderError>
): Promise<A> =>
  Effect.runPromise(
    Effect.catchTag(effect, "NotFound", () => Effect.die(notFound()))
  )

// The router dehydrates any other Error to a bare `new Error(message)`. Register
// this in the app's createStart so errorComponent sees the same LoaderError
// after hydration as on the server's first paint.
export const loaderErrorAdapter = createSerializationAdapter({
  key: "kumora/LoaderError",
  test: Schema.is(LoaderError),
  toSerializable: (error) => Schema.encodeSync(LoaderError)(error),
  fromSerializable: (encoded: typeof LoaderError.Encoded) =>
    Schema.decodeSync(LoaderError)(encoded),
})
