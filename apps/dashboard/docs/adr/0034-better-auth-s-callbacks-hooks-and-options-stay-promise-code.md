# Better Auth's callbacks, hooks and options stay Promise code

Better Auth calls its callbacks and hooks with fixed Promise signatures and takes its options object as is, so these entry points stay plain Promise code, not Effects. The callback runner is a plain function returning a Promise; each hook runs its Effect with a bare `runPromise` and no services, which rejects with the `APIError` or a dying call's error unchanged, as Better Auth expects of a throw; and `authOptions` stays a plain function, taken as is by Better Auth, the test seam and the migration script. CODING_STANDARDS.md lists such config builders among the exceptions.

The hooks don't use `makeCallbackRunner` from `callbacks.ts`: it needs `@workspace/server`, which the migration script can't load.

Sites:
- `apps/dashboard/src/server/auth/callbacks.ts`
- `apps/dashboard/src/server/auth/options.ts`

Source: apinrdw/kumora#159
