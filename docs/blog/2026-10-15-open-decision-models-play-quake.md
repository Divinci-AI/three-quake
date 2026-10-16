<!--
DRAFT, not published. Form chosen: (a) standalone post.
Why: the divinci.ai blog has two posts that mention Jev (the-question-a-classifier-cannot-answer, what-a-benchmark-has-to-prove-about-itself), but neither is about the Quake bots, so there is no Jev/Quake post to attach an addendum to. Nothing in ~/Documents/divinci.ai was edited.
Videos are hosted on the dedicated public R2 bucket divinci-quake-media (only these clips are in it).
Open question for the editor: the cost paragraph. See the note inside it.
-->

# Open decision models play Quake: a null result

We asked a simple question. Quake bots built on Frogbot already move, aim and fight. If a small open model chooses which opponent a bot hunts, does the bot get more frags?

After 180 matches the answer is that we cannot tell. No arm differs from plain Frogbot or from a random control, and every 95% interval spans zero. This post is about what we ran, what the intervals allow us to say, and what went wrong on the way.

Everything here is local and unsigned. It is not a TrustBench result and is not comparable with anything published.

## What we tried

Frogbot (written in QuakeC) handles the body: navigation, aim, dodging, firing. On top of it a "mind" picks which opponent the bot focuses on, given a persona (vindictive, greedy, showoff, cautious, bully) and the scoreboard. Six arms:

- **clef-flash**: Cloudflare Clef-flash 9B
- **decider-4b** and **decider-2b**: Mapika deciders
- **d3-edge**: vllm-sr d3-edge
- **off**: plain Frogbot
- **random**: picks among the same options at random, so "a model chose" is separated from "something intervened"

Jev, which we used in an earlier experiment, was not part of this tournament because it bills per call.

## Setup

- The four models ran on a Jetson AGX Orin, each as its own service, reached from a MacBook over an SSH tunnel.
- Quake (three-quake, our browser port) ran headless on the MacBook, six bots per match on E1M1, three minutes each.
- Fair design, written before any run: slot rotation, one persona block at a time, every arm followed once per persona in every slot. Six arms times five personas is 30 matches, one balanced cycle. Each arm played 30 matches.
- Every match records a demo from one bot's point of view, which is where the clips below come from.

## Result

Relative frags are a bot's frags minus the match average; intervals are a bootstrap over matches.

| arm | matches | relative frags | 95% interval | frags / deaths | K/D | ms per decision | model failures |
|---|---|---|---|---|---|---|---|
| decider-4b | 30 | +0.53 | [-0.65, +1.87] | 9.2 / 9.5 | 0.96 | 933 | 3 |
| clef-flash | 30 | +0.33 | [-0.84, +1.48] | 9.0 / 9.9 | 0.91 | 1686 | 6 |
| d3-edge | 30 | +0.23 | [-0.96, +1.46] | 8.9 / 9.3 | 0.95 | 517 | 3 |
| off (plain Frogbot) | 30 | -0.20 | [-1.15, +0.76] | 8.4 / 9.8 | 0.86 | - | 0 |
| decider-2b | 30 | -0.37 | [-1.24, +0.55] | 8.3 / 9.4 | 0.88 | 621 | 4 |
| random | 30 | -0.53 | [-1.47, +0.39] | 8.1 / 10.5 | 0.77 | - | 0 |

Every interval spans zero and overlaps all the others. The ordering (three model arms on top, random last) is what you would see if models helped a little, but the interval half-width is about 1.1 to 1.3 frags, so only an effect of that size or larger could have shown. This is not evidence of no effect. It is evidence that any effect is below roughly 1.2 frags per match. An earlier estimate put the number of matches needed to resolve +1.3 at about 184.

## Why the effect has little room

Each bot made about 19 decisions per match, roughly one every 10 seconds (minimum 11, maximum 28). Model failures were about 1% of calls (3 to 6 per arm out of roughly 560), and mean latency was well under the 5 second timeout, so the models did answer. Their answers just steer a bot a handful of times in three minutes, while Frogbot's body decides nearly everything else. With so few decisions, no choice of target can move the score much.

d3-edge answered "none" to 63% of questions in our pre-run spike, so under the confidence gate it mostly hands control back to Frogbot and should look like plain Frogbot. It does, within noise.

## What went wrong

1. **The first 30 matches were a three-bot pilot.** The engine capped a bot match at 3 bots plus the human, so "six-player" matches quietly had three. Our validity check only asked whether the bots that joined had decided. Each arm therefore faced only its two neighbours in the rotation. We kept those matches separately as a pilot (not in the table above) and fixed the engine limit. The arena should also assert that the joined bot count equals the planned count; that is still to do.
2. **Cold-start latency.** The deciders compile a schema for each new question layout, and the first request of a new layout took up to 14.7 s. The brain times out at 5 s and falls back to plain Frogbot, so the arm would have silently turned into the control. We warmed every question shape before scoring (between 24 s and 159 s per arm); after that the deciders' worst latency was under 0.5 s.
3. **Stalled pages.** Four of 34 round-2 attempts stalled the game clock while other jobs ran on the same laptop. We replayed them with the same plan, and the runner now aborts a stalled page after 90 s.

## Cost

The earlier Jev run billed per call. The game made about 925 Jev calls before the account's credits ran out, and the first version of that bot made about 66 calls per bot per match (the second version about 11). The four open arms here have no per-call fee: they cost electricity and a box that was otherwise idle.

[EDITOR: the dollar figure for the Jev run is not in the repo. The research notes list list-price input tokens ($0.042 per million) and a measured $0.0031 for 69 calls, which does not match a per-call price, and the notes record the account-level spend as not yet reconciled. Fill in the billed total from the TypeSafe dashboard before publishing; do not quote $0.042 per call or a total from memory.]

## What we would do next

- Raise the decision cadence for the free arms (a decision every 3 s rather than every 10 s), so a model's choices can matter more. That changes the design, so it is a decision, not a tweak.
- Run a second balanced cycle (about 1 hour 45 minutes) to roughly halve the interval, and plan for about 180 matches if we want to resolve +1.3 frags.
- Download the two arms that never ran (d3-nano and so1).

## Clips

Each clip is one bot's point of view for the full three-minute match. We have not watched them for this post, so the captions state only who the camera follows and the scoreboard numbers from the match record.

<figure>
<video controls preload="metadata" playsinline width="100%">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m00-vindictive-clef-flash-pov.webm" type="video/webm">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m00-vindictive-clef-flash-pov.mp4" type="video/mp4">
</video>
<figcaption>Match 0: the camera follows a vindictive bot driven by clef-flash, which finished with 8 frags and 6 deaths.</figcaption>
</figure>

<figure>
<video controls preload="metadata" playsinline width="100%">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m27-bully-decider-4b-pov.webm" type="video/webm">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m27-bully-decider-4b-pov.mp4" type="video/mp4">
</video>
<figcaption>Match 27: the camera follows a bully bot driven by decider-4b, which finished with 9 frags and 5 deaths.</figcaption>
</figure>

<figure>
<video controls preload="metadata" playsinline width="100%">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m23-cautious-decider-2b-pov.webm" type="video/webm">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m23-cautious-decider-2b-pov.mp4" type="video/mp4">
</video>
<figcaption>Match 23: the camera follows a cautious bot driven by decider-2b, which finished with 8 frags and 11 deaths.</figcaption>
</figure>

<figure>
<video controls preload="metadata" playsinline width="100%">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m13-showoff-d3-edge-pov.webm" type="video/webm">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m13-showoff-d3-edge-pov.mp4" type="video/mp4">
</video>
<figcaption>Match 13: the camera follows a showoff bot driven by d3-edge, which finished with 4 frags and 10 deaths.</figcaption>
</figure>

<figure>
<video controls preload="metadata" playsinline width="100%">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m09-greedy-off-pov.webm" type="video/webm">
  <source src="https://pub-d3a99f4ec43a4c498fb4bdeed57766a1.r2.dev/quake-tournament/2026-10-15/r2-m09-greedy-off-pov.mp4" type="video/mp4">
</video>
<figcaption>Match 9: the camera follows a greedy bot running plain Frogbot (no model), which finished with 11 frags and 11 deaths.</figcaption>
</figure>

Single matches are anecdotes: the plain-Frogbot clip has the most frags of the five and the d3-edge clip the fewest, which is exactly the kind of spread the intervals above say we cannot attribute to the arm.
