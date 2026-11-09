import { Layer, ManagedRuntime } from "effect"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Socket from "effect/socket/Socket"

import { FrameScheduler } from "./frame-scheduler.ts"

// Builds without I/O, so importing it during SSR is safe.
export const clientLayer = Layer.mergeAll(
  FrameScheduler.layer,
  // The browser's WebSocket, for Market Live's viewer socket.
  Socket.layerWebSocketConstructorGlobal,
  // The browser's fetch, for Market Live's GETs.
  FetchHttpClient.layer
)

export const clientRuntime = ManagedRuntime.make(clientLayer)
