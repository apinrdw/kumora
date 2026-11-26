# React-free code skips rules-of-hooks

The rules-of-hooks lint reads an Effect accessor such as `Clock.use((now) => now)` as React's `use` hook and fails it; agents hit this in three sessions. Code that never renders React skips the rule, listed folder by folder. A new React-free folder joins the list; until then the rule still runs there.

Sites:
- `vite.config.ts`

Source: none
