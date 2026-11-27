# CI package tasks hash no Markdown

The package tasks CI runs (build, test) and test's transit task hash no Markdown, so a GLOSSARY-only edit replays them from cache. No package's code or tests read a `.md` file. A package that starts to must drop `"!**/*.md"` from the inputs of the tasks that read it. Lint, format and type checks are no package tasks: the root `vp-check` task (ADR-0023) formats Markdown, so it hashes every file and reruns on a GLOSSARY edit.

Sites:

- `turbo.json`

Source: none
