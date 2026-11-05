import type { LinkProps } from "@tanstack/react-router"

export type Crumb = { label: string; link?: LinkProps }

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** Header breadcrumb for the deepest matched route; receives that route's params. */
    crumbs?: (params: Record<string, string>) => ReadonlyArray<Crumb>
  }
}
