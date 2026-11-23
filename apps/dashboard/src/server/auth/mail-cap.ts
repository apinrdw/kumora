import type { DBTransactionAdapter } from "better-auth"
import { Context, DateTime, Duration, Effect, Schema } from "effect"

import { MAIL_CAP_MODEL } from "./options.ts"

// Decision: at most 5 verification and reset mails per address per day, in D1
// (apps/dashboard/docs/adr/0036-at-most-5-auth-mails-per-address-per-day.md)
const MAX_MAILS = 5
const WINDOW_MS = Duration.toMillis(Duration.days(1))

/** The address has had its mails for the day; the next fits in `retryAfter` seconds. */
export class TooManyMails extends Schema.TaggedError<TooManyMails>()(
  "TooManyMails",
  { retryAfter: Schema.Number }
) {}

interface Row {
  readonly count: number
  // A bigint column; the adapter may hand it back as a string.
  readonly windowStart: number | string
}

// The part of Better Auth's adapter the cap uses; a transaction's adapter has
// it too.
type Store = Pick<DBTransactionAdapter, "findOne" | "create" | "incrementOne">

// Whether this call counted its mail, or lost a race and must read again.
type Write = "counted" | "raced"

export class MailCap extends Context.Service<
  MailCap,
  {
    // Counts one mail to `address`, or fails when the day's mails are spent.
    readonly take: (address: string) => Effect.Effect<void, TooManyMails>
  }
>()("dashboard/server/auth/MailCap") {
  // Over Better Auth's own adapter, so D1 and the test seam's SQLite share one
  // code path. A failed query is a defect, which the callback answers as 500.
  static readonly make = (adapter: Effect.Effect<Store>) =>
    Effect.sync(() => {
      const query = <A>(run: (db: Store) => Promise<A>) =>
        Effect.flatMap(adapter, (db) => Effect.promise(() => run(db)))
      const read = (address: string) =>
        query((db) =>
          db.findOne<Row>({
            model: MAIL_CAP_MODEL,
            where: [{ field: "address", value: address }],
          })
        )
      // Each write is guarded on the row it read, so two isolates racing for
      // the last mail can't both count it.
      const guarded = (
        address: string,
        row: { count: number; windowStart: number },
        write: { increment: Record<string, number>; set?: Partial<Row> }
      ) =>
        query((db) =>
          db.incrementOne({
            model: MAIL_CAP_MODEL,
            where: [
              { field: "address", value: address },
              { field: "windowStart", value: row.windowStart },
              { field: "count", value: row.count },
            ],
            ...write,
          })
        ).pipe(Effect.map((updated): Write => (updated ? "counted" : "raced")))
      const open = (address: string, now: number) =>
        query((db) =>
          db.create({
            model: MAIL_CAP_MODEL,
            data: { address, count: 1, windowStart: now },
          })
        ).pipe(
          Effect.as<Write>("counted"),
          // Another request created the row first.
          Effect.catchDefect((defect) =>
            read(address).pipe(
              Effect.flatMap((row) =>
                row ? Effect.succeed<Write>("raced") : Effect.die(defect)
              )
            )
          )
        )

      const take = (address: string): Effect.Effect<void, TooManyMails> =>
        Effect.gen(function* () {
          const now = DateTime.toEpochMillis(yield* DateTime.now)
          const found = yield* read(address)
          if (found === null) {
            if ((yield* open(address, now)) === "raced") yield* take(address)
            return
          }
          const row = {
            count: found.count,
            windowStart: Number(found.windowStart),
          }
          const ends = row.windowStart + WINDOW_MS
          let write: Write
          if (now >= ends)
            write = yield* guarded(address, row, {
              increment: {},
              set: { count: 1, windowStart: now },
            })
          else if (row.count >= MAX_MAILS)
            return yield* new TooManyMails({
              retryAfter: Math.ceil((ends - now) / 1000),
            })
          else write = yield* guarded(address, row, { increment: { count: 1 } })
          if (write === "raced") yield* take(address)
        })

      return MailCap.of({ take: Effect.fn("MailCap.take")(take) })
    })
}
