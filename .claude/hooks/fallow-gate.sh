#!/usr/bin/env bash
# Blocks git commit and git push on a failing fallow audit, as the fallow plugin's
# gate does, but prints a summary: its full report once ran to 2.6 MB and killed the
# agent that received it. The plugin gate defers to this file while
# .claude/settings.json names it. Audit problems allow the command, with a notice.
set -uo pipefail

MAX_FINDINGS=20

if ! command -v jq >/dev/null 2>&1; then
  echo "fallow gate: jq is not on PATH, skipping the audit." >&2
  exit 0
fi

INPUT="$(cat)"
CMD="$(jq -r '.tool_input.command // empty' <<<"$INPUT")"
CWD="$(jq -r '.cwd // empty' <<<"$INPUT")"

# Tokenized so git options before the subcommand still match (git -C dir push) and
# arguments do not (git log commit.txt).
is_git_write() {
  local segment
  while IFS= read -r segment; do
    # shellcheck disable=SC2086
    set -- $segment
    while [ "$#" -gt 0 ]; do
      if [ "$1" != "git" ]; then
        shift
        continue
      fi
      shift
      while [ "$#" -gt 0 ]; do
        case "$1" in
          commit | push) return 0 ;;
          -c | -C | --git-dir | --work-tree | --namespace | --config-env | --super-prefix | --exec-path | --list-cmds | --attr-source)
            shift
            [ "$#" -gt 0 ] && shift
            ;;
          -*) shift ;;
          *) break ;;
        esac
      done
    done
  done < <(printf '%s\n' "$1" | tr ';|&()' '\n\n\n\n\n')
  return 1
}

set -f
is_git_write "$CMD"
IS_WRITE=$?
set +f
[ "$IS_WRITE" -eq 0 ] || exit 0

ROOT="$(git -C "${CWD:-.}" rev-parse --show-toplevel 2>/dev/null)" || ROOT="${CWD:-.}"
cd "$ROOT" || exit 0

# The repo's pinned fallow first: CI's fallow job runs that version, and an
# older one on PATH can miss what it reports.
if [ -x node_modules/.bin/fallow ]; then
  FALLOW=node_modules/.bin/fallow
elif command -v fallow >/dev/null 2>&1; then
  FALLOW=fallow
else
  echo "fallow gate: the fallow binary is not installed, skipping the audit." >&2
  exit 0
fi

REPORT="$(mktemp "${TMPDIR:-/tmp}/fallow-gate-XXXXXX")"
"$FALLOW" audit --format json --quiet --explain --gate-marker agent >"$REPORT" 2>/dev/null
STATUS=$?

if [ "$(jq -r '.verdict // empty' "$REPORT" 2>/dev/null)" = "fail" ]; then
  {
    # The hook refuses the whole command, so a `sed ... && git commit` one-liner
    # never applies its sed; agents read the block as "the fix did not work".
    echo "fallow gate: blocked, and nothing in this command ran (edits chained before the commit included). Fix the blocking findings in their own call, then commit."
    jq -c '.attribution // empty' "$REPORT"
    # Blocking (effective_severity error) first, then warnings, each led by its
    # location and severity: a complexity finding's metrics once pushed the one
    # blocker past the cut, and agents hand-wrote jq to find it.
    # Scalars only: a clone group's nested instances are what make the report huge.
    # `fix` is fallow's first action that is not a suppression (AGENTS.md bans
    # inline ignores): without it, spec #280's fixer guessed five times at one
    # unused export before removing the `export`.
    jq -c '[.. | objects | select(.introduced == true)
      | {fix: ([.actions[]? | select(.type != "suppress-line") | .description][0])}
        + with_entries(select(.value | type | IN("string", "number")))]
      | sort_by(.effective_severity != "error") | .[]
      | {effective_severity, path, line, name, export_name, exceeded, fix} + .
      | with_entries(select(.value != null))' "$REPORT" |
      head -n "$MAX_FINDINGS" | cut -c1-400
    jq -r '.next_steps[]? | "next: \(.command)  # \(.reason)"' "$REPORT"
    echo "Full report: $REPORT (can be megabytes; query it with jq, do not print it)."
  } >&2
  exit 2
fi

rm -f "$REPORT"
if [ "$STATUS" -ne 0 ]; then
  echo "fallow gate: fallow audit exited $STATUS without a verdict, skipping." >&2
fi
exit 0
