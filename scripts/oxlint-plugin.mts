// The local oxlint JS plugin, loaded per override through `jsPlugins` in
// .oxlintrc.json. `kumora/restricted-syntax` works like ESLint's
// no-restricted-syntax, which oxlint lacks: each option is an esquery selector
// and the message that names the fix. `kumora/effect-functions` fails a function declared at a module's top level
// that doesn't return an Effect by its shape: CODING_STANDARDS.md's "Every
// non-component function returns an Effect", for folders where none of that
// rule's exceptions occur. The JS plugin API is alpha in oxlint
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

interface EsNode {
  readonly type: string
  readonly [key: string]: unknown
}

// The identifier a call and member chain starts from: `Effect` for
// `Effect.succeed(x).pipe(f)`.
const chainRoot = (node: EsNode): EsNode => {
  if (node.type === "CallExpression") return chainRoot(node.callee as EsNode)
  if (node.type === "MemberExpression") return chainRoot(node.object as EsNode)
  return node
}

const isFunction = (node: EsNode | null | undefined) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression"

// An arrow whose body is an `Effect.*` chain returns an Effect by its shape;
// any other function must be built with Effect.fn or Effect.fnUntraced.
const returnsEffect = (fn: EsNode) => {
  const body = fn.body as EsNode
  if (fn.type !== "ArrowFunctionExpression" || body.type === "BlockStatement")
    return false
  const root = chainRoot(body)
  return root.type === "Identifier" && root.name === "Effect"
}

const effectFunctions = {
  meta: { type: "problem", schema: false },
  create: (context: RuleContext) => {
    const report = (node: EsNode) =>
      context.report({
        node,
        message:
          'Return an Effect: build this function with Effect.fn("name") or Effect.fnUntraced(function* () {...}), or move it inside the Effect generator that uses it (CODING_STANDARDS.md, "Every non-component function returns an Effect").',
      })
    const check = (statement: EsNode) => {
      const declaration =
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportDefaultDeclaration"
          ? (statement.declaration as EsNode | null)
          : statement
      if (declaration?.type === "FunctionDeclaration") report(declaration)
      if (declaration?.type === "VariableDeclaration")
        for (const declarator of declaration.declarations as Array<EsNode>) {
          const init = declarator.init as EsNode | null
          if (init && isFunction(init) && !returnsEffect(init))
            report(declarator)
        }
    }
    return {
      Program: (program: EsNode) =>
        (program.body as Array<EsNode>).forEach(check),
    }
  },
}

export default {
  meta: { name: "kumora" },
  rules: {
    "effect-functions": effectFunctions,
    "restricted-syntax": restrictedSyntax,
  },
}
