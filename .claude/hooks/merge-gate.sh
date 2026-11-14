#!/usr/bin/env bash
# Blocks `gh pr merge` until every check on the PR has finished green.
# Decision: the release branches' ruleset requires only e2e-evidence, which the
# no-e2e-evidence label passes at once, so `gh pr merge --auto` merged #291
# while static, unit-tests and fallow were still pending. Gh problems allow the
# command, with a notice.
set -uo pipefail

if ! command -v jq >/dev/null 2>&1 || ! command -v gh >/dev/null 2>&1; then
  echo "merge gate: jq or gh is not on PATH, skipping the check." >&2
  exit 0
fi

INPUT="$(cat)"
CMD="$(jq -r '.tool_input.command // empty' <<<"$INPUT")"
CWD="$(jq -r '.cwd // empty' <<<"$INPUT")"

# Prints, one per line, the `gh pr checks` arguments naming the PR a
# `gh pr merge` merges (none: the current branch's PR), or returns 1 when the
# command merges nothing. xargs splits words the way the shell quotes them, so a
# --subject "Fix 12 things" stays one word, and it never runs a $(...).
merge_target() {
  local segment word
  local -a words
  while IFS= read -r segment; do
    mapfile -t words < <(printf '%s' "$segment" | xargs printf '%s\n' 2>/dev/null)
    set -- "${words[@]}"
    while [ "$#" -ge 3 ]; do
      if [ "$1" = "gh" ] && [ "$2" = "pr" ] && [ "$3" = "merge" ]; then
        shift 3
        while [ "$#" -gt 0 ]; do
          word="$1"
          shift
          case "$word" in
            -R | --repo) printf '%s\n%s\n' --repo "${1:-}" && shift ;;
            -t | --subject | -b | --body | -F | --body-file | -A | --author-email | --match-head-commit)
              [ "$#" -gt 0 ] && shift
              ;;
            --repo=*) printf '%s\n' "$word" ;;
            # A redirection: the split above leaves `2>&1` as `2>`.
            -* | *">"* | *"<"*) ;;
            *) printf '%s\n' "$word" ;;
          esac
        done
        return 0
      fi
      shift
    done
  done < <(printf '%s\n' "$1" | tr ';|&()' '\n\n\n\n\n')
  return 1
}

TARGET_OUT="$(merge_target "$CMD")" || exit 0
mapfile -t TARGET <<<"$TARGET_OUT"
[ -z "$TARGET_OUT" ] && TARGET=()

cd "${CWD:-.}" 2>/dev/null || true
# gh exits non-zero while checks pend or fail; the JSON is what counts.
CHECKS="$(gh pr checks "${TARGET[@]}" --json name,bucket 2>/dev/null)"
if ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$CHECKS"; then
  echo "merge gate: gh pr checks gave no answer, skipping the check." >&2
  exit 0
fi

UNFINISHED="$(jq -r '.[] | select(.bucket | IN("pass", "skipping") | not)
  | "  \(.bucket): \(.name)"' <<<"$CHECKS")"
if [ -n "$UNFINISHED" ]; then
  {
    echo "merge gate: blocked, and nothing in this command ran. These checks have not passed:"
    echo "$UNFINISHED"
    echo "main and staging require only e2e-evidence, so GitHub would merge now, --auto included. Fix failures; wait for pending checks to finish, then merge."
  } >&2
  exit 2
fi
exit 0
