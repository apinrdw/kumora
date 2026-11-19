// The local oxlint JS plugin, loaded per override through `jsPlugins` in
// .oxlintrc.json. `kumora/restricted-syntax` works like ESLint's
// no-restricted-syntax, which oxlint lacks: each option is an esquery selector
// and the message that names the fix. `kumora/tape-owns-trades` fails a
// string or template that runs SQL against a trading day's trades table
// outside the tape (apps/dashboard/src/server/market-live/tape.ts). The JS
// plugin API is alpha in oxlint
// 1.90, so an oxlint bump re-runs scripts/lint-bans.test.mts.

interface Restriction {
  readonly selector: string
  readonly message: string
}

interface RuleContext {
  readonly options: ReadonlyArray<Restriction>
  readonly report: (descriptor: {
    readonly node: unknown
    readonly message: string
  }) => void
}

const restrictedSyntax = {
  meta: { type: "problem", schema: false },
  create: (context: RuleContext) =>
    Object.fromEntries(
      context.options.map(({ selector, message }) => [
        selector,
        (node: unknown) => context.report({ node, message }),
      ])
    ),
}

// SQL naming the trades table: the table right after the keyword. Prose
// writes its keywords in lower case, so it never matches.
const TRADES_SQL =
  /\b(?:FROM|INTO|JOIN|UPDATE|TABLE(?: IF NOT EXISTS)?)\s+trades\b/

interface TextNode {
  readonly value?: unknown
}

const tapeOwnsTrades = {
  meta: { type: "problem", schema: false },
  create: (context: RuleContext) => {
    const check = (node: unknown, text: unknown) => {
      if (typeof text === "string" && TRADES_SQL.test(text))
        context.report({
          node,
          message:
            "Read and write a day's trades through the tape (apps/dashboard/src/server/market-live/tape.ts), so a second backing for them lands in one place.",
        })
    }
    return {
      Literal: (node: TextNode) => check(node, node.value),
      TemplateElement: (node: { readonly value: { readonly raw: string } }) =>
        check(node, node.value.raw),
    }
  },
}

export default {
  meta: { name: "kumora" },
  rules: {
    "restricted-syntax": restrictedSyntax,
    "tape-owns-trades": tapeOwnsTrades,
  },
}
