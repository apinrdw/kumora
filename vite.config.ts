// The root Vite+ config holds the repo's lint and format rules and nothing
// else: `vp lint` and `vp fmt` read its `lint` and `fmt` blocks from any
// directory. The apps' own vite.config.ts and the vitest.config.* files keep
// their Vite and Vitest settings.
// Decision: vite-plus is the one Oxc pin; every lint and format call goes through vp
// (docs/adr/0022-vite-plus-is-the-one-oxc-pin.md)
import { defineConfig } from "vite-plus"

const effectV3 = "Effect v3 package."

const importPaths = [
  {
    name: "cloudflare:workers",
    message:
      "Use the WorkerEnv service from @workspace/server; only its bridge and its Workflow runner reach cloudflare:workers.",
  },
  {
    name: "zod",
    message:
      'Use Effect Schema (`import { Schema } from "effect"`); it is the only schema library.',
  },
  {
    name: "@effect/schema",
    message: `${effectV3} Use \`Schema\` from \`effect\` (v4).`,
  },
  {
    name: "@effect/platform",
    message: `${effectV3} Use the \`effect/*\` platform modules (v4), e.g. \`effect/http/HttpClient\`.`,
  },
  {
    name: "@effect/rpc",
    message: `${effectV3} Use \`effect/unstable/rpc\` (v4).`,
  },
]

const importPatterns = [
  {
    group: ["**/repos/**", "repos/**"],
    message:
      "repos/ is a read-only reference. Import the installed package instead.",
  },
  {
    group: ["@effect/schema/*", "@effect/platform/*", "@effect/rpc/*"],
    message: `${effectV3} Use the matching \`effect/*\` module (v4).`,
  },
]

// The Effect override's extra import bans.
const effectImportPatterns = [
  ...importPatterns,
  {
    regex: "^(node:)?fs(/.*)?$",
    message:
      "Use the FileSystem and Path services from `effect` (the platform services layer provides them).",
  },
  {
    regex: "^(node:)?child_process$",
    message:
      "Use ChildProcess from `effect/process`. spawner.lines and spawner.string ignore the exit code, so await handle.exitCode.",
  },
]

const processExit = {
  object: "process",
  property: "exit",
  message:
    "Fail with a tagged error instead (return yield* new SomeError(...)); runMain exits 1 on a failure.",
}

const globalThisProcess = {
  selector:
    "MemberExpression[object.name='globalThis'][property.name='process']",
  message:
    "Reach the process through Effect: Config for env, Stdio for argv, and fail with a tagged error instead of exiting.",
}

const plugin = "./scripts/oxlint-plugin.mts"

export default defineConfig({
  lint: {
    plugins: [
      "eslint",
      "typescript",
      "unicorn",
      "oxc",
      "import",
      "react",
      "jsx-a11y",
      "vitest",
    ],
    categories: { correctness: "error" },
    // Decision: tsrs checks types through vp check, with type-aware lint on
    // (docs/adr/0023-types-are-checked-by-tsrs-through-vp-check-with-type-aware-lint-on.md)
    options: { typeAware: true, typeCheck: true },
    rules: {
      "no-unused-vars": [
        "error",
        {
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-restricted-imports": [
        "error",
        { paths: importPaths, patterns: importPatterns },
      ],
      "no-case-declarations": "error",
      "no-fallthrough": "error",
      "no-regex-spaces": "error",
      "no-shadow": "warn",
      "no-var": "error",
      "prefer-const": "error",
      "require-yield": "off",
      "typescript/ban-ts-comment": [
        "error",
        { "ts-expect-error": false, "ts-ignore": "allow-with-description" },
      ],
      "typescript/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "typescript/method-signature-style": ["error", "property"],
      "typescript/no-inferrable-types": ["error", { ignoreParameters: true }],
      "typescript/no-namespace": "error",
      "typescript/no-unsafe-function-type": "error",
      "typescript/prefer-for-of": "warn",
      "unicorn/prefer-node-protocol": "error",
      "import/first": "error",
      "import/newline-after-import": "error",
      "import/no-commonjs": "error",
      "import/no-duplicates": "error",
      "react/rules-of-hooks": "error",
      "react/exhaustive-deps": "warn",
      "react/set-state-in-effect": "warn",
      "react/set-state-in-render": "warn",
      "react/purity": "warn",
      "react/immutability": "warn",
      "react/refs": "warn",
      "react/use-memo": "warn",
      "react/void-use-memo": "warn",
      "react/static-components": "warn",
      "react/globals": "warn",
      "react/error-boundaries": "warn",
      "react/preserve-manual-memoization": "warn",
      "react/incompatible-library": "warn",
      "react/hooks": "warn",
      "react/memo-dependencies": "warn",
      "react/exhaustive-effect-dependencies": "warn",
      "react/capitalized-calls": "warn",
      "react/invariant": "warn",
      "react/rule-suppression": "warn",
      "react/syntax": "warn",
      "react/unsupported-syntax": "warn",
      "react/todo": "warn",
      "jsx-a11y/prefer-tag-over-role": "off",
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "warn",
      "vitest/no-identical-title": "error",
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: [
            "it.effect",
            "it.effect.each",
            "it.live",
          ],
        },
      ],
      "vitest/valid-expect": "error",
      "vitest/valid-title": "error",
    },
    ignorePatterns: [
      "**/routeTree.gen.ts",
      "**/dist/**",
      "**/.output/**",
      "**/.nitro/**",
      "**/.tanstack/**",
      "**/coverage/**",
      "repos/**",
      "**/.alchemy/**",
    ],
    // Overrides replace a rule's root options, they don't merge, so every
    // override that sets no-restricted-imports restates the root paths and
    // patterns. scripts/check-oxlint-overrides.mts fails when one is missing.
    // Decision: packages/ui/src is in no lint override, so shadcn output lints as is
    // (docs/adr/0012-shadcn-output-in-packages-ui-lints-unedited.md)
    overrides: [
      {
        // The full Effect ban set, tests included. A workspace that moves to
        // Effect adds its globs here; an exception is a later override.
        files: [
          "scripts/**",
          "packages/server/src/**",
          "packages/server/tests/**",
          "packages/client/src/**",
          "packages/client/tests/**",
          "packages/deploy/src/**",
          "packages/deploy/tests/**",
          "packages/relay/src/**",
          "packages/relay/tests/**",
          "apps/extension/src/worker/**",
          "apps/extension/src/options/**",
          "apps/extension/tests/**",
          "apps/web/alchemy.run.ts",
          "apps/web/src/**",
          "apps/dashboard/alchemy.run.ts",
          "apps/dashboard/src/**",
          "apps/dashboard/billing/**",
          "apps/dashboard/tests/*.ts",
          "apps/dashboard/tests/lib/**",
          "apps/dashboard/tests/server/**",
          "apps/dashboard/tests/components/**/*.ts",
        ],
        jsPlugins: [plugin],
        rules: {
          "no-restricted-imports": [
            "error",
            { paths: importPaths, patterns: effectImportPatterns },
          ],
          "no-restricted-properties": [
            "error",
            processExit,
            {
              object: "process",
              property: "env",
              message:
                "Read env through Config (Config.NonEmptyString, Config.Redacted).",
            },
          ],
          "no-restricted-globals": [
            "error",
            {
              name: "Promise",
              message:
                "Wrap a Promise API with Effect.promise or Effect.tryPromise, and a callback API with Effect.callback.",
            },
          ],
          // Its message is fixed text; CODING_STANDARDS.md says to write Effect.gen.
          "oxc/no-async-await": "error",
          "kumora/restricted-syntax": [
            "error",
            {
              selector: "ThrowStatement",
              message:
                "Do not throw. Return yield* new SomeError(...) (a Schema.TaggedError), or Effect.fail.",
            },
            globalThisProcess,
          ],
        },
      },
      {
        // The bridge, and the Workflow runner whose class must extend
        // WorkflowEntrypoint, are the only modules that may reach
        // cloudflare:workers. It must stay after the Effect override, which it
        // narrows.
        files: [
          "packages/server/src/bridge.ts",
          "packages/server/src/workflow.ts",
        ],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: importPaths.filter(
                ({ name }) => name !== "cloudflare:workers"
              ),
              patterns: effectImportPatterns,
            },
          ],
        },
      },
      {
        // The deploy token swap and its test are the Effect-override files that write process.env:
        // alchemy's plan and Infisical read it there, not through Config. It
        // must stay after the Effect override, which it narrows. See
        // apinrdw/kumora#107.
        files: [
          "packages/deploy/src/token-swap.ts",
          "packages/deploy/tests/token-swap.test.ts",
        ],
        rules: {
          "no-restricted-properties": ["error", processExit],
        },
      },
      {
        // React code: routes may `throw redirect(...)` and `throw notFound()`,
        // TanStack Router's control flow. Every other ban still applies. It
        // must stay after the Effect override, which it narrows.
        files: ["apps/web/src/routes/**", "apps/dashboard/src/routes/**"],
        jsPlugins: [plugin],
        rules: {
          "kumora/restricted-syntax": ["error", globalThisProcess],
        },
      },
      {
        // Decision: the tape is the one dashboard module that runs SQL on a trades table
        // (docs/adr/0013-the-tape-is-the-one-module-that-runs-sql-on-a-trades-table.md)
        files: ["apps/dashboard/src/**"],
        jsPlugins: [plugin],
        rules: {
          "kumora/tape-owns-trades": "error",
        },
      },
      {
        files: ["apps/dashboard/src/server/market-live/tape.ts"],
        rules: {
          "kumora/tape-owns-trades": "off",
        },
      },
      {
        // Root scripts hold none of the exceptions to CODING_STANDARDS.md's
        // "Every non-component function returns an Effect" but the ones the
        // next override names, so lint holds the rule there.
        files: ["scripts/**"],
        jsPlugins: [plugin],
        rules: {
          "kumora/effect-functions": "error",
        },
      },
      {
        // Test helpers, the runtime that runs a script's Effect, and the oxlint
        // plugin, whose rules oxlint calls as plain functions.
        files: [
          "scripts/**/*.test.mts",
          "scripts/lib/testing.mts",
          "scripts/lib/run.mts",
          "scripts/oxlint-plugin.mts",
        ],
        rules: {
          "kumora/effect-functions": "off",
        },
      },
      {
        // Decision: React-free folders skip rules-of-hooks, listed one by one
        // (docs/adr/0014-react-free-code-skips-rules-of-hooks.md)
        files: [
          "scripts/**",
          "packages/client/**",
          "packages/deploy/**",
          "packages/relay/**",
          "packages/server/**",
          "apps/extension/src/worker/**",
          "apps/*/alchemy.run.ts",
          "apps/*/src/server/**",
          "apps/*/src/worker.ts",
          "apps/dashboard/billing/**",
          "apps/dashboard/src/routes/api/**",
        ],
        rules: {
          "react/rules-of-hooks": "off",
        },
      },
    ],
  },
  fmt: {
    endOfLine: "lf",
    semi: false,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "es5",
    printWidth: 80,
    sortPackageJson: false,
    // Decision: Oxfmt sorts Tailwind classes natively from the ui globals.css
    // (docs/adr/0010-oxfmt-sorts-tailwind-classes-from-the-ui-stylesheet.md)
    sortTailwindcss: {
      stylesheet: "packages/ui/src/styles/globals.css",
      functions: ["cn", "cva"],
    },
    // A doc's code fence quotes code as it stands: a `yield*` line lifted out
    // of its generator would reformat as multiplication.
    overrides: [
      { files: ["**/*.md"], options: { embeddedLanguageFormatting: "off" } },
    ],
    ignorePatterns: [
      "**/routeTree.gen.ts",
      "dist/",
      ".turbo/",
      ".output/",
      ".nitro/",
      ".tanstack/",
      "coverage/",
      "repos/",
      ".alchemy/",
      // Machine-written: recorded feeds and reports, research results and
      // pages, the impeccable tool's design files and fallow's CLAUDE.md. A
      // re-record or reinstall must not fail format.
      "CLAUDE.md",
      "**/fixtures/**/*.json",
      "docs/research/**/*.json",
      "docs/research/**/*.html",
      "**/.impeccable/",
    ],
  },
})
