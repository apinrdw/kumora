// The admin plugin's own access control, which guards its endpoints. Every
// access decision of ours goes through the policy (policy.ts); the role is one
// attribute it reads. Imported by options.ts, so packages and relative files only.
import { createAccessControl } from "better-auth/plugins/access"
import { defaultStatements } from "better-auth/plugins/admin/access"

import type { Role } from "./policy.ts"

export const ac = createAccessControl(defaultStatements)

// Admins never create, edit or delete accounts.
export const roles = {
  admin: ac.newRole({
    user: ["list", "get", "set-role", "ban", "impersonate"],
    session: ["list", "revoke"],
  }),
  member: ac.newRole({ user: [], session: [] }),
} satisfies Record<Role, unknown>
