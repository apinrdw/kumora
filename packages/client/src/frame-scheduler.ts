import { Context, Effect, Layer } from "effect"

export class FrameScheduler extends Context.Service<
  FrameScheduler,
  {
    // Completes at the next animation frame.
    readonly nextFrame: Effect.Effect<void>
  }
>()("@workspace/client/FrameScheduler") {
  static readonly layer = Layer.succeed(FrameScheduler, {
    nextFrame: Effect.callback<void>((resume) => {
      const id = requestAnimationFrame(() => resume(Effect.void))
      return Effect.sync(() => cancelAnimationFrame(id))
    }),
  })
}
