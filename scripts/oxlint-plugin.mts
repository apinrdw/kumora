// The local oxlint JS plugin, loaded per override through `jsPlugins` in
// .oxlintrc.json. `kumora/restricted-syntax` works like ESLint's
// no-restricted-syntax, which oxlint lacks: each option is an esquery selector
// and the message that names the fix. The JS plugin API is alpha in oxlint
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

export default {
  meta: { name: "kumora" },
  rules: { "restricted-syntax": restrictedSyntax },
}
