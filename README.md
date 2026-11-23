# Make.fun-entry-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Magnum218/Make.fun-entry-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Magnum218/Make.fun-entry-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in every common format: unified diffs
(whose line numbers may be wrong), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls
as JSON.

mend finds the lines each edit names at the first of three matching tiers — exact, then tolerant of
trailing whitespace, then tolerant of leading whitespace too, re-indenting what it writes to the
file's own indentation — and applies the whole patch or nothing: when any edit fails, no file is
written and every failure is reported. `--check` reports what would change without writing,
`--strict` matches lines exactly, and `--format` pins the patch format instead of detecting it.

mend is specified by SPEC.md from the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
("Build mend, one patch tool for every AI edit format"). It runs on Node 22 with the standard
library alone and no install step. `runner.ts` beside it is the kit's trial runner: when
`MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The patch comes from the named file, or from standard input when PATCH is absent or `-`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=chocolatos-eth&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
