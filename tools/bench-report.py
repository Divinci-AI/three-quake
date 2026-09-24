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
        # join slot: recorded since v2.1; before that, the perm gives it
        slot = b.get("slot") if b.get("slot") is not None else r["perm"].index(m)
        rec[m] = {"kills": kills_on_bots, "deaths": deaths_by_bots, "slot": slot, "persona": b["persona"], "pinned": r.get("persona"),
                  "held": b.get("focusHeldTicks", 0), "on": b.get("focusOnTargetTicks", 0)}
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
print(f"match length: {ok[0]['minutes']} min on {ok[0]['map']}; modes rotated over join slots")
rt = [r["realtime"] for r in ok if "realtime" in r]
if rt:
    print(f"game time vs wall time: min {min(rt):.2f}, mean {sum(rt) / len(rt):.2f} (1.00 = real time; below ~0.95 the machine was too loaded)")
print(f"design: items={ok[0].get('items', 'n/a')}, personas pinned={'yes' if ok[0].get('persona') else 'no (name-derived)'}\n")
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
# Join slot moves net frags about as much as the mind does (v2 pilot), and
# the design balances modes over slots, so remove each slot's mean before
# comparing. Same pairing, less noise; the raw comparison above stays primary.
net = lambda x: x["kills"] - x["deaths"]
slot_vals = defaultdict(list)
for rec in per_match:
    for m in MODES: slot_vals[rec[m]["slot"]].append(net(rec[m]))
slot_mean = {k: sum(v) / len(v) for k, v in slot_vals.items()}
print("join slot effect (mean bot-vs-bot net per match): " + ", ".join(f"slot {k + 1} {v:+.2f}" for k, v in sorted(slot_mean.items())))
for x, y in [("jev", "off"), ("jev", "random"), ("random", "off")]:
    diffs = [(net(r[x]) - slot_mean[r[x]["slot"]]) - (net(r[y]) - slot_mean[r[y]["slot"]]) for r in per_match]
    raw = [net(r[x]) - net(r[y]) for r in per_match]
    n = len(diffs); mean = sum(diffs) / n
    sd = (sum((d - mean) ** 2 for d in diffs) / (n - 1)) ** 0.5 if n > 1 else float("nan")
    rsd = (sum((d - sum(raw) / n) ** 2 for d in raw) / (n - 1)) ** 0.5 if n > 1 else float("nan")
    print(f"  slot-adjusted {x} vs {y}: mean {mean:+.2f} (sd {sd:.2f}, raw sd {rsd:.2f}), permutation p={perm_test(diffs):.3f}")
    if x == "jev" and y == "off" and mean != 0 and n > 1:
        need = math.ceil(((1.96 + 0.84) * sd / abs(mean)) ** 2)
        print(f"    matches for 80% power at this effect size: ~{need} (have {n})")
print()
print("jev minus off, net per match, by persona (all bots share one persona per match when pinned)")
by_p = defaultdict(list)
for r in per_match:
    if r["jev"]["pinned"]: by_p[r["jev"]["pinned"]].append(net(r["jev"]) - net(r["off"]))
for k, v in sorted(by_p.items()):
    print(f"  {k:10} n={len(v):2d} mean {sum(v) / len(v):+.2f}  {v}")
if not by_p: print("  (personas were not pinned in this run; see persona tables below)")
print()
print("focus adherence: while a focus is held, share of time Frogbot's enemy IS that focus")
for m in ("jev", "random"):
    h = sum(r[m]["held"] for r in per_match); o = sum(r[m]["on"] for r in per_match)
    print(f"  {m:7} " + (f"{o / h:.1%} of {h} ticks" if h else "(not recorded in this run)"))
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
