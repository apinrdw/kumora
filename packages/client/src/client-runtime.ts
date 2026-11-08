import { ManagedRuntime } from "effect"

import { FrameScheduler } from "./frame-scheduler.ts"

// Builds without I/O, so importing it during SSR is safe.
export const clientLayer = FrameScheduler.layer

export const clientRuntime = ManagedRuntime.make(clientLayer)
