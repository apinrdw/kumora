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
  type StoredAccount,
  type Status,
} from "@/lib/account-query"
import { signInMethodsOf } from "@/lib/sign-in-method"

import type { AuthOptionsInput } from "./options.ts"
import type { Role } from "./policy.ts"
import type { AdminList } from "./session-account.ts"

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

const STATUS_SQL = {
  suspended: sql<SqlBool>`coalesce("banned", 0) = 1`,
  unverified: sql<SqlBool>`coalesce("banned", 0) = 0 and "emailVerified" = 0`,
  active: sql<SqlBool>`coalesce("banned", 0) = 0 and "emailVerified" = 1`,
} as const satisfies Record<Status, unknown>

// The role as the access policy reads it (session-account.ts): a stored
// admin, or a verified email on the admin list before its grant is stored.
const isAdminSql = (adminList: AdminList) =>
  Effect.succeed(
    adminList.emails.length === 0
      ? sql<SqlBool>`"role" = 'admin'`
      : sql<SqlBool>`("role" = 'admin' or ("emailVerified" = 1 and lower("email") in (${sql.join(adminList.emails)})))`
  )

const listAccounts = Effect.fnUntraced(function* (
  db: Kysely<Tables>,
  query: AccountSearch,
  adminList: AdminList
): Effect.fn.Return<AccountPage<StoredAccount>, UnknownError> {
  const now = new Date().toISOString()
  const needle = (query.q ?? "").trim().toLowerCase()
  const isAdmin = yield* isAdminSql(adminList)
  const roleSql = {
    admin: isAdmin,
    member: sql<SqlBool>`not ${isAdmin}`,
  } as const satisfies Record<Role, unknown>
  const matching = db
    .selectFrom("user")
    .$if(needle !== "", (q) =>
      q.where(
        sql<SqlBool>`(instr(lower("email"), ${needle}) > 0 or instr(lower("name"), ${needle}) > 0)`
      )
    )
    .$if(query.role !== undefined, (q) => q.where(roleSql[query.role!]))
    .$if(query.status !== undefined, (q) => q.where(STATUS_SQL[query.status!]))
  const lastActiveAt = sql<
    string | null
  >`(select max("updatedAt") from "session" where "session"."userId" = "user"."id" and "session"."impersonatedBy" is null)`
  const key = query.sort ?? "createdAt"
  const dir = query.dir ?? "desc"
  const [rows, count] = yield* Effect.all(
    [
      Effect.tryPromise(() =>
        matching
          .select([
            "id",
            "email",
            "name",
            sql<number>`case when ${isAdmin} then 1 else 0 end`.as("isAdmin"),
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
          .execute()
      ),
      Effect.tryPromise(() =>
        matching
          .select(sql<number>`count(*)`.as("total"))
          .executeTakeFirstOrThrow()
      ),
    ],
    { concurrency: "unbounded" }
  )
  return {
    total: Number(count.total),
    rows: yield* Effect.forEach(rows, (row) =>
      Effect.map(
        signInMethodsOf((row.providers ?? "").split(",")),
        (methods): StoredAccount => ({
          id: row.id,
          email: row.email,
          name: row.name,
          role: row.isAdmin ? "admin" : "member",
          banReason: row.banned ? row.banReason : null,
          emailVerified: row.emailVerified === 1,
          status: row.banned
            ? "suspended"
            : row.emailVerified
              ? "active"
              : "unverified",
          methods,
          createdAt: row.createdAt,
          lastActiveAt: row.lastActiveAt,
          sessions: Number(row.sessions),
        })
      )
    ),
  }
})

export class Accounts extends Context.Service<
  Accounts,
  {
    readonly list: (
      query: AccountSearch,
      adminList: AdminList
    ) => Effect.Effect<AccountPage<StoredAccount>, UnknownError>
    readonly makeAdmin: (userId: string) => Effect.Effect<void, UnknownError>
    readonly verifyEmail: (userId: string) => Effect.Effect<void, UnknownError>
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
        const update = (
          userId: string,
          fields: Partial<Pick<Tables["user"], "role" | "emailVerified">>
        ) =>
          Effect.tryPromise(() =>
            db
              .updateTable("user")
              .set({ ...fields, updatedAt: new Date().toISOString() })
              .where("id", "=", userId)
              .execute()
          ).pipe(Effect.asVoid)
        return Accounts.of({
          list: (query, adminList) => listAccounts(db, query, adminList),
          makeAdmin: (userId) => update(userId, { role: "admin" }),
          verifyEmail: (userId) => update(userId, { emailVerified: 1 }),
        })
      })
    )
}
