import { cloudflare } from "@cloudflare/vite-plugin"
import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    // The OS picks the port. The default probes 9229 and binds it later, so apps
    // started together race for it and one dies with EADDRINUSE.
    cloudflare({ viteEnvironment: { name: "ssr" }, inspectorPort: 0 }),
    devtools(),
    tailwindcss(),
    tanstackStart({
      prerender: {
        enabled: true,
        crawlLinks: true,
        // The probe reads a runtime secret, so it must never be prerendered.
        filter: (page) => !page.path.startsWith("/probe"),
      },
    }),
    viteReact(),
  ],
})

export default config
