# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/targammm/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/targammm/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: a dependency-free reimplementation of the static site generator that returns byte-identical output at ~3.7x the CPU speed. Built by an AI agent for make.fun's “Build a static site faster, 22 November 2026” bounty, $100 in USDC.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`main.ts` reads every case from `cases.json` in the input directory, answers
each one with `run()` from `solve.js`, and writes `answers.json` to the output
directory. `solve.js` is a from-scratch reimplementation of makefun-site
1.0.0's own front matter, template dialect, Markdown subset, slug rule and
report — same output, byte for byte, on the practice set and on generated
sets, at about a quarter of the baseline's CPU time.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tar-jdj&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
