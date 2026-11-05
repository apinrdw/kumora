import { test } from "node:test"
import assert from "node:assert/strict"
import { unguardedPipes } from "./package-scripts.mts"

test("a pipe whose producer can fail is reported", () => {
  assert.deepEqual(unguardedPipes("infisical export | wrangler x"), [
    "infisical export | wrangler x",
  ])
})

test("a captured producer handed to printf is allowed", () => {
  assert.deepEqual(unguardedPipes(`out=$(a) && printf '%s\\n' "$out" | b`), [])
})

test("|| is not a pipe", () => {
  assert.deepEqual(unguardedPipes("a || b"), [])
})

test("every non-final stage must be safe", () => {
  assert.deepEqual(unguardedPipes("printf x | false | cat"), [
    "printf x | false | cat",
  ])
})

test("a | inside quotes is not a pipe", () => {
  assert.deepEqual(unguardedPipes(`node -e "console.log('a|b')"`), [])
  assert.deepEqual(unguardedPipes("grep -E 'x|y' f"), [])
})

test("each && segment is judged on its own", () => {
  assert.deepEqual(unguardedPipes("a && b | c; d"), ["b | c"])
})

test("a pipe inside a quoted command substitution is reported", () => {
  assert.deepEqual(
    unguardedPipes(
      `out="$(infisical export | cat)" && printf '%s\\n' "$out" | b`
    ),
    ["infisical export | cat"]
  )
})

test("an unquoted newline ends a pipeline", () => {
  assert.deepEqual(unguardedPipes("printf x\ninfisical export | b"), [
    "infisical export | b",
  ])
})

test("a substitution inside single quotes is literal text", () => {
  assert.deepEqual(unguardedPipes(`node -e 'console.log("$(a | b)")'`), [])
})

test("the allowlist matches whole command names", () => {
  assert.deepEqual(unguardedPipes("printf-json x | b"), ["printf-json x | b"])
  assert.deepEqual(unguardedPipes("echo-cli | b"), ["echo-cli | b"])
})

test("a background & separates command lists", () => {
  assert.deepEqual(unguardedPipes("echo ready & infisical export | b"), [
    "infisical export | b",
  ])
})

test("quotes nested inside a quoted substitution are honoured", () => {
  assert.deepEqual(
    unguardedPipes(`out="$(printf '%s' "a|b")" && printf '%s\\n' "$out" | cat`),
    []
  )
})

test("a backtick substitution is its own command list", () => {
  assert.deepEqual(unguardedPipes("out=`infisical export | cat` && b"), [
    "infisical export | cat",
  ])
})

test("a redirection ampersand is not a separator", () => {
  assert.deepEqual(unguardedPipes("echo x 2>&1 | cat"), [])
  assert.deepEqual(unguardedPipes("a 2>&1 | cat"), ["a 2>&1 | cat"])
})

test("an escaped dollar inside double quotes is literal", () => {
  assert.deepEqual(unguardedPipes(`echo "\\$(a | b)"`), [])
})

test("a quoted parenthesis does not end a substitution", () => {
  assert.deepEqual(
    unguardedPipes(`out="$(printf ')' && infisical export | wrangler x)"`),
    ["infisical export | wrangler x"]
  )
})

test("a noclobber redirection is not a pipe", () => {
  assert.deepEqual(unguardedPipes("cat f >| out"), [])
})

test("a backtick substitution inside double quotes keeps its own quotes", () => {
  assert.deepEqual(
    unguardedPipes('out="`infisical export --env="$ENV" | cat`" && b'),
    ['infisical export --env="$ENV" | cat']
  )
})
