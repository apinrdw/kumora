# CI package tasks hash no Markdown

The package tasks CI runs (typecheck, build, lint, format:check, test) and test's transit task hash no Markdown, so a GLOSSARY-only edit replays them from cache. No package's code or tests read a `.md` file. A package that starts to must drop `"!**/*.md"` from the inputs of the tasks that read it.

Sites:

- `turbo.json`

Source: none
