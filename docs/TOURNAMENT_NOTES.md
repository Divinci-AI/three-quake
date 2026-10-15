# Decision-model tournament: research notes (kept while running)

Everything here is **unsigned, local**: the decision models run on a Jetson AGX Orin 64 GB (JetPack 7.2.1), the game and the bots on a MacBook, matches played headless. Not a TrustBench result, not comparable with anything published. Jev is excluded (about $0.042 per call).

## Setup as run (2026-10-15)
- Arms on the Jetson, one `dm@<arm>` systemd service each (loopback only, `IPAddressDeny=any` except 127/8, sandboxed, not enabled at boot): `clef-flash` (Cloudflare Clef-flash 9B), `decider-4b`, `decider-2b` (Mapika deciders), `d3-edge` (vllm-sr d3-edge). `d3-nano` and `so1` were never downloaded, so they are not in round 1. `llama-server` was stopped for the duration (announced to the other sessions on the laptop); about 24 GB RAM stayed available with all four resident.
- Reached from the laptop through a LaunchAgent SSH tunnel (`com.divinci.orin-tunnel`, ports 8802-8805), not through the HTTPS proxy: the proxy's self-signed certificate is flagged CA:TRUE and Deno's TLS stack refuses it (`CaUsedAsEndEntity`); reissuing it would break the pinned copies on other machines. The `/dm/<arm>/` nginx routes are deployed and answer curl (verified), for non-Deno clients.
- Brain on the laptop with `MIND_ARMS` pointing at the tunnel, default 5 s per-call timeout. Controls: `off` (plain Frogbot) and `random`.
- Fair design (unchanged, written before any run): slot rotation, persona block per cycle, every arm followed once per N matches. 6 arms x 5 personas = 30 matches is one fully balanced cycle. Round 1 = that cycle, 3 minutes per match, POV demo recorded in every match.

## Spike (tools/arm-spike.ts, the real brain questions, both option orders, 60 seeded situations = 120 calls per arm)
| arm | ok | latency p50 / p95 / max | valid choices | answer changes when options are reversed | picks "none" | persona-consistent (fwd / rev, n=38) |
|---|---|---|---|---|---|---|
| clef-flash | 100% | 522 / 674 / 687 ms | 100% | 21.7% | 5% | 68% / 61% |
| decider-4b | 95.8% cold, 100% warm | 193 / 440 / 3.9 s cold; 192 / 403 / 442 warm | 100% warm | 25% (26.7% warm) | 1.7% | 70% / 76% |
| decider-2b | 97.5% cold, 100% warm | 78 / 279 / 14.7 s cold; 78 / 272 / 356 warm | 100% warm | 12.1% (13.3% warm) | 0% | 68% / 76% |
| d3-edge | 100% | 67 / 139 / 913 ms | 100% | 41.7% | **63%** | 26% / 34% |

"Persona-consistent" is a crude rule check (vindictive -> most recent killer, showoff -> leader, bully -> fewest frags, cautious -> not the leader), not strength. The rules are not scored when they have no clear answer, so n is 38 of 60.

Findings that change how the arena must be run:
1. **Cold question shapes.** The deciders compile a schema per question layout; the first request of each new layout took up to 14.7 s, past the brain's 5 s timeout, which would silently turn into plain Frogbot for that arm. Clef also had cold shapes (worst 2.8 s). `tools/arm-warm.ts` walks every shape (1..players-1 opponents per persona; 0..12 items for greedy; both orders) before scoring. Measured warm-up: Clef 159 s, decider-4b 121 s, decider-2b 70 s, d3-edge 24 s. After warming, zero failures and max latency under 0.5 s on the deciders.
2. **d3-edge mostly abstains.** It answers "none" 63% of the time, so under the confidence gate it largely hands control to Frogbot and should look like the `off` control. That is a result about this arm on this question, not an error.
3. **Few decisions per match.** In the one-minute smoke match the bots made 3-5 decisions each (spawn/frag/refresh triggers). Over 3 minutes that is roughly 10-15, so a model's influence on frags is small and match-to-match noise will be large. Round 1 uses the pre-agreed cadence; whether to raise the refresh rate for these free arms is a decision for the next round, to be made from round 1's confidence intervals, not before.
4. Dependency review before running third-party model code: the Clef (`joint_schema_model.py`) and decider (`decider/*.py`) packages have no subprocess, socket or HTTP use; the unit confines them to loopback anyway.

## Round "1" was a 3-bot pilot, not the 6-player tournament (found 2026-10-15 ~10:45)
The engine caps a bot match at **3 bots + the human**: `Host_FindMaxClients` hard-codes `maxclients = 1` with a client limit of 4 and the web build has no `-listen`, so `botmatch map 6` quietly added only 3 bots (confirmed with a direct bot-count test; the first three slots of the rotated arm list joined). The arena's own validity check never noticed because it only checks that the bots that joined decided. Consequences for the 30 matches of `r1-20261015` (+3 replays in `r1-20261015-redo`): each arm played 15 matches against its two cyclic neighbours only, so arm strength is confounded with who it happened to face. Treat it as a **pilot**.
Pilot result (30 valid matches; 3 matches first failed because the laptop was starved by other sessions' builds and local models, and were replayed with the same plan via the new `ONLY=` option): relative frags per arm d3-edge +0.71 [-0.38, +1.69], clef-flash +0.24 [-0.56, +1.09], decider-2b +0.16 [-0.60, +1.02], decider-4b -0.27 [-0.84, +0.29], random -0.40 [-0.98, +0.13], off -0.44 [-1.36, +0.44]. **Every interval spans zero: no difference detectable at this size**, as the earlier benchmark's pilot predicted. d3-edge's nominal lead comes from a model that mostly abstains, which fits it behaving like plain Frogbot and being the arm that happened to face weaker neighbours.
Fix: `?maxclients=N` page parameter raises the startup limit (default unchanged, max 16); `bench-arena.mjs` now passes `maxclients=N+1`. 91 repo tests pass; a 6-bot diagnostic shows all six join. The arena should also assert the joined bot count equals N (to do).

## Round 2 (the real 6-player cycle) - finished 2026-10-15 ~13:10 PDT
`RUN=r2-20261015` (matches 1-15 and 18) plus `r2b-20261015` (the remaining 14 plus replays, with the new fail-fast runner after 4 stalled matches). 30 valid matches, 30 per arm, 6 bots per match, balanced cycle (every arm in every slot with every persona once), 3 min each, POV demo recorded in every match.

| arm | matches | relative frags | 95% CI (bootstrap over matches) | frags / deaths | K/D | ms per decision | model failures |
|---|---|---|---|---|---|---|---|
| decider-4b | 30 | +0.53 | [-0.65, +1.87] | 9.2 / 9.5 | 0.96 | 933 | 3 |
| clef-flash | 30 | +0.33 | [-0.84, +1.48] | 9.0 / 9.9 | 0.91 | 1686 | 6 |
| d3-edge | 30 | +0.23 | [-0.96, +1.46] | 8.9 / 9.3 | 0.95 | 517 | 3 |
| off (plain Frogbot) | 30 | -0.20 | [-1.15, +0.76] | 8.4 / 9.8 | 0.86 | - | 0 |
| decider-2b | 30 | -0.37 | [-1.24, +0.55] | 8.3 / 9.4 | 0.88 | 621 | 4 |
| random | 30 | -0.53 | [-1.47, +0.39] | 8.1 / 10.5 | 0.77 | - | 0 |

**Result: no arm is distinguishable from plain Frogbot or from the random control; every interval spans zero and overlaps all the others.** The ordering (decider-4b, clef-flash, d3-edge on top; random last) is what one would expect if models helped a little, but at 30 matches per arm the interval half-width is about 1.1-1.3 frags, so only an effect of that size or larger could have shown. The earlier benchmark's pilot estimated ~184 matches to resolve +1.3. Not evidence of "no effect", evidence that the effect, if any, is below ~1.2 frags per match.
Facts that bound what a model can do here: each bot made about 19 decisions per match (one per ~10 s; min 11, max 28), model failures were ~1% (3-6 per arm in ~560 calls), and mean latency was far below the 5 s timeout. So the arms did answer; their answers just moved frags little over a 3-minute game. K/D separates the random control (0.77) from the rest a little more than frags do.

Process notes: 4 of 34 round-2 attempts stalled the game clock under laptop load (other sessions' prod builds and local models ran concurrently); they were replayed with the same plan. The runner now aborts a stalled page after 90 s, records page errors, and retries once. The first 30 matches of the day were a 3-bot pilot (section above) and are kept separately in the database (`arena-r1-pilot-3bot-20261015`; round 2 is `arena-r2-20261015`).

## What to decide next (not done)
- More matches (a second balanced cycle, ~1h45m) would roughly halve the interval; ~180 matches would be needed to resolve +1.3.
- Or raise the decision cadence for the free arms (decisions every ~3 s instead of ~10 s) so a model's choices can matter more. That changes the design, so it is a decision, not a tweak.
- `d3-nano` and `so1` still need downloading before they can enter.
