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

Run `pilot-v2-b20c4ca-20260924-0019` (commit `b20c4ca`), E1M1, 6 × 3 min,
one match per join-order permutation. Zero failed calls, zero failed
matches.

**Cost: the goal was met by a wide margin.**

| | v1 (match 1, 09-23) | v2 pilot (mean of 6) |
|---|---|---|
| Jev calls per Jev bot per match | 66 | 11.3 |
| input tokens per call | ~1,067 | ~646 |
| input tokens per match | ~70,000 | 7,432 |
| whole run | — | 69 calls, 44,589 tokens, **$0.0019** |

About 6× fewer calls and 1.7× fewer tokens per call, so roughly 10× less
per match. The budget of 20 was never reached (0 of 6 bot-matches). Almost
every decision came from an event: respawns and own frags, with the 30 s
refresh rarely firing. A full 30-match run would cost about a cent at list
price.

**Skill: the direction favours Jev, but nothing is significant yet.**

| mind | kills/min | deaths/min | K/D | suicides |
|---|---|---|---|---|
| jev | 1.56 | 1.17 | **1.33** | 0 |
| off (Frogbot) | 1.11 | 1.17 | 0.95 | 2 |
| random control | 0.94 | 1.28 | 0.74 | 4 |

- Jev vs off, net frags per match: +1.33, with Jev better in 3 matches,
  worse in 1 and tied in 2 (permutation p = 0.75).
- Jev vs random: +2.17 (p = 0.57).

With six matches that is noise-compatible. The honest summary for the
post: v1 made the bots *worse* than Frogbot; v2 no longer does, and leans
the other way.

**Findings that change the full benchmark's design:**

1. **Join slot matters about as much as the mind does.** Mean net frags
   per match by join slot: slot 1 −1.83, **slot 2 +2.00**, slot 3 −2.17.
   That's roughly the same size as the Jev vs Frogbot difference, most
   likely from E1M1's deathmatch spawn points. Rotating modes over slots
   (which we do) keeps it out of the averages, but it adds a lot of
   variance. A real result needs either many more matches or analysis with
   slot as a covariate.
2. **Persona is confounded with mind.** A bot's personality comes from its
   Frogbot-assigned name, so the Jev bot was greedy 3 times, show-off twice
   and cautious once. Its two best matches (8/3 and 9/1) were both
   "Superman", a show-off. We can't yet separate "Jev helps" from "Jev
   helps the show-off". The next run should rotate personas across minds
   deliberately.
3. **Item steering still costs the greedy bot pickups.** Greedy bots made
   1.50 high-value pickups/min on plain Frogbot, but only 0.56/min under
   Jev. The greedy Jev bot's goal changed on 12 of the 24 times one was
   set. Because v2 decides only on events, some of those switches are
   legitimate (a respawn means a new position). Even so, Frogbot's own item
   routing still beats our override. The next variant to test: focus only,
   with no item goals for any personality.
4. **Grudges look real for the greedy personality.** Share of time spent
   fighting whoever last killed it: greedy/jev 65.7% against 50.8% chance,
   and greedy/off 24.5%. Other personalities are near chance. That's
   suggestive only, with n = 1 to 3 bot-matches per cell.

Result files: `docs/data/pilot-v2-b20c4ca-20260924-0019.jsonl` and the v1
match in `docs/data/bench-48daa09-20260923-2311.jsonl` (copied out of the gitignored `bench/results/`).

## 2026-09-24: v2.1: fixing the benchmark before trusting it

The pilot measured the mind, but it also measured the benchmark, and the
benchmark had problems. Changes, each tied to a finding:

| finding | change |
|---|---|
| persona came from the Frogbot name, so it was confounded with mind | `bot_mind_personas` pins them; the brain accepts the engine's key (validated) |
| we could not compare minds like for like | **all three bots in a match share one persona** |
| persona and join order both needed balancing | match *m* gets permutation *m* mod 6 and persona *m* mod 5. 6 and 5 are coprime, so every 30 consecutive matches contain each (order, persona) pair exactly once, interleaved, so time drift cannot pose as a persona effect |
| item steering cost greedy bots pickups | `bot_mind_goals` (default **off**); the run below is **focus-only** |
| join slot moves net frags as much as the mind | the report adds a slot-adjusted comparison: remove each slot's mean, same pairing |
| "does the override even change behaviour?" | new mechanism stat: while a focus is held, how often is Frogbot's actual enemy that focus |
| a Jev *timeout* was applied as "no preference", wiping the held focus and counting as a Jev decision | fallbacks are no longer applied; counted as `mindFailures` |
| too few matches per hour for the power we need | matches run concurrently (`CONCURRENCY`), with spend charged per match by URL tag, and game-vs-wall speed recorded per match (read inside the page) |

Smoke tests (3 × 1-minute matches, concurrency 3): personas pinned, zero
item goals, per-match spend correct. **Focus adherence was 71–97%**: while
Jev's focus is held, Frogbot really is fighting that bot most of the time.
The mechanism works. Game speed was 0.95–0.98 of real time at concurrency 3,
and exactly 1.00 for a single match. Jev latency: p50 172 ms, slowest
success 1.28 s. 2 of 14 calls hit the old 2.5 s timeout, so the run uses 5 s.

### Stepping back: what this benchmark can and cannot show

- **Power is the main constraint.** Pilot, slot-adjusted: the Jev-minus-
  Frogbot net-frag difference has an SD of about 6.5 per match. To detect the
  pilot's +1.3 with 80% power needs about **184 matches**. 30 matches would
  most likely come out "not significant" even if the effect is real, and
  that result would look like evidence against Jev.
- **With three bots, "focus" is a two-way choice.** Each bot has exactly
  two opponents, and the random control flips a coin between them. Target
  selection has much more room to matter in bigger matches (`botmatch` is
  capped at 3 bots today). Worth a follow-up; out of scope for this run.
- **Single map.** Shareware E1M1 is a single-player map with a handful of
  deathmatch spawn points, and it's probably the source of the join-slot
  effect. The rest of episode 1 (e1m2–e1m8) is also shareware and a natural
  follow-up.
- **Skill is fixed** at Frogbot skill 5 for all bots. Jev might matter more,
  or less, against stronger or weaker bodies.
- **What a positive result would mean:** "Choosing whom to fight by
  personality and grudges, via Jev, beats Frogbot's own target choice at
  this skill on this map." If Jev also beats *random*, the choices
  themselves matter, not just the act of intervening.

### Run plan (written before the run)

- **Code:** commit recorded in the run name.
- **Condition:** focus-only (`ITEMS=0`), one pinned persona per match,
  budget 20 decisions per bot per match, 3-minute matches, E1M1,
  concurrency 3, Jev timeout 5 s.
- **n = 180 matches**, six complete (order × persona) cycles. Fixed in
  advance. Progress is watched, but results are not used to stop early.
- **Primary endpoint:** Jev vs off, per-match net bot-vs-bot frags
  (kills − deaths), paired two-sided permutation test, α = 0.05.
- **Secondary:** Jev vs random; the slot-adjusted versions of both; focus
  adherence; cost per match.
- **Exploratory only:** per-persona effects, grudge adherence.
- **Exclusions,** reported with counts: matches that errored, matches whose
  Jev bot got zero Jev decisions, matches with game speed below 0.90 of real
  time.
- **Spend limits:** brain ceiling raised to 3,000 calls for this run;
  runner token cap 2M. Expected: about 2,000 calls, about 1.2M input
  tokens, **about $0.05**, and about 3.3 hours of wall time.
