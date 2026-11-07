// Reads and writes of the auth database that Better Auth's API can't express:
// the /admin/users listing (its list-users endpoint has one search field, one
// filter and no session data) and the admin grant.
import { createKyselyAdapter } from "@better-auth/kysely-adapter"
import { Context, Effect, Layer } from "effect"
import type { UnknownError } from "effect/Cause"
import { sql, type Kysely, type SqlBool } from "kysely"

import {
  PAGE_SIZE,
  type AccountPage,
  type AccountSearch,
  type SignInMethod,
  type StoredAccount,
  type Status,
} from "@/lib/account-query"

import type { AuthOptionsInput } from "./options.ts"
import type { Role } from "./policy.ts"
import { storedRoleOf } from "./session-account.ts"

// The columns read here, as Better Auth's Kysely adapter stores them on
// SQLite: booleans as 0/1, dates as ISO strings. migrations/ holds the schema.
interface Tables {
  readonly user: {
    readonly id: string
    readonly name: string
    readonly email: string
    readonly emailVerified: number
    readonly role: string | null
    readonly banned: number | null
    readonly banReason: string | null
    readonly createdAt: string
    readonly updatedAt: string
  }
  readonly session: {
    readonly userId: string
    readonly expiresAt: string
    readonly updatedAt: string
    // Set while an admin views as the account; not the account's own.
    readonly impersonatedBy: string | null
  }
  readonly account: { readonly userId: string; readonly providerId: string }
}

// Better Auth's provider ids; any other provider isn't a sign-in method here.
const METHOD: Record<string, SignInMethod> = {
  credential: "password",
  google: "google",
}

const STATUS_SQL = {
  suspended: sql<SqlBool>`coalesce("banned", 0) = 1`,
  unverified: sql<SqlBool>`coalesce("banned", 0) = 0 and "emailVerified" = 0`,
  active: sql<SqlBool>`coalesce("banned", 0) = 0 and "emailVerified" = 1`,
} as const satisfies Record<Status, unknown>

const ROLE_SQL = {
  admin: sql<SqlBool>`"role" = 'admin'`,
  member: sql<SqlBool>`coalesce("role", '') <> 'admin'`,
} as const satisfies Record<Role, unknown>

const listAccounts = async (
  db: Kysely<Tables>,
  query: AccountSearch
): Promise<AccountPage<StoredAccount>> => {
  const now = new Date().toISOString()
  const needle = (query.q ?? "").trim().toLowerCase()
  const matching = db
    .selectFrom("user")
    .$if(needle !== "", (q) =>
      q.where(
        sql<SqlBool>`(instr(lower("email"), ${needle}) > 0 or instr(lower("name"), ${needle}) > 0)`
      )
    )
    .$if(query.role !== undefined, (q) => q.where(ROLE_SQL[query.role!]))
    .$if(query.status !== undefined, (q) => q.where(STATUS_SQL[query.status!]))
  const lastActiveAt = sql<
    string | null
  >`(select max("updatedAt") from "session" where "session"."userId" = "user"."id" and "session"."impersonatedBy" is null)`
  const key = query.sort ?? "createdAt"
  const dir = query.dir ?? "desc"
  const [rows, count] = await Promise.all([
    matching
      .select([
        "id",
        "email",
        "name",
        "role",
        "banned",
        "banReason",
        "emailVerified",
        "createdAt",
        lastActiveAt.as("lastActiveAt"),
        sql<number>`(select count(*) from "session" where "session"."userId" = "user"."id" and "session"."impersonatedBy" is null and "session"."expiresAt" > ${now})`.as(
          "sessions"
        ),
        sql<
          string | null
        >`(select group_concat(distinct "providerId") from "account" where "account"."userId" = "user"."id")`.as(
          "providers"
        ),
      ])
      // Accounts with no session sort last either way.
      .$if(key === "lastActiveAt", (q) =>
        q.orderBy(sql`${lastActiveAt} is null`).orderBy(lastActiveAt, dir)
      )
      .orderBy("createdAt", key === "createdAt" ? dir : "desc")
      .orderBy("id")
      .limit(PAGE_SIZE)
      .offset(((query.page ?? 1) - 1) * PAGE_SIZE)
      .execute(),
    matching
      .select(sql<number>`count(*)`.as("total"))
      .executeTakeFirstOrThrow(),
  ])
  return {
    total: Number(count.total),
    rows: rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: storedRoleOf(row.role),
      banReason: row.banned ? row.banReason : null,
      emailVerified: row.emailVerified === 1,
      status: row.banned
        ? "suspended"
        : row.emailVerified
          ? "active"
          : "unverified",
      methods: [
        ...new Set(
          (row.providers ?? "")
            .split(",")
            .flatMap((id) => (id in METHOD ? [METHOD[id]!] : []))
        ),
      ].sort(),
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      sessions: Number(row.sessions),
    })),
  }
}

export class Accounts extends Context.Service<
  Accounts,
  {
    readonly list: (
      query: AccountSearch
    ) => Effect.Effect<AccountPage<StoredAccount>, UnknownError>
    readonly makeAdmin: (userId: string) => Effect.Effect<void, UnknownError>
  }
>()("dashboard/server/auth/Accounts") {
  static readonly make = (database: AuthOptionsInput["database"]) =>
    Layer.effect(
      Accounts,
      Effect.gen(function* () {
        const { kysely } = yield* Effect.tryPromise(() =>
          createKyselyAdapter({ database })
        )
        if (kysely === null)
          return yield* Effect.die(new Error("No auth database"))
        const db = kysely as Kysely<Tables>
        return Accounts.of({
          list: (query) => Effect.tryPromise(() => listAccounts(db, query)),
          makeAdmin: (userId) =>
            Effect.tryPromise(() =>
              db
                .updateTable("user")
                .set({ role: "admin", updatedAt: new Date().toISOString() })
                .where("id", "=", userId)
                .execute()
            ).pipe(Effect.asVoid),
        })
      })
    )
}
