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

## Round 2 (the real 6-player cycle)
Started 2026-10-15 ~10:50 PDT: `RUN=r2-20261015`, same arms and settings as above, 30 matches x 3 min.
