// How long Cloudflare keeps an archive run's Workflow instance, ended well or
// not, and so how long the admin page shows the run. Free of server imports,
// so the admin page's components can word their copy from it.
export const RETENTION_DAYS = 30

const PERIOD = `${RETENTION_DAYS} days` as const

export const RETENTION = {
  successRetention: PERIOD,
  errorRetention: PERIOD,
} as const

export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000
