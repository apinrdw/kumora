# Coding standards

Read during review, not implementation. Each rule is a judgement call a reviewer applies to the diff; mechanical rules live in the checks CI runs (`.github/workflows/ci.yml`), and a rule moves there once it can be written as one.

## Shell in package scripts

A pipe in an npm script hides the producer's failure, because `sh` has no `pipefail`. CI fails on a pipe fed by a command outside the allowlist that `scripts/package-scripts.mts` defines. The reviewer's part is the remaining shape: a script that writes to a file or to a remote (`> file`, `secret bulk`, `deploy`) must stop before the write when the step that produced its input failed. The spec can be wrong here too; a prescribed line is still reviewed.

## One definition per shared value

A value that two files must agree on (a hash length, a route path, a header name, a key name) has one definition. The second file imports it, or, when the two cannot share a module (a Worker route and a Node script), each names the other in a comment at the definition so a change to one finds the other.

## Glossary terms are types

A parameter or field that holds a glossary term (an Environment, a Preview) carries a union or branded type from that term's definition, never a bare `string` narrowed by `includes`. Parse external input (argv, JSON, env) into the type at the boundary and trust it inside.

## Bounded memory on a Worker

Code that handles an uploaded file or a whole table on a Worker has a bound that holds at the largest accepted size, and a test at that size. A size check after the body is read is no bound. Three separate review rounds of spec #133 found this class.

## Claims about third-party dashboards

A handoff doc or spec that states what a dashboard shows, offers, or lacks names the date it was observed, in the same sentence or the section's heading. A claim with no date is a guess and is reviewed as one. Prefer a line that can be re-derived (an API call, a CLI command) over one that must be re-observed by hand.
