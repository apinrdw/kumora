import type { StageKind } from "@workspace/deploy"

// Decision: Google sign-in is enabled by stage, on Production and Staging,
// never by whether its client secret is present. Previews and Dev stages read
// Infisical `staging`, which holds the Google client too, and their URLs are
// not redirect URIs of the OAuth client. alchemy.run.ts binds the client only
// where this says so, so a missing secret on Production or Staging fails the
// deploy instead of hiding the button. See apinrdw/kumora#89.
export const googleSignInOn = (kind: StageKind) =>
  kind === "production" || kind === "staging"

export interface GoogleClient {
  readonly clientId: string
  readonly clientSecret: string
}

/** The Google OAuth client the stage bound, if Google is on for it. */
export function googleClient(env: {
  readonly GOOGLE_CLIENT_ID?: string
  readonly GOOGLE_CLIENT_SECRET?: string
}): GoogleClient | undefined {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = env
  if (clientId === undefined || clientSecret === undefined) return undefined
  return { clientId, clientSecret }
}
