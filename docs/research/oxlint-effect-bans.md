# Which Effect-migration bans oxlint 1.90 can express

Research for [#101](https://github.com/apinrdw/kumora/issues/101), a child of the map [#98](https://github.com/apinrdw/kumora/issues/98). Researched on 2026-11-07 against the installed `oxlint` 1.90.0.

## Answer

Oxlint 1.90 can express all five bans, and each can be scoped to a directory with `overrides`. Built-in rules cover four of them: imports, `process.exit`, `new Promise` and `async`. A `throw` ban needs a JS plugin. Oxlint has no `no-restricted-syntax`.

| Ban | Built-in rule | Message names the fix? | Gaps found by testing |
| --- | --- | --- | --- |
| `node:fs`, `node:child_process` imports | `no-restricted-imports` (`paths` + `patterns.regex`) | Yes, as `help:` | none |
| `process.exit` | `no-restricted-properties` (`object: "process"`, `property: "exit"`) | Yes, as `help:` | `globalThis.process.exit` is not caught |
| `new Promise` | `no-restricted-globals` (`Promise`) | Yes, in the main message | Also flags `Promise.resolve`. Type positions (`Promise<T>`) are not flagged. |
| `async` functions | `oxc/no-async-await` | **No.** The text is fixed: "async is not allowed". | none (declarations, arrows and methods are all caught) |
| React `useState`/`useEffect`/`useMemo` | `no-restricted-imports` (`importNames`) + `no-restricted-properties` (`object: "React"`) | Yes, as `help:` | It rejects every `import * as React`. A default import (`R.useMemo`) gets through. |
| `throw` | **none** | n/a | A JS plugin is needed |

A local JS plugin rule of about 15 lines works like ESLint's `no-restricted-syntax` and covers all six bans with esquery selectors and custom messages. It works inside `overrides`. JS plugins are **alpha and not subject to semver** in 1.90.

## Sources

- `node_modules/oxlint/configuration_schema.json` (1.90.0): the `jsPlugins` key and its per-override form, plus the option shapes `RestrictedPath`, `RestrictedPattern`, `RestrictedGlobal` and `NoRestrictedGlobalsObjectConfig`.
- `oxlint --rules --format=json` (1.90.0) lists 872 rules. Bare `--rules` printed nothing in this environment.
- [oxc.rs: JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html): "JS plugins are currently in alpha, and remain under active development". Selectors, fixes, scope analysis and code paths are supported, and the API is compatible with ESLint v9+.
- [oxc.rs: Configuration](https://oxc.rs/docs/guide/usage/linter/config.html): `overrides` accept `files`, `rules`, `plugins` and `jsPlugins` (alpha).
- [oxc-project/oxc#479](https://github.com/oxc-project/oxc/issues/479), the ESLint rule-parity tracker, lists `eslint/no-restricted-syntax` under "Not recommended rules" as unimplemented TODO.
- The repo root `.oxlintrc.json`.

## How the repo writes bans today

The root `.oxlintrc.json` has one `no-restricted-imports` entry. It bans `cloudflare:workers`, `zod` and the v3 `@effect/*` packages by `paths`, and `repos/` plus v3 subpaths by `patterns.group`. Each entry carries a `message` that names the replacement. One override for `packages/server/src/bridge.ts` restates the entire option list minus `cloudflare:workers`.

That restated list is required, not a style choice. **An override's rule options replace the base options; they do not merge.** In the test below, the base config bans `zod` and an override for `src/effect/**` bans `node:fs`. Only `node:fs` is reported in `src/effect/zod.ts`:

```
$ pnpm exec oxlint --disable-nested-config -c merge.json src/effect/zod.ts src/legacy/allowed.ts
src/effect/zod.ts:2:1: error eslint(no-restricted-imports): 'node:fs' import is restricted from being used. help: Use the FileSystem service.
1 problem
```

Each directory-scoped `no-restricted-imports` override must therefore repeat the root list (`zod`, `cloudflare:workers`, v3 Effect, `repos/`). If it does not, those bans are lost in that directory. The same holds for `no-restricted-properties` and `no-restricted-globals` when they have both a base value and an override value.

## Experiment

The fixtures and configs are in a scratch directory and are not committed. There are three fixture directories: `src/effect/` (all bans apply), `src/ui/` (React bans apply) and `src/legacy/` (no overrides; it contains `throw`, `process.exit`, `new Promise`, `async` and a `node:fs` import). Commands ran from the worktree root with `pnpm exec oxlint --disable-nested-config -c <config> <fixtures>`. Paths in the output below are shortened to `src/...`.

`src/legacy/allowed.ts` produced no diagnostics in either run, so `overrides` scoping works for both built-in rules and JS plugins.

### Run 1: built-in rules (`builtin.json`)

Rules in the `src/effect/**` override:

```jsonc
"no-restricted-imports": ["error", {
  "paths": [
    {"name": "node:fs", "message": "Use the FileSystem service from effect (provided by NodeFileSystem.layer)."},
    {"name": "node:child_process", "message": "Use the ChildProcess service from effect (provided by the platform-node layer)."}
  ],
  "patterns": [{"regex": "^(node:)?(fs|child_process)(/.*)?$", "message": "Use the Effect FileSystem / ChildProcess services instead of Node built-ins."}]
}],
"no-restricted-properties": ["error", {"object": "process", "property": "exit", "message": "Return a failing Effect and let NodeRuntime.runMain set the exit code."}],
"no-restricted-globals": ["error", {"name": "Promise", "message": "Use Effect.callback / Effect.promise instead of building a Promise."}],
"unicorn/no-process-exit": "error",
"oxc/no-async-await": "error"
```

Rules in the `src/ui/**` override:

```jsonc
"no-restricted-imports": ["error", {"paths": [{"name": "react", "importNames": ["useState", "useEffect", "useMemo"], "message": "Read state through an @effect/atom-react atom (useAtomValue / useAtom)."}]}],
"no-restricted-properties": ["error",
  {"object": "React", "property": "useState", "message": "Read state through an @effect/atom-react atom (useAtom)."},
  {"object": "React", "property": "useEffect", "message": "Run effects in an atom, not useEffect."},
  {"object": "React", "property": "useMemo", "message": "Derive values with Atom.map, not useMemo."}]
```

Output. The `message` text comes from `--format=unix`, and the `help` text comes from `--format=json`. The default and `agent` formats print both on one line as `... help: <text>`.

```
src/effect/bans.ts:1:1   no-restricted-imports    'node:fs' import is restricted from being used.             help: Use the FileSystem service from effect (provided by NodeFileSystem.layer).
src/effect/bans.ts:1:1   no-restricted-imports    'node:fs' import is restricted from being used by a pattern. help: Use the Effect FileSystem / ChildProcess services instead of Node built-ins.
src/effect/bans.ts:2:1   no-restricted-imports    'node:child_process' import is restricted from being used.  help: Use the ChildProcess service from effect (provided by the platform-node layer).
src/effect/bans.ts:2:1   no-restricted-imports    'node:child_process' import is restricted from being used by a pattern.
src/effect/bans.ts:3:1   no-restricted-imports    'fs' import is restricted from being used by a pattern.     help: Use the Effect FileSystem / ChildProcess services instead of Node built-ins.
src/effect/bans.ts:14:31 no-restricted-globals    Unexpected use of 'Promise'. Use Effect.callback / Effect.promise instead of building a Promise.  help: Use a local variable or function parameter instead of the restricted global.
src/effect/bans.ts:16:31 no-restricted-globals    Unexpected use of 'Promise'. Use Effect.callback / Effect.promise instead of building a Promise.
src/effect/bans.ts:11:27 unicorn(no-process-exit) Don't use `process.exit()`                                  help: Throw an error instead.
src/effect/bans.ts:11:27 no-restricted-properties 'process.exit' is restricted from being used.               help: Return a failing Effect and let NodeRuntime.runMain set the exit code.
src/effect/bans.ts:18:8  oxc(no-async-await)      async is not allowed                                        help: Remove the `async` keyword
src/effect/bans.ts:21:26 oxc(no-async-await)      async is not allowed
src/effect/bans.ts:23:3  oxc(no-async-await)      async is not allowed
src/ui/hooks.tsx:1:10    no-restricted-imports    'useState' import from 'react' is restricted.               help: Read state through an @effect/atom-react atom (useAtomValue / useAtom).
src/ui/hooks.tsx:1:20    no-restricted-imports    'useEffect' import from 'react' is restricted.
src/ui/hooks.tsx:1:31    no-restricted-imports    'useMemo' import from 'react' is restricted.
src/ui/hooks.tsx:2:1     no-restricted-imports    * import is invalid because 'useState, useEffect, useMemo' from 'react' is restricted.
src/ui/hooks.tsx:14:15   no-restricted-properties 'React.useState' is restricted from being used.             help: Read state through an @effect/atom-react atom (useAtom).
src/ui/hooks.tsx:15:3    no-restricted-properties 'React.useEffect' is restricted from being used.            help: Run effects in an atom, not useEffect.
18 problems
```

Fixture lines that were **not** reported:

- `bans.ts:8`: `throw new Error("boom")`. No built-in rule bans a `throw` statement. `no-throw-literal`, `typescript/only-throw-error` and `unicorn/throw-new-error` only check what is thrown.
- `bans.ts:12`: `globalThis.process.exit(1)`.
- `bans.ts:15`: `(p: Promise<number>): Promise<number>`. Type references are not global value uses, so typed signatures stay legal.
- `hooks.tsx:16`: `React2.useMemo(...)` where `import React2 from "react"`. `no-restricted-properties` matches the object by identifier name (`React`), not by import source.

### Run 2: JS plugin (`plugin.json`)

`kumora-plugin.mjs` reads `[{ selector, message }]` options and reports each match:

```js
const restrictedSyntax = {
  meta: { type: "problem", schema: false },
  create(context) {
    const visitors = {};
    for (const { selector, message } of context.options) {
      visitors[selector] = (node) => context.report({ node, message });
    }
    return visitors;
  },
};
export default { meta: { name: "kumora" }, rules: { "restricted-syntax": restrictedSyntax } };
```

Config. Each override sets `"jsPlugins": ["./kumora-plugin.mjs"]`.

```jsonc
// src/effect/**
"kumora/restricted-syntax": ["error",
  {"selector": "ThrowStatement", "message": "Do not throw. Return Effect.fail(new MyError(...)) with a Schema.TaggedErrorClass."},
  {"selector": "NewExpression[callee.name='Promise']", "message": "Do not build a Promise. Use Effect.callback / Effect.promise."},
  {"selector": ":function[async=true]", "message": "No async functions. Write Effect.gen(function* () { ... }) instead."},
  {"selector": "MemberExpression[object.name='process'][property.name='exit']", "message": "Return a failing Effect; NodeRuntime.runMain sets the exit code."}]
// src/ui/**
"kumora/restricted-syntax": ["error",
  {"selector": "CallExpression[callee.name=/^use(State|Effect|Memo)$/], CallExpression[callee.property.name=/^use(State|Effect|Memo)$/]",
   "message": "No React state hooks here. Use an @effect/atom-react atom (useAtomValue / useAtom)."}]
```

Output (`--format=unix`):

```
src/effect/bans.ts:8:3: Do not throw. Return Effect.fail(new MyError(...)) with a Schema.TaggedErrorClass. [Error/kumora(restricted-syntax)]
src/effect/bans.ts:11:27: Return a failing Effect; NodeRuntime.runMain sets the exit code. [Error/kumora(restricted-syntax)]
src/effect/bans.ts:14:27: Do not build a Promise. Use Effect.callback / Effect.promise. [Error/kumora(restricted-syntax)]
src/effect/bans.ts:18:8: No async functions. Write Effect.gen(function* () { ... }) instead. [Error/kumora(restricted-syntax)]
src/effect/bans.ts:21:26: No async functions. Write Effect.gen(function* () { ... }) instead. [Error/kumora(restricted-syntax)]
src/effect/bans.ts:23:15: No async functions. Write Effect.gen(function* () { ... }) instead. [Error/kumora(restricted-syntax)]
src/ui/hooks.tsx:6:15: No React state hooks here. Use an @effect/atom-react atom (useAtomValue / useAtom). [Error/kumora(restricted-syntax)]
src/ui/hooks.tsx:7:3: No React state hooks here. ...
src/ui/hooks.tsx:8:13: No React state hooks here. ...
src/ui/hooks.tsx:14:15: No React state hooks here. ...
src/ui/hooks.tsx:15:3: No React state hooks here. ...
src/ui/hooks.tsx:16:13: No React state hooks here. ...
12 problems
```

The plugin caught the `throw` and all six hook calls, including `React2.useMemo`. It flagged only `new Promise`, not `Promise.resolve`. A plugin message is the whole diagnostic, so the fix is on the main line and no `help:` text is added. `globalThis.process.exit` was still missed, because the selector does not match it.

## Per-ban notes

- **`throw`:** a JS plugin is the only option. Third-party callbacks such as Radix and recharts handlers never need `throw`, so they do not raise the escape-hatch question for this ban. That question in #98 applies to `async`, `new Promise` and hooks.
- **`process.exit`:** use `no-restricted-properties`. Do not use `unicorn/no-process-exit`: its fixed help text, "Throw an error instead.", contradicts the `throw` ban.
- **`node:fs` / `node:child_process`:** use `no-restricted-imports`. The regex pattern also catches bare `fs` and subpaths such as `fs/promises`, and `unicorn/prefer-node-protocol` already enforces the `node:` prefix. Not tested: `require(...)`, which `import/no-commonjs` already bans, and dynamic `import("node:fs")`.
- **`new Promise`:** `no-restricted-globals` bans every value use of `Promise`, including `Promise.all` and `Promise.resolve`. That is likely right for code that must return Effects. For `new Promise` only, use the plugin selector. Its help line is the generic "Use a local variable or function parameter instead of the restricted global." That line is misleading, but the custom text in the main message comes first.
- **`async`:** `oxc/no-async-await` (category `restriction`) catches every async function form, but its text cannot be configured and does not name `Effect.gen`. A plugin selector can name the fix.
- **React hooks:** the built-in pair covers `import { useState }` and `React.useState`. Setting `importNames` on `react` also rejects `import * as React from "react"`, so code must use named imports. A default import alias such as `R.useMemo` gets through. A plugin that matches on callee name catches every call form. It would also flag a local function named `useState`, which is unlikely in practice.
- **Messages:** every built-in `restricted-*` rule takes a per-entry `message`. In the default and `agent` output, `no-restricted-imports` and `no-restricted-properties` print it as `help:`. `no-restricted-globals` appends it to the main message. `--format=unix` drops `help` completely, but the repo gate uses `--format=agent`, which keeps it.

## Open questions

- Built-in rules where they suffice, with a plugin only for `throw`? Or one `kumora/restricted-syntax` plugin for every ban, which gives one place for messages and full coverage but makes the gate depend on an alpha API?
- If built-in rules are used: the override-replaces-options behaviour means each scoped override restates the root import list. That could be generated, or hand-maintained the way the bridge override is maintained today.
- Escape hatch: Oxlint honours `// oxlint-disable-next-line <rule>`, but the repo forbids inline ignore comments (`AGENTS.md`). Third-party callback sites need a narrower `overrides` glob or a plugin option that allows them.
- JS plugins need Node at lint time. Node 26.13 is installed, and TypeScript plugin files need Node 22.18 or later (schema `jsPlugins` docs). Workers Builds and CI must run oxlint with Node, not as a standalone binary.
