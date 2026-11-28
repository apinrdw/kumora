import {
  IconCommand,
  IconLogout,
  IconSearch,
  IconUser,
} from "@tabler/icons-react"
import type { Icon } from "@tabler/icons-react"
import { useLocation, useRouter } from "@tanstack/react-router"
import type { NavigateOptions } from "@tanstack/react-router"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandList,
  type CommandData,
} from "@ui-sdk/react/command"
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogShortcut,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/react/dialog"
import { clientRuntime } from "@workspace/client"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"
import { useState } from "react"

import { kFocus } from "@/components/k/styles"
import { useStockListOnDemand } from "@/components/stocks/use-stock-list"
import { NAV, visibleNav } from "@/lib/nav"
import type { Viewer } from "@/server/auth/gate"

import { signOut } from "./user-menu"

type Entry = {
  readonly icon?: Icon
  readonly code?: string
  readonly to?: NavigateOptions
}

// The Shell's command palette: the viewer's pages, account actions and, once
// something is typed, the stocks, loaded on the first open. Ctrl/⌘+K opens it
// everywhere but Market Live, whose own Go to code palette keeps that key.
export function CommandPalette({ viewer }: { viewer: Viewer }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const location = useLocation()
  const [list, load] = useStockListOnDemand()

  const entries = new Map<string, Entry>()
  const pages: CommandData = Effect.runSync(
    visibleNav(NAV, viewer.features)
  ).map((group) => ({
    type: "group",
    label: group.label,
    items: group.items.map((item) => {
      const value = `page:${item.label}`
      entries.set(value, { icon: item.icon, to: item.link })
      return { value, label: item.label, keywords: [item.shortLabel] }
    }),
  }))

  entries.set("account", { icon: IconUser, to: { to: "/account" } })
  entries.set("sign-out", { icon: IconLogout })
  const account: CommandData = [
    {
      type: "group",
      label: "Account",
      items: [
        ...(viewer.features.includes("account")
          ? [{ value: "account", label: "Account", keywords: ["profile"] }]
          : []),
        { value: "sign-out", label: "Sign out", keywords: ["log out"] },
      ],
    },
  ]

  const stocks: CommandData =
    viewer.features.includes("stocks") && list._tag === "Ready"
      ? [
          {
            type: "group",
            label: "Stocks",
            items: list.codes.map(({ code, name }) => {
              const value = `stock:${code}`
              entries.set(value, {
                code,
                to: { to: "/stocks/$code", params: { code } },
              })
              return { value, label: `${code} ${name}`.trim() }
            }),
          },
        ]
      : []

  const suggested = [...pages, ...account]

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next && viewer.features.includes("stocks")) load(location.href)
      }}
    >
      <DialogTrigger
        shortcut={location.pathname === "/market-live" ? undefined : "mod+k"}
        className={cn(
          "text-secondary-text hover:bg-elevated inline-flex h-8 shrink-0 items-center gap-2 rounded-sm border border-border px-2 text-xs font-medium hover:text-foreground",
          kFocus
        )}
      >
        <IconCommand aria-hidden stroke={1.75} className="size-4" />
        <span className="max-md:sr-only">Commands</span>
        <DialogShortcut className="num hidden text-[11px] text-muted-foreground lg:inline" />
      </DialogTrigger>
      <DialogBackdrop />
      <DialogContent className="top-20 bottom-auto w-[min(36rem,calc(100%-2rem))] gap-0 p-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command
          items={[...suggested, ...stocks]}
          emptyItems={suggested}
          className="w-full max-w-none border-0"
          onAction={(value) => {
            const to = entries.get(value)?.to
            if (to) {
              setOpen(false)
              return router.navigate(to)
            }
            return clientRuntime.runPromise(
              signOut(location.href, (href) => router.navigate({ href }))
            )
          }}
        >
          <div>
            <IconSearch aria-hidden stroke={1.75} />
            <CommandInput
              aria-label="Search commands"
              placeholder={
                viewer.features.includes("stocks")
                  ? "Search pages, stocks and actions…"
                  : "Search pages and actions…"
              }
            />
          </div>
          <CommandEmpty className="px-3 py-6 text-center text-muted-foreground">
            No commands found.
          </CommandEmpty>
          <CommandList className="max-h-[min(24rem,60dvh)]">
            {(state) => <Commands items={state.items} entries={entries} />}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function Commands({
  items,
  entries,
}: {
  items: CommandData
  entries: ReadonlyMap<string, Entry>
}) {
  return items.map((item) => {
    if (typeof item === "string") return null
    if ("type" in item) {
      if (item.type !== "group") return null
      return (
        <CommandGroup key={item.label}>
          <CommandGroupLabel>{item.label}</CommandGroupLabel>
          <Commands items={item.items} entries={entries} />
        </CommandGroup>
      )
    }
    const entry = entries.get(item.value)
    const Glyph = entry?.icon
    return (
      <CommandItem
        key={item.value}
        value={item.value}
        label={item.label}
        keywords={item.keywords}
        className="text-secondary-text data-highlighted:text-foreground data-highlighted:outline-1 data-highlighted:-outline-offset-1 data-highlighted:outline-primary"
      >
        {Glyph && (
          <CommandItemIcon>
            <Glyph aria-hidden stroke={1.75} />
          </CommandItemIcon>
        )}
        {entry?.code ? (
          <>
            <b className="num font-semibold text-foreground">{entry.code}</b>
            <span className="truncate">
              {item.label.slice(entry.code.length).trim()}
            </span>
          </>
        ) : (
          item.label
        )}
      </CommandItem>
    )
  })
}
