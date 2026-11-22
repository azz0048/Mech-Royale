# mech-royale-bot

Bot for the Builders Buildathon "Mech Royale" track (protocol `mechfight/1`), team "not even close".

## What runs

The submitted image (`Dockerfile`) runs `automata/`, our Rust bot (MIT License, see `automata/LICENSE`).
Its tunable parameters are in `automata/bot.json` (read through `MECH_PARAMS`).

```sh
docker build -t my-bot .
```

## Go bot (giddy)

`Dockerfile.giddy` builds the Go bot in `giddy/`: it is
[giddygiddyboy-mech-royale](https://github.com/justnau/giddygiddyboy-mech-royale) by giddygiddyboy,
used under the MIT License (see `giddy/LICENSE`), taken at commit `70c8b23`. Our changes to it:
the bot name, an RNG seed salt (`giddy/mech/salt.go`), and optional tweaks behind constants in
`giddy/mech/tweaks.go` (lose-rule thresholds, finish rush, hearing, rear armor, supply drops,
free-for-all detection, mobility boosts, squad targeting weights, end-game zone hold, small fixes), with replay tests in `giddy/mech/tweaks_test.go`. On `main`
every tweak is off, so the brain plays as `70c8b23`; experiment commits turn some of them on.

```sh
docker build -f Dockerfile.giddy -t my-giddy-bot .
```

## Our own bot

The TypeScript bot (`bot.ts`, `src/`, run with bun, image `Dockerfile.ts`) is our earlier work:
an economy core (TTUN-style methods), a Lance-style core, free-for-all modes, a map model with
line of sight, tree-crown vision and A* navigation, and a local simulator in `tools/`.

```sh
docker build -f Dockerfile.ts -t my-ts-bot .
```
