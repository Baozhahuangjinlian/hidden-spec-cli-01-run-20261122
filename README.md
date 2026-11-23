[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Baozhahuangjinlian/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Baozhahuangjinlian/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

Entry for the [make.fun](https://make.fun) bounty
[`hidden-spec-cli-01-run-20261122`](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
a command-line tool that applies AI-written edits in four formats
(unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A
patches and JSON tool calls) to a tree of text files, to the
specification in the kit's `SPEC.md`, changing every file or none.

## Run

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`main.ts` is the CLI (Node 22, standard library only); `runner.ts` is
the kit's trial runner, kept as the kit has it.

## Practice

```sh
node check.ts <kit>/program/generator/practice.json
```

runs the 100 public practice checks (unified 30, SEARCH/REPLACE 20,
V4A 20, JSON 15, command line 15) against `main.ts` and prints the
practice score.
