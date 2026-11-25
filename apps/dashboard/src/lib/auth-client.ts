import { DashboardBasePath } from "@workspace/client"
import { adminClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

import { ac, roles } from "@/server/auth/access"

// Same origin: Better Auth is mounted at /api/auth on this Worker, under the
// dashboard base path.
export const authClient = createAuthClient({
  basePath: `${DashboardBasePath}/api/auth`,
  plugins: [adminClient({ ac, roles })],
})
