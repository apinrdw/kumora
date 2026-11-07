// A way an account proves who it is (GLOSSARY.md, "Sign-in method"). Shared by
// the server, which reads Better Auth's provider ids, and the pages.
export type SignInMethod = "password" | "google"

// Better Auth's provider ids; any other provider isn't a sign-in method here.
const BY_PROVIDER: Readonly<Partial<Record<string, SignInMethod>>> = {
  credential: "password",
  google: "google",
}

/** The sign-in methods of an account's Better Auth provider ids, sorted, once each. */
export const signInMethodsOf = (
  providerIds: Iterable<string>
): ReadonlyArray<SignInMethod> =>
  [
    ...new Set(
      [...providerIds].flatMap((id) =>
        Object.hasOwn(BY_PROVIDER, id) ? [BY_PROVIDER[id]!] : []
      )
    ),
  ].sort()

export const SIGN_IN_METHOD_LABEL = {
  password: "Password",
  google: "Google",
} as const satisfies Record<SignInMethod, string>
