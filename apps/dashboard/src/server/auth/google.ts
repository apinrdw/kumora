import { Effect } from "effect"

export interface GoogleClient {
  readonly clientId: string
  readonly clientSecret: string
}

/** The Google OAuth client the stage bound, if Google is on for it (alchemy.run.ts). */
export const googleClient = ({
  GOOGLE_CLIENT_ID: clientId,
  GOOGLE_CLIENT_SECRET: clientSecret,
}: {
  readonly GOOGLE_CLIENT_ID?: string
  readonly GOOGLE_CLIENT_SECRET?: string
}): Effect.Effect<GoogleClient | undefined> =>
  Effect.succeed(
    clientId === undefined || clientSecret === undefined
      ? undefined
      : { clientId, clientSecret }
  )
