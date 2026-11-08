// The tests typecheck without @cloudflare/workers-types (tests/tsconfig.json),
// so the two `cloudflare:` modules the server code imports lazily are declared
// here, with the members it uses. In a test they never load: the seam and the
// fakes provide WorkerEnv, WaitUntil and the Mailer.
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>
  export function waitUntil(promise: Promise<unknown>): void
}

declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: ReadableStream | string)
  }
}
