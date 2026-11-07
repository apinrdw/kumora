// Shared by the Mailer and apps/dashboard/alchemy.run.ts, which onboards the
// subdomain on Production and allows only this sender on the EMAIL binding.
export const SENDING_SUBDOMAIN = "mailer.pusat.ai"
export const SENDER = `no-reply@${SENDING_SUBDOMAIN}`
