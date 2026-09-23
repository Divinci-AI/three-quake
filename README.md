# three-quake

A port of Quake to Three.js.

### Play

https://mrdoob.github.io/three-quake/

### Dev Log

https://x.com/mrdoob/status/2015076521531355583

### Assets

Shareware `pak0.pak` included (Episode 1).  
For the full game, replace with your own `pak0.pak` from a registered copy of Quake.

### License

Code: GPL v2

### Credits

- Original game by id Software ([source](https://github.com/id-Software/Quake))
- Three.js port by [@mrdoob](https://github.com/mrdoob) with [@claude](https://github.com/claude)

## Bot deathmatch (Frogbot bodies, Jev minds, Divinci voices)

Open `http://127.0.0.1:8093/?pak=frogbot.pak`, press `~`, and type:

```
botmatch            # e1m1 with 3 bots; `botmatch e1m2 2` for another map/count
```

Use `botmatch` rather than typing `maxplayers`/`map` by hand: maxplayers
cannot change while a game is running, so the manual route silently stays
single player, and Frogbot then answers "cannot add bots in single player".
Build the pak once with `tools/build-frogbot-pak.sh`; the design is in
docs/JEV_BOTS.md.

## Talking monsters (npc-brain experiment)

Monsters talk back, and shout when they first spot you. Each monster type is
its own **Divinci release**: its own thread prefix (the persona and reply
format), its own transcripts per monster, a Cloudflare model, and an Aura-2
voice. Voiced lines play in the game automatically.

In game, open the console (`~`) near a monster:

```
talk Why are you guarding this place?
npc_barks 0        # turn off sight barks
```

### Setup (once per Divinci environment)

```
export QUAKE_DIVINCI_API_KEY=divinci_...     # key for a dedicated workspace
export QUAKE_DIVINCI_API_URL=https://api.stage.divinci.app   # default
deno task setup-releases            # dry run
deno task setup-releases --apply    # create 16 releases, set thread prefixes
```

This writes `npc-brain/releases.json`. Re-running it is safe: releases are
matched by slug, and `--apply` refreshes each thread prefix from
`npc-brain/monsters.ts`. The key needs `release:read release:write
transcript:write whitelabel:write`, and the workspace needs a default
assistant set. The game only reads `QUAKE_DIVINCI_API_KEY`, never
`DIVINCI_API_KEY`.

### Run

```
deno task brain    # divinci if QUAKE_DIVINCI_API_KEY is set; NPC_BRAIN_MOCK=1 for canned lines
deno task web      # http://127.0.0.1:8093
```

### How it fits together

- **`src/npc_talk.js`** (engine): the `talk` command, and a 250 ms scan that
  sends a `sight` event when a monster first locks onto a player. Sight barks
  are rate-limited: 6 s globally, 30 s per monster, and never for the dog,
  the Rotfish or the Spawn. Because the world keeps moving while a request is
  in flight, every reply is re-checked against it before it is applied. Only
  `none` and `attack` are accepted as actions. Audio reaches the client via
  `npc_speak <hex id> <volume>`, and that id is validated strictly because it
  becomes a console command.
- **`npc-brain/`**: the only process that holds a key. One Divinci transcript
  per monster instance. It returns the line at once, and `GET /audio/<id>`
  waits for TTS to finish. The backend is `divinci`, `anthropic` or `mock`.
- **`sv_user.js`**: `talk` is on the server's allowlist for client commands.
  Without that entry the server drops the command silently.
