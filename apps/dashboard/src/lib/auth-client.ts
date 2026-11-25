import { DashboardBasePath } from "@workspace/client/base-path"
import { adminClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

import { AUTH_PATH } from "@/lib/auth-path"
import { ac, roles } from "@/server/auth/access"

// Same origin: Better Auth is mounted at AUTH_PATH on this Worker, under the
// dashboard base path.
export const authClient = createAuthClient({
  basePath: `${DashboardBasePath}${AUTH_PATH}`,
  plugins: [adminClient({ ac, roles })],
})
