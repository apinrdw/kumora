import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router"
import { Toaster } from "@workspace/ui/components/sonner"
import { TooltipProvider } from "@workspace/ui/components/tooltip"

import { NotFound } from "@/components/not-found"
import appCss from "@/styles.css?url"
import "@/lib/crumbs"
import "@/lib/page-feature"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#0b1421" },
      { title: "KUMORA Terminal" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.json" },
    ],
  }),
  notFoundComponent: NotFound,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="id" className="dark" data-theme="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {/* The shell wraps only the gated pages (routes/_app.tsx); the
            sign-in pages stand alone. */}
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster position="bottom-right" />
        <Scripts />
      </body>
    </html>
  )
}
