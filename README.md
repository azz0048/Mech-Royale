# Mech Royale bot

Bot for the Builders Buildathon "Mech Royale" track (protocol `mechfight/1`), team AA's.

Based on a friend's team's bot, used with permission under the MIT License.

## What runs

The submitted image (`Dockerfile`) runs `automata/`, a Rust bot (MIT License, see `automata/LICENSE`).
Its tunable parameters are in `automata/bot.json` (read through `MECH_PARAMS`).

```sh
docker build -t my-bot .
python3 check/check.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m \
  --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/arena:/arena:ro" my-bot
```

(`check/check.py` and `arena/` come from the official `mechfight-kit.tar.gz`.)

## Go bot (giddy)

`Dockerfile.giddy` builds the Go bot in `giddy/`: it is
[giddygiddyboy-mech-royale](https://github.com/justnau/giddygiddyboy-mech-royale) by giddygiddyboy,
used under the MIT License (see `giddy/LICENSE`), taken at commit `70c8b23`, with optional tweaks
behind constants in `giddy/mech/tweaks.go` (all off by default).

```sh
docker build -f Dockerfile.giddy -t my-giddy-bot .
```

## TypeScript bot

`bot.ts`, `src/` and `Dockerfile.ts` are an earlier TypeScript bot with a local simulator in `tools/`.
