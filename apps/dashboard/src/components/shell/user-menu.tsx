import { IconChevronDown, IconLogout, IconUser } from "@tabler/icons-react"
import { Link, useLocation, useRouter } from "@tanstack/react-router"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { cn } from "@workspace/ui/lib/utils"
import { Effect } from "effect"

import { authClient } from "@/lib/auth-client"
import { withRedirect } from "@/lib/redirect"
import type { Viewer } from "@/server/auth/gate"

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("")

/**
 * The account's menu. `rail` is the sidebar block (full at ≥1280, avatar only
 * on the icon rail); `avatar` is the header button below 768px.
 */
export function UserMenu({
  viewer,
  variant,
}: {
  viewer: Viewer
  variant: "rail" | "avatar"
}) {
  const router = useRouter()
  const href = useLocation({ select: (location) => location.href })
  const signOut = async () => {
    await authClient.signOut()
    await router.navigate({
      href: Effect.runSync(withRedirect("/sign-in", href)),
    })
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu for ${viewer.name}`}
        className={cn(
          "hover:bg-elevated flex items-center gap-2.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-primary",
          variant === "rail" && "w-full justify-center p-3 xl:justify-start",
          variant === "avatar" && "p-0.5"
        )}
      >
        <span
          aria-hidden
          className="num bg-elevated grid size-8 shrink-0 place-items-center rounded-full border border-border text-xs font-semibold"
        >
          {initials(viewer.name)}
        </span>
        {variant === "rail" && (
          <>
            <span className="hidden min-w-0 flex-1 flex-col leading-[1.2] xl:flex">
              <b className="truncate text-[13px] font-semibold text-foreground">
                {viewer.name}
              </b>
              <span className="truncate text-[11px] text-muted-foreground">
                {viewer.email}
              </span>
            </span>
            <IconChevronDown className="hidden size-4 text-muted-foreground xl:block" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={variant === "rail" ? "top" : "bottom"}
        align={variant === "rail" ? "start" : "end"}
        className="min-w-56"
      >
        <div className="flex flex-col px-1.5 py-1 leading-[1.3]">
          <b className="truncate text-[13px] font-semibold">{viewer.name}</b>
          <span className="truncate text-xs text-muted-foreground">
            {viewer.email}
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to="/account" />}>
          <IconUser aria-hidden />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void signOut()}>
          <IconLogout aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
