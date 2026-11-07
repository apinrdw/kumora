export interface GoogleClient {
  readonly clientId: string
  readonly clientSecret: string
}

/** The Google OAuth client the stage bound, if Google is on for it (alchemy.run.ts). */
export function googleClient(env: {
  readonly GOOGLE_CLIENT_ID?: string
  readonly GOOGLE_CLIENT_SECRET?: string
}): GoogleClient | undefined {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = env
  if (clientId === undefined || clientSecret === undefined) return undefined
  return { clientId, clientSecret }
}
