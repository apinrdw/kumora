// PROTOTYPE (wayfinder #382), throwaway: builds the prototype page alone.
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const dashboard = path.resolve(import.meta.dirname, "..")

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  resolve: {
    alias: [{ find: /^@\/(.*)$/, replacement: `${dashboard}/src/$1` }],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
  plugins: [tailwindcss(), viteReact()],
})
