import {
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
} from "@tabler/icons-react"
import { useHydrated } from "@tanstack/react-router"
import { Schema } from "effect"
import { useEffect, useState } from "react"

import {
  OutcomeLine,
  useAccountAction,
} from "@/components/account/account-section"

import {
  KBadge,
  KButton,
  KDataTable,
  KInput,
  KSelect,
  type KBadgeTone,
  type KColumn,
} from "@/components/k"
import {
  PAGE_SIZE,
  ROLES,
  SORT_KEYS,
  STATUSES,
  type AccountPage,
  type AccountRow,
  type AccountSearch,
  type SignInMethod,
  type Status,
} from "@/lib/account-query"
import { dateTime } from "@/lib/format"
import type { Role } from "@/server/auth/policy"

import { AccountActions, ConfirmAction, type Asked } from "./account-actions"

const STATUS: Record<Status, { label: string; tone: KBadgeTone }> = {
  active: { label: "Active", tone: "up" },
  unverified: { label: "Unverified", tone: "warning" },
  suspended: { label: "Suspended", tone: "down" },
}

const ROLE: Record<Role, string> = { admin: "Admin", member: "Member" }

const METHOD: Record<SignInMethod, string> = {
  password: "Password",
  google: "Google",
}

const ALL = "all"

const COLUMNS: ReadonlyArray<KColumn<AccountRow>> = [
  { key: "email", label: "Email" },
  { key: "name", label: "Name" },
  {
    key: "role",
    label: "Role",
    cell: (row) => ROLE[row.role],
  },
  {
    key: "status",
    label: "Status",
    cell: (row) => (
      <span className="flex flex-col items-start gap-0.5">
        <KBadge tone={STATUS[row.status].tone} icon={false}>
          {STATUS[row.status].label}
        </KBadge>
        {row.banReason && (
          <span className="max-w-48 truncate text-xs text-muted-foreground">
            {row.banReason}
          </span>
        )}
      </span>
    ),
  },
  {
    key: "methods",
    label: "Sign-in methods",
    cell: (row) =>
      row.methods.length === 0
        ? "—"
        : row.methods.map((method) => METHOD[method]).join(", "),
  },
  {
    key: "createdAt",
    label: "Created",
    sortable: true,
    cell: (row) => dateTime(row.createdAt),
  },
  {
    key: "lastActiveAt",
    label: "Last active",
    sortable: true,
    cell: (row) => (row.lastActiveAt ? dateTime(row.lastActiveAt) : "—"),
  },
  { key: "sessions", label: "Sessions", align: "right" },
]

const isSortKey = Schema.is(Schema.Literals(SORT_KEYS))

type OnSearch = (change: Partial<AccountSearch>) => void

/** The /admin/users table with its search, filters and pages; every control lives in the URL. */
export function AccountsTable({
  page,
  search,
  onSearch,
}: {
  page: AccountPage
  search: AccountSearch
  /** Applies a change to the search params; any change but paging returns to page 1. */
  onSearch: OnSearch
}) {
  const [asked, setAsked] = useState<Asked | null>(null)
  const { pending, outcome, run } = useAccountAction()
  const columns: ReadonlyArray<KColumn<AccountRow>> = [
    ...COLUMNS,
    {
      key: "allowed",
      label: "Actions",
      align: "right",
      cell: (row) => <AccountActions row={row} onAsk={setAsked} run={run} />,
    },
  ]
  return (
    <div className="flex flex-col gap-4">
      <Filters search={search} onSearch={onSearch} />
      <OutcomeLine outcome={outcome} />
      <KDataTable
        label="Accounts"
        columns={columns}
        rows={page.rows}
        getRowId={(row) => row.id}
        sort={{ key: search.sort ?? "createdAt", dir: search.dir ?? "desc" }}
        onSort={(next) => {
          if (isSortKey(next.key)) onSearch({ sort: next.key, dir: next.dir })
        }}
      />
      <Pager
        current={search.page ?? 1}
        total={page.total}
        onPage={(to) => onSearch({ page: to })}
      />
      <ConfirmAction
        asked={asked}
        onClose={() => setAsked(null)}
        run={run}
        pending={pending}
      />
    </div>
  )
}

function Filters({
  search,
  onSearch,
}: {
  search: AccountSearch
  onSearch: OnSearch
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <SearchInput
        value={search.q ?? ""}
        onChange={(q) => onSearch({ q: q === "" ? undefined : q })}
      />
      <KSelect
        label="Role"
        options={[
          { value: ALL, label: "All roles" },
          ...ROLES.map((role) => ({ value: role, label: ROLE[role] })),
        ]}
        value={search.role ?? ALL}
        onValueChange={(role) =>
          onSearch({ role: role === ALL ? undefined : role })
        }
        className="w-40"
      />
      <KSelect
        label="Status"
        options={[
          { value: ALL, label: "All statuses" },
          ...STATUSES.map((status) => ({
            value: status,
            label: STATUS[status].label,
          })),
        ]}
        value={search.status ?? ALL}
        onValueChange={(status) =>
          onSearch({ status: status === ALL ? undefined : status })
        }
        className="w-40"
      />
    </div>
  )
}

function Pager({
  current,
  total,
  onPage,
}: {
  current: number
  total: number
  onPage: (page: number) => void
}) {
  const first = (current - 1) * PAGE_SIZE + 1
  const last = Math.min(current * PAGE_SIZE, total)
  return (
    <div className="flex items-center justify-end gap-3 text-[13px] text-muted-foreground">
      <span className="num">
        {total === 0 ? "No accounts" : `${first}–${last} of ${total}`}
      </span>
      <KButton
        variant="secondary"
        size="sm"
        icon={IconChevronLeft}
        disabled={current <= 1}
        onClick={() => onPage(current - 1)}
      >
        Previous
      </KButton>
      <KButton
        variant="secondary"
        size="sm"
        icon={IconChevronRight}
        disabled={last >= total}
        onClick={() => onPage(current + 1)}
      >
        Next
      </KButton>
    </div>
  )
}

/**
 * Searches once typing pauses. It starts from the URL and then owns its text,
 * so a slow page load never undoes what is typed. Disabled until hydrated,
 * as typing before then would be lost.
 */
function SearchInput({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const hydrated = useHydrated()
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    if (draft.trim() === value) return
    const timer = setTimeout(() => onChange(draft.trim()), 300)
    return () => clearTimeout(timer)
  }, [draft, value, onChange])
  return (
    <KInput
      label="Search"
      icon={IconSearch}
      type="search"
      placeholder="Email or name"
      value={draft}
      disabled={!hydrated}
      onChange={(event) => setDraft(event.target.value)}
      className="w-72 max-w-full"
    />
  )
}
