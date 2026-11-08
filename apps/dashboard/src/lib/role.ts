import type { Role } from "@/server/auth/policy"

/** What /account and /admin/users call each role. */
export const ROLE_LABEL = {
  admin: "Admin",
  member: "Member",
} as const satisfies Record<Role, string>
