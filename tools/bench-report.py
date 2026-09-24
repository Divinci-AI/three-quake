#!/usr/bin/env python3
"""Report for tools/bench-bots.mjs results: bench-report.py bench/results/<run>.jsonl

Skill: bot-vs-bot kills and deaths only (the human observer is excluded), per
3-way match, compared per pair of minds with an exact two-sided sign test
and a paired permutation test on per-match kill differences.
Claims: grudge adherence (share of samples where a bot fights the one who last
killed it, vs the chance rate), and high-value pickups per minute by persona.
"""
import json, sys, random, math
from collections import defaultdict

rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ok = [r for r in rows if "stats" in r and r.get("valid", True) and len([b for b in r["stats"]["bots"] if b["isBot"]]) == 3]
failed = len(rows) - len(ok)
MODES = ["jev", "off", "random"]
clean = lambda s: "".join(chr(ord(c) & 127) for c in s if 32 <= (ord(c) & 127) < 127)

per_match = []  # {mode: {kills, deaths, minutes}}
agg = {m: defaultdict(float) for m in MODES}
persona_pick = defaultdict(lambda: defaultdict(float))
for r in ok:
    bots = [b for b in r["stats"]["bots"] if b["isBot"]]
    bot_names = {b["name"] for b in bots}
    minutes = r["minutes"]
    rec = {}
    for b in bots:
        m = b["mode"]
        # bot-vs-bot only: deaths caused by bots; kills = times a BOT named this one as killer
        deaths_by_bots = sum(v for k, v in b["killedBy"].items() if k in bot_names)
        kills_on_bots = sum(o["killedBy"].get(b["name"], 0) for o in bots if o is not b)
        rec[m] = {"kills": kills_on_bots, "deaths": deaths_by_bots}
        a = agg[m]
        a["kills"] += kills_on_bots; a["deaths"] += deaths_by_bots; a["minutes"] += minutes
        a["frags_raw"] += b["frags"]; a["suicides"] += b["suicides"]
        a["grudge_samples"] += b["grudgeSamples"]; a["grudge_on"] += b["grudgeOnKiller"]; a["grudge_chance"] += b["grudgeChance"]
        a["decisions"] += b["decisions"]; a["focus"] += b["focusApplied"]; a["goal"] += b["goalApplied"]
        for cat, n in b["pickups"].items():
            a["pick_" + cat] += n
            persona_pick[(b["persona"], m)][cat] += n
        persona_pick[(b["persona"], m)]["minutes"] += minutes
        persona_pick[(b["persona"], m)]["grudge_samples"] += b["grudgeSamples"]
        persona_pick[(b["persona"], m)]["grudge_on"] += b["grudgeOnKiller"]
        persona_pick[(b["persona"], m)]["grudge_chance"] += b["grudgeChance"]
    per_match.append(rec)

def sign_test(diffs):
    pos = sum(d > 0 for d in diffs); neg = sum(d < 0 for d in diffs); n = pos + neg
    if n == 0: return pos, neg, 1.0
    k = min(pos, neg)
    p = sum(math.comb(n, i) for i in range(0, k + 1)) / 2 ** n * 2
    return pos, neg, min(1.0, p)

def perm_test(diffs, iters=20000, seed=7):
    rnd = random.Random(seed); obs = abs(sum(diffs)); hits = 0
    for _ in range(iters):
        if abs(sum(d if rnd.random() < 0.5 else -d for d in diffs)) >= obs - 1e-9: hits += 1
    return hits / iters

print(f"matches analysed: {len(ok)}  (failed/incomplete: {failed})")
if not ok: sys.exit(0)
print(f"match length: {ok[0]['minutes']} min on {ok[0]['map']}; modes rotated over join slots\n")
print("SKILL (bot-vs-bot only)")
print(f"{'mind':8} {'kills/min':>10} {'deaths/min':>11} {'K/D':>6} {'suicides':>9}")
for m in MODES:
    a = agg[m]; mins = a["minutes"] or 1
    kd = a["kills"] / a["deaths"] if a["deaths"] else float("inf")
    print(f"{m:8} {a['kills']/mins:10.3f} {a['deaths']/mins:11.3f} {kd:6.2f} {int(a['suicides']):9d}")
print()
for x, y in [("jev", "off"), ("jev", "random"), ("random", "off")]:
    diffs = [(pm[x]["kills"] - pm[x]["deaths"]) - (pm[y]["kills"] - pm[y]["deaths"]) for pm in per_match if x in pm and y in pm]
    pos, neg, ps = sign_test(diffs); pp = perm_test(diffs)
    mean = sum(diffs) / len(diffs)
    print(f"{x} vs {y}: net (kills-deaths) per match, mean diff {mean:+.2f}; {x} better in {pos}, worse in {neg}, tied {len(diffs)-pos-neg}; sign p={ps:.3f}, permutation p={pp:.3f}")
print()
print("DOES THE MIND DO WHAT IT CLAIMS")
print(f"{'mind':8} {'overrides applied (focus/goal of decisions)':44}")
for m in MODES:
    a = agg[m]
    if a["decisions"]:
        print(f"{m:8} focus {a['focus']/a['decisions']:.0%}, goal {a['goal']/a['decisions']:.0%} of {int(a['decisions'])} decisions")
    else:
        print(f"{m:8} (no decisions: Frogbot's own planner)")
print()
print("grudge adherence = share of time fighting whoever last killed you (vs chance)")
for (persona, m), v in sorted(persona_pick.items()):
    if v["grudge_samples"]:
        print(f"  {persona:10} {m:7} {v['grudge_on']/v['grudge_samples']:6.1%}  (chance {v['grudge_chance']/v['grudge_samples']:.1%}, n={int(v['grudge_samples'])})")
print()
print("COST (Jev, measured by npc-brain from TypeSafe's reported usage)")
jc = [r["jevUsage"] for r in ok if r.get("jevUsage")]
if jc:
    calls = sum(u["calls"] for u in jc); tok = sum(u["inputTokens"] for u in jc)
    print(f"  {calls} calls, {tok} input tokens over {len(jc)} matches: {calls/len(jc):.1f} calls and {tok/len(jc):,.0f} tokens per match, ~${tok*0.042/1e6:.4f} at $0.042/Mtok")
    print(f"  {sum(u['failures'] for u in jc)} failed calls")
sw = {}
for r in ok:
    for b in r["stats"]["bots"]:
        if b.get("mode") in ("jev", "random") and "goalSwitches" in b:
            a = sw.setdefault(b["mode"], [0, 0, 0, 0, 0])
            a[0] += b["decisions"]; a[1] += b["goalApplied"]; a[2] += b["goalSwitches"]; a[3] += 1 if b.get("budgetExhausted") else 0; a[4] += 1
for m, (d, g, s_, ex, n) in sorted(sw.items()):
    print(f"  {m:7} {d/n:.1f} decisions/bot/match, goal set {g}x, goal SWITCHED {s_}x, budget exhausted in {ex}/{n} bot-matches")
print()
print("high-value pickups per minute, by persona and mind")
for (persona, m), v in sorted(persona_pick.items()):
    mins = v["minutes"] or 1
    tot = sum(v[c] for c in ("armor", "megahealth", "weapon", "powerup"))
    print(f"  {persona:10} {m:7} {tot/mins:.2f}/min  (armor {int(v['armor'])}, mega {int(v['megahealth'])}, weapon {int(v['weapon'])}, powerup {int(v['powerup'])}, {mins:.0f} min)")
