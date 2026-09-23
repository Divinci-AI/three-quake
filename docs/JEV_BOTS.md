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

## Prior art (searched 2026-09-23) and what it changes

| Project | What it does | What we take |
|---|---|---|
| [Quake3LLM](https://news.ycombinator.com/item?id=41863885) (jmarshall23; repo now 404) | llama.cpp replaced Quake 3's bot text chat; took a whole 4090 | voiced bots are not new, so don't sell them as new |
| [etlegacy-voicehub](https://github.com/DingoOz/etlegacy-voicehub) (GPL-3) | spoken LLM bots for ET: Legacy with per-bot personas, event lines, throttles (`bot_reply_prob`, `bot_thread_max`, `idle_chatter_interval_s`), streamed TTS. **The LLM only talks**; behaviour stays in Omni-bot | its throttle design, as ideas only (GPL-3 code is not compatible with GPL-2-only three-quake) |
| [PUBG Ally](https://developer.nvidia.com/blog/how-krafton-built-pubg-ally-a-co-playable-character-powered-by-nvidia-ace/) (NVIDIA ACE) | System 1 behaviour tree at tick rate plus a System 2 SLM, event-driven, on device. Cloud LLMs were **rejected as too slow** | the same split; event-driven triggering; plan for latency |
| [LLM planning + RL execution](https://arxiv.org/pdf/2606.20014) | an LLM picks skills: win rate equal to a behaviour tree (46% vs 52%), rated most human-like by 60% of players | goal: **human-likeness, not strength** |
| [Argus](https://github.com/saworbit/argus) | vanilla-QuakeC GOAP bot with an MCP telemetry lab | a later body; its nav only covers dm2/3/4/6 (not in the shareware pak) |
| [Frogbot FBCA v2](https://github.com/DrLex0/quake-frogbots) | classic waypoint bot; e1m1/2/4/5 are covered | the body now, because it works on shareware maps |

**Nothing found** uses a calibrated typed-judgment model (Jev, launched
2026-09-15) as a bot's mind, gives each bot a managed release, or does any of
this in a browser Quake.

### Revisions to the design

1. **Jev does not answer numeric tactics.** Fight or retreat at 22 HP is a
   utility sum that Frogbot already does (a live probe came back with
   confidence 0.24). Jev owns the decisions code cannot make:
   - interpreting a human's order ("Ranger, cover me") as a typed goal
   - holding a grudge, i.e. a target chosen out of spite
   - deciding whether this moment deserves a line at all
   - breaking ties between near-equal options, in character
2. **Event-driven rather than 3 Hz:** call Jev on a frag, a death, being
   addressed, a quiet stretch, or a new item in view. That is roughly 10x fewer
   calls, so cents per match.
3. **Pre-generated line banks:** each bot keeps a few voiced lines per event
   type (frag, death, respawn), refilled in the background, so reactions play
   instantly. Live generation (about 1-1.4 s plus TTS) is kept for real
   conversation.
4. **Measure the goal:** a blind "which one is the human-like bot?" test, not
   frag counts.

## Plan

1. **Spike: DONE (2026-09-23).** Frogbot FBCA v2.0b4 plays e1m1 in
   three-quake. Three bots navigate, fight and frag (after 60 s the scoreboard
   read 1/2/1 against the player's 0). What it took:
   - six post-1996 builtins in `src/pr_ext.js`: infokey, stof, multicast,
     checkextension, strzone, strunzone
   - a `MSG_MULTICAST` write destination
   - a `?pak=` loader
   - `tools/build-frogbot-pak.sh`, which adds stand-ins for 7 registered-only
     assets when there is no pak1.pak

   Bots live in player edicts 2..maxplayers, with no `client_t`, so
   `svs.clients` does not see them. The browser build caps at 4 slots.
   Rerun with `node tools/frogbot-smoke.mjs`.
2. **Jev mind:** build a `bot-brain` Deno service next to npc-brain. First a
   mock backend, then real calls with `TYPESAFE_API_KEY` held on the server.
   Write unit tests for building the state and applying answers.
3. **Player releases:** extend `setup-releases.ts` with a `BOTS` roster.
4. **Solo "Jev plays":** point the same mind at the human's own slot (client 1)
   so Jev plays single-player unattended.

Blockers: a TypeSafe API key; and the platform TTS fix, since
`/api/v1/tts/generate` currently 500s for API-key callers.
