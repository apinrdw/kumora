import { WaitUntil, WorkerEnv } from "@workspace/server"
import { Context, DateTime, Effect, Layer } from "effect"

import { SENDER, SENDING_SUBDOMAIN } from "./sender.ts"

export interface Mail {
  readonly to: string
  readonly subject: string
  readonly text: string
}

// Raw MIME, so the local simulator under `alchemy dev` writes a whole `.eml`
// (with its To: header) that e2e can find by address. Its message builder
// writes only the body.
const toMime = (mail: Mail, date: DateTime.Utc) =>
  Effect.sync(() =>
    [
      `From: KUMORA <${SENDER}>`,
      `To: ${mail.to}`,
      `Subject: ${mail.subject}`,
      `Date: ${DateTime.toDateUtc(date).toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${SENDING_SUBDOMAIN}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      mail.text,
    ].join("\r\n")
  )

export class Mailer extends Context.Service<
  Mailer,
  {
    // Hands the send to waitUntil and returns at once; a failed send is
    // logged, never seen by the caller.
    readonly send: (mail: Mail) => Effect.Effect<void>
  }
>()("dashboard/server/auth/Mailer") {
  static readonly layer = Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const env = yield* WorkerEnv
      const { waitUntil } = yield* WaitUntil
      const { EmailMessage } = yield* Effect.promise(
        () => import("cloudflare:email")
      )
      const send = Effect.fn("Mailer.send")(function* (mail: Mail) {
        const raw = yield* toMime(mail, yield* DateTime.now)
        const delivery = Effect.tryPromise(() =>
          env.EMAIL.send(new EmailMessage(SENDER, mail.to, raw))
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Mail send failed", cause)
          )
        )
        // Decision: the send is its own runtime boundary. It outlives the
        // request's fiber, and Cloudflare's waitUntil keeps the isolate alive
        // only for a Promise, so it runs with runPromiseWith on the request's
        // context. CODING_STANDARDS.md lists it among the runtimes.
        const context = yield* Effect.context<never>()
        waitUntil(Effect.runPromiseWith(context)(delivery))
      })
      return Mailer.of({ send })
    })
  )
}
