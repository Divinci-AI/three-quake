# Jev bot players: research and design

Goal: Jev plays three-quake on its own, including as several multiplayer bot
players. Each bot is its own Divinci "player" release and speaks during the match.

## What Jev is, and what that implies

Jev (TypeSafe, `jev-1.13.0`, alias `jev-latest`) is a "System One" model. It
does not write text. It answers typed questions about a text or JSON `state`:

- **Choice** picks one option (up to 255) and returns a probability for each.
- **Noul** gives the probability that a yes/no statement is true.
- **Score** places the state on ordered levels (2 to 10).

Numbers from the live docs (2026-09-23):

| | |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY` |
| JS SDK | `@typesafe-ai/sdk` (Node 20+; Deno through `npm:` is untested) |
| Price | $0.042 per 1M input tokens; output tokens are free |
| Limits | 250k tokens/s, 1,200 requests/min, 64k context (32k of it for state) |
| Input | text or JSON only; no images |
| Measured latency | 0.27 s for 13 questions over a 54k-character document, batched in one call (`jev-1.12`) |

**Jev cannot steer the player frame by frame, and nothing should try.** Quake
runs physics at 72 Hz. A 2026 study of LLMs playing DOOM measured 8.9 to 13.3 s
per decision; a 1.3M-parameter specialised model at 31 ms scored 178 frags
against 13 for every LLM tested combined ([arXiv 2604.07385](https://arxiv.org/abs/2604.07385)).
Jev is much faster than those LLMs, at around 0.1 to 0.3 s per call, which
makes it a good fit for **tactical decisions a few times a second**. Movement
and aim still have to come from code.

## Architecture: three layers

```
 72 Hz   BODY    Frogbot QuakeC: navigation (waypoints), aim, dodging, weapon fire
                 runs inside three-quake's own QuakeC VM, like any progs.dat
  ~3 Hz  MIND    Jev: one batched call per bot, JSON state -> typed decisions
                 overrides Frogbot's goal, target and weapon choice
 events  VOICE   one Divinci "player" release per bot -> line -> Aura-2 TTS
                 on frag / death / spawn / low health / "taunt now?" (a Jev Noul)
```

### Body: Frogbot, not a hand-written bot

[Frogbot](https://github.com/DrLex0/quake-frogbots) is written in QuakeC and
GPL-licensed. The FBCA v2 fork ships a prebuilt NetQuake `progs.dat`, and
three-quake runs any original `progs.dat` unmodified. It already has
`addbot`/`removebot`, skill levels 0 to 20, and built-in waypoints for e1m1,
e1m2, e1m4, e1m5, dm2, dm5, dm6 and more. Reaper and FrikBot are the
alternatives ([archive](https://github.com/Jason2Brownlee/QuakeBotArchive)).

**First thing to prove (spike):** that FBCA's NetQuake progs loads in
three-quake and `addbot` spawns a bot that moves. Risks:

- Frogbot may call engine extensions three-quake does not implement. The README
  mentions optional "Krimzon extensions".
- Bots take client slots, so the map must run with `maxplayers` greater than 1
  (deathmatch or coop). The Deno server supports up to 16 (`-maxclients`).

### Mind: Jev decides, code executes

Each tick, build one state object from the server's edicts; the engine already
has everything needed:

```json
{
  "me": {"name": "Ranger", "health": 45, "armor": 0, "weapon": "shotgun",
         "ammo": {"shells": 12, "rockets": 0}, "position": "near quad room"},
  "visible_enemies": [{"id": "e3", "name": "Grunt", "distance": 310, "health_hint": "wounded"}],
  "known_items": [{"id": "i7", "item": "megahealth", "distance": 520}],
  "score": {"me": 4, "leader": 7}
}
```

One call per bot, with every question asked together (speculative fan-out, so
the questions run in parallel):

| id | type | question |
|---|---|---|
| `goal` | Choice | fight / grab item / retreat / hold position / roam |
| `target` | Choice | which visible enemy (options built by code, plus a "none" option) |
| `item` | Choice | which known item to go for (built by code, plus a "none" option) |
| `weapon` | Choice | best weapon now, among those owned and loaded |
| `taunt_now` | Noul | "Is this a good moment to say something to the opponent?" |
| `mood` | Score | cautious to reckless, which feeds the bark persona |

Code applies the answers to Frogbot's goal, enemy and weapon fields, the way
`makeHostile` already drives monster AI through the progs' own entry points.
Before applying, code re-checks that the chosen target and item still exist,
because the world has moved on during the call. Confidence is used as a gate:
a low-confidence `goal` keeps Frogbot's own choice. Cost is about 1.5k tokens
per call. 4 bots at 3 Hz is 12 calls/s, or 720 requests/min against a limit of
1,200. That is ~18k tokens/s, ~65M tokens an hour, so about **$2.70 per hour of
play**. Batching all bots' questions into one call per tick (shared state)
divides the request count by 4, but not the tokens, because each bot still needs
its own view of the match.

### Voice: one Divinci release per bot

This reuses the npc-brain pipeline. Each bot gets its own release
(`quake-bot-<name>`), with its own thread prefix, an Aura-2 voice and its own
transcripts. Unlike monster sight barks, lines are triggered by the Jev
`taunt_now` answer and by game events (frags, deaths, respawns). One throttle
covers all bots, so a match doesn't turn into constant chatter.

## Plan

1. **Spike (1 to 2 h):** get FBCA progs running in three-quake with `addbot`
   on e1m1 or dm6.
2. **Jev mind:** build a `bot-brain` Deno service next to npc-brain. First a
   mock backend, then real calls with `TYPESAFE_API_KEY` held on the server.
   Write unit tests for building the state and applying answers.
3. **Player releases:** extend `setup-releases.ts` with a `BOTS` roster.
4. **Solo "Jev plays":** point the same mind at the human's own slot (client 1)
   so Jev plays single-player unattended.

Blockers: a TypeSafe API key; and the platform TTS fix, since
`/api/v1/tts/generate` currently 500s for API-key callers.
