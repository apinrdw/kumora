// What the landing page imports to join the waitlist. Call it through
// loadServerFn (@workspace/server/loader): a malformed email fails as
// BadRequest, and a D1 failure as a bare 500.
import { createServerFn } from "@tanstack/react-start"
import { runServerEffect } from "@workspace/server"
import { Effect, Schema } from "effect"

import { waitlistDbD1 } from "./db.ts"
import { JoinWaitlistInput, takeQueueNumber } from "./waitlist.ts"

export const joinWaitlist = createServerFn({ method: "POST" })
  .validator(Schema.decodeUnknownSync(JoinWaitlistInput))
  .handler(({ data }) =>
    runServerEffect(takeQueueNumber(data).pipe(Effect.provide(waitlistDbD1)))
  )
