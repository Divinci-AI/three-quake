# Jev in Quake: research notes

A running lab notebook for the Quake + Jev blog post: what we tried, what we
measured, and what surprised us. Design rationale lives in
[JEV_BOTS.md](JEV_BOTS.md). This file is for what actually happened.

Conventions: every number comes from a log or a results file named next to
it. "Measured" means counted by our code; "reported" means TypeSafe's own
`usage.input_tokens`; anything else is marked as an estimate.

---

## Setup, in one paragraph

three-quake (mrdoob's Three.js port of Quake) runs in the browser. Frogbot
(FBCA v2, GPL) is the bot **body**: it navigates, aims and fights at tick
rate. Jev (TypeSafe's System One model) is the bot **mind**: it answers typed
questions about whom a bot's personality wants to fight and what it wants to
grab. A Divinci release per personality is the bot's **voice** (Workers AI
text + Aura-2 TTS). The mind writes four QuakeC fields (`jev_enemy`,
`jev_goal` and their expiries) through a ~20-line patch to Frogbot, so a
silent or slow mind hands control straight back to Frogbot's planner.

## 2026-09-18 → 09-23: getting it running (dogfooding findings)

Monsters talking to the player came first, then bots. Wiring it up found
real Divinci platform bugs, fixed and deployed to production the same day:

- v1 API release create returned a bare 400 "bad form data": two required
  fields were undocumented, and the error hid which ones.
- Workers AI replies that were *entirely* valid JSON crashed the Cloudflare
  generator on `.trim()`, surfacing as "Failed communicating with AI" inside
  a normal-looking 200 reply. Workaround in the game: a tagged
  `ACTION:` / `LINE:` reply format instead of JSON.
- TTS returned no URL for any line shorter than 100 characters (the cache
  threshold also gated publishing). Bot barks are short, so every one was
  silent.
- The CLI printed `undefined` for a rotated API key's secret.

Engine-side, three-quake needed six QuakeC extension builtins for Frogbot to
load at all, and a server fix to make bots visible: bots occupy player slots
with no client, and the QW-style player update skipped them, so bots were
invisible until they died and left a corpse.

## 2026-09-23: v1 mind, and the first benchmark attempt

v1 asked Jev every **2.5 s per bot**, three questions per call (`focus`
choice, `goal` choice, `taunt_now` noul), and each answer expired after 4 s.

The benchmark puts three bots in each match: one on Jev, one plain Frogbot
(`off`), and one `random` control. The random bot overrides Frogbot from the
same options at Jev's own measured rate. Without that control, "Jev beats
Frogbot" could just mean "intervening beats not intervening". Join order
rotates through all six permutations, and the human observer is invisible
to the bots.

The first run died immediately: TypeSafe answered **402, organization has no
available credits**. The game had made about 925 Jev calls in total up to
then. Things added because of it:

- The brain trips a 5-minute circuit breaker on 402/401 instead of failing
  every decision.
- The runner probes Jev first. It aborts any match whose Jev bot made zero
  decisions, because otherwise a dead mind quietly turns the benchmark into
  Frogbot vs Frogbot.

## 2026-09-24: the "$5 a minute" scare, and what the numbers said

The benchmark was restarted and then stopped after one match, on a concern
that it was spending about $5 a minute. From the brain log (TypeSafe's
reported usage):

| | value |
|---|---|
| successful Jev calls | 69 |
| input tokens | 73,645 (about 1,067 per call) |
| cost at list price ($0.042 / Mtok input, output free) | **$0.0031** |
| timeouts (2.5 s client limit) | 7, all in the last few seconds before shutdown |

Upper bound: the published rate limit is 250k tokens/s per key, so one key
cannot spend more than about $0.63 a minute even flat out. The $5 figure
must come from somewhere else, and other consumers share the TypeSafe
account (two scheduled Hermes jobs and the monorepo's Jev benchmarks). Not
yet reconciled against the TypeSafe dashboard. **Lesson for the post:** log
the provider's own usage numbers from call one, so a cost question can be
answered from data instead of from memory.

### Match 1 (v1)

`bench/results/bench-48daa09-20260923-2311.jsonl`, E1M1, 3 minutes:

| mind | frags | deaths | decisions | goal overrides applied |
|---|---|---|---|---|
| off (plain Frogbot) | **10** | **0** | 0 | 0 |
| jev | 3 | 8 | 66 | 64 |
| random | 4 | 8 | 66 | 66 |

One match is an anecdote. The mechanism behind it is not: **the Jev bot's
goal changed on 34 of 69 consecutive decisions.** Re-asked every 2.5 s with
a 4 s expiry, the bot was re-routed before it could reach anything. The
random control, overriding just as often, did just as badly. That points at
the override *mechanism*, not at Jev's judgment. Frogbot's item routing is
good. Interrupting it every few seconds is what hurt.

A second, smaller bug: engine and brain hashed *different* strings for a
bot's personality. The engine kept Quake's charset control bytes
(`GENERAL\x05fA\x13lURe`); the brain stripped them. Now both hash the same
cleaned name (gold digits → `0-9`, brackets kept, control bytes dropped).

## 2026-09-24: v2 mind: ask less, and let decisions stick

Design changes, each aimed at a finding above:

1. **Ask on events, not on a timer.** A bot asks when it respawns, right
   after its own frag, and otherwise at most every 30 s. It also has a hard
   **budget of 20 decisions per match**, which the random control obeys too.
2. **Commit.** A decision holds until the next one (35 s TTL). It is
   released early the moment its target dies or its item is taken, so the
   bot is never steered at a corpse or an empty spawn point.
3. **Ask only what Jev is for.** `focus` (grudges, personality) is always
   asked. `goal` is asked **only for the greedy personality**, and only
   about high-value items: red and yellow armour, rocket launcher,
   thunderbolt, powerups, megahealth. `taunt_now` is gone: when a bot talks
   is now a game-event rule in code (frag, death, cooldowns). Fewer questions
   and a smaller state mean fewer input tokens per call.
4. **Spend accounting built in.** The brain exposes `GET /bot/usage`
   (calls, reported input tokens, failures). The runner records it per match
   and stops at a token cap (default 2M tokens, about $0.08 at list price).
   The brain's own ceiling dropped from 5,000 to 500 calls per process.

Expected: about 10–20 calls per Jev bot per 3-minute match, against 72 in
v1 (an estimate, to be checked by the pilot). New per-bot stats tell us
whether the thrash is gone: `goalSwitches`, `triggers` (spawn / frag /
refresh) and `budgetExhausted`.

### Pilot (6 matches, one of each join permutation)

_Pending: results go here._
