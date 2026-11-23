# mend

[![make.fun: hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in every common format: unified diffs
(whose line numbers may be wrong), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls
as JSON.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The patch comes from the named file, or from standard input when PATCH is absent or `-`. mend
finds the lines each edit names at the first of three matching tiers — exact, then tolerant of
trailing whitespace, then tolerant of leading whitespace too, re-indenting what it writes to the
file's own indentation — and applies the whole patch or nothing: when any edit fails, no file is
written and every failure is reported. `--check` reports what would change without writing,
`--strict` matches lines exactly, and `--format` pins the patch format instead of detecting it.

mend is specified by SPEC.md from the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
("Build mend, one patch tool for every AI edit format"). It runs on Node 22 with the standard
library alone and no install step. `runner.ts` beside it is the kit's trial runner: when
`MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.

## Licence

MIT
