import { adminClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

import { ac, roles } from "@/server/auth/access"

// Same origin: Better Auth is mounted at /api/auth on this Worker.
export const authClient = createAuthClient({
  plugins: [adminClient({ ac, roles })],
})
