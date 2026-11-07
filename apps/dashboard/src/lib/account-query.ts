// What /admin/users asks for and gets back. Shared by the page and the
// server, so it holds no server code.
import { Option, Schema } from "effect"

import type { SignInMethod } from "@/lib/sign-in-method"
import type { Role, TargetAction } from "@/server/auth/policy"

export const ROLES = ["admin", "member"] as const satisfies ReadonlyArray<Role>

export const STATUSES = ["active", "unverified", "suspended"] as const
export type Status = (typeof STATUSES)[number]

export const SORT_KEYS = ["createdAt", "lastActiveAt"] as const

const DIRECTIONS = ["asc", "desc"] as const

export const PAGE_SIZE = 50

const fields = {
  q: Schema.String,
  role: Schema.Literals(ROLES),
  status: Schema.Literals(STATUSES),
  sort: Schema.Literals(SORT_KEYS),
  dir: Schema.Literals(DIRECTIONS),
  page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
}

/** The page's search params; every one is optional. */
export const AccountSearch = Schema.Struct({
  q: Schema.optionalKey(fields.q),
  role: Schema.optionalKey(fields.role),
  status: Schema.optionalKey(fields.status),
  sort: Schema.optionalKey(fields.sort),
  dir: Schema.optionalKey(fields.dir),
  page: Schema.optionalKey(fields.page),
})
export type AccountSearch = typeof AccountSearch.Type

/** Keeps each search param that parses and drops the rest, so a stale link still opens the page. */
export function parseAccountSearch(
  raw: Record<string, unknown>
): AccountSearch {
  const search: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(fields)) {
    const value = Schema.decodeUnknownOption(field)(raw[key])
    if (Option.isSome(value)) search[key] = value.value
  }
  return Schema.decodeUnknownSync(AccountSearch)(search)
}

/** An account as the database holds it. */
export interface StoredAccount {
  readonly id: string
  readonly email: string
  readonly name: string
  readonly role: Role
  readonly status: Status
  readonly emailVerified: boolean
  /** Why an admin banned it; admins only, never shown to the account. */
  readonly banReason: string | null
  readonly methods: ReadonlyArray<SignInMethod>
  /** ISO timestamp. */
  readonly createdAt: string
  /** When a session of the account was last used; null with no session left. */
  readonly lastActiveAt: string | null
  /** Sessions that haven't expired. */
  readonly sessions: number
}

export interface AccountRow extends StoredAccount {
  /** What the access policy lets the viewing admin do to this account. */
  readonly allowed: Readonly<Record<TargetAction, boolean>>
}

export interface AccountPage<Row = AccountRow> {
  readonly rows: ReadonlyArray<Row>
  readonly total: number
}
