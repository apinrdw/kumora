import type { WebEnv } from "../../alchemy.run.ts"

declare module "@workspace/server" {
  interface Register {
    readonly env: WebEnv
  }
}
