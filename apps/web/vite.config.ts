import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart({
      prerender: {
        // SCRATCH: TanStack prerender runs the SSR bundle outside workerd under Alchemy (#20).
        enabled: false,
        crawlLinks: true,
        filter: (page) => !page.path.startsWith("/probe"),
      },
    }),
    viteReact(),
  ],
})

export default config
