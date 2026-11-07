import { createAuthClient } from "better-auth/react"

// Same origin: Better Auth is mounted at /api/auth on this Worker.
export const authClient = createAuthClient()
