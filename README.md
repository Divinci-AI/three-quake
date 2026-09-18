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

## Talking monsters (npc-brain experiment)

Walk up to a monster, open the console (`~`) and type:

```
talk Why are you guarding this place?
```

The nearest living monster within ~700 units and roughly in front of you
answers as a centerprint. It may also decide to attack you.

```
NPC_BRAIN_MOCK=1 deno task brain   # canned replies, no API key
ANTHROPIC_API_KEY=... deno task brain   # real replies (Claude Opus 5, effort low)
deno task web                      # http://127.0.0.1:8093
```

- `src/npc_talk.js` is the engine side. It picks the target, sends the request
  asynchronously, and **re-checks the world before it applies the reply**,
  because the map, the monster, or the monster's edict slot may have changed.
- `npc-brain/` is the only process that holds a key. It returns
  `{ line, action }`, and the engine accepts only `none` and `attack`.
- `talk` is on the server's client-command allowlist in `sv_user.js`.
  Without that entry the server drops the command silently.
- Env: `NPC_MODEL`, `NPC_EFFORT`, `NPC_BRAIN_PORT` (8797), and
  `NPC_ALLOWED_ORIGINS` (loopback is always allowed). In game:
  `npc_brain_url`.
