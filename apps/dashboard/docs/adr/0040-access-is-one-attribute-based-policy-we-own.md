# Access is one attribute-based policy we own

Better Auth's access control is role-based and fixed in code. Access is instead decided by one attribute-based policy we own, deny by default, with Better Auth's admin and member roles kept underneath as one attribute. Every gate asks `decide` and maps the reason to its own response, so giving an account access to a feature adds an attribute and a rule, not gate edits.

Sites:
- `apps/dashboard/src/server/auth/policy.ts`

Source: apinrdw/kumora#95
