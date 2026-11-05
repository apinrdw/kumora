// Vitest's stand-in for TanStack Start's handler: what the Worker falls through to.
export const FELL_THROUGH = "fell through to Start"

export default {
  fetch: () => new Response(FELL_THROUGH, { status: 418 }),
}
