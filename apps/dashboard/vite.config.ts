import { cloudflare } from "@cloudflare/vite-plugin"
import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

/**
 * A whole calendar for the relay, which only scripts/drive-extension.mts sets (ADR 0003):
 * see `calendarFrom`. The Worker reads it under this name, typed in src/relay-env.d.ts;
 * .github/workflows/extension-driver.yml sets it for its build.
 */
const relayCalendar = process.env.RELAY_CALENDAR

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // Crawl every route up front: deps reached only from lazily loaded routes are
  // otherwise discovered mid-session in dev, which force-reloads the page.
  optimizeDeps: { entries: ["src/routes/**/*.tsx"] },
  plugins: [
    // The OS picks the port. The default probes 9229 and binds it later, so apps
    // started together race for it and one dies with EADDRINUSE.
    cloudflare({
      viteEnvironment: { name: "ssr" },
      inspectorPort: 0,
      // A var, not a .dev.vars line: with `secrets.required` set, local dev drops undeclared keys.
      ...(relayCalendar
        ? { config: { vars: { RELAY_CALENDAR: relayCalendar } } }
        : {}),
    }),
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
