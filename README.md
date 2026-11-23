[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/firehorse20/hidden-spec-cli-01/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/firehorse20/hidden-spec-cli-01/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

# mend

mend is one command-line tool that applies the edits AI models write, in four
formats, to a tree of text files. Node 22 and its standard library alone:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`SPEC.md` is the whole specification. It covers:

- unified diffs (section 6): sections, creations, deletions, moves, hunks with
  wrong line numbers (nearest occurrence, drifted by earlier hunks), `\ No
  newline at end of file`, prose and code fences around the patch;
- SEARCH/REPLACE blocks (section 7): path lines, fences, creation from an
  empty old block, ambiguity when the old lines occur more than once;
- V4A patches (section 8): add / delete / update / move-to, `@@` anchors,
  a cursor that moves through the file, end-of-file chunks;
- JSON edits (section 9): `create`, `str_replace`, `insert`, in array or
  JSON Lines form, with CRLF handling;
- line matching at three tiers (section 5): exact, trailing-whitespace
  tolerant, then indentation tolerant with re-indenting at tier 2;
- all-or-nothing writes (section 10): every edit applies or none is written,
  and failures are all reported.

`check.ts` runs the public practice set from the kit
(`program/generator/practice.json`):

    node check.ts ../program/generator/practice.json

`runner.ts` is the trial runner: when `MAKEFUN_ENV_URL` is set, `main.ts`
hands a trial over to it. It is kept as the kit has it.
