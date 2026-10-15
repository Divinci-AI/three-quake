#!/usr/bin/env python3
"""Report for a tools/bench-arena.mjs run:  python3 tools/bench-arena-report.py bench/results/<run>.jsonl [--boot 4000]
Per arm: matches, mean frags relative to the match mean (so a hot or cold match cannot favour whoever was in it),
frags/deaths, 95% bootstrap interval over MATCHES, mean decision latency, failures. Invalid matches are listed and excluded."""
import json, random, statistics as st, sys
from collections import defaultdict

def load(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    return [r for r in rows if "stats" in r and r.get("valid")], [r for r in rows if not r.get("valid") or "stats" not in r]

def per_arm(rows):
    rel, fr, de, slot = defaultdict(list), defaultdict(list), defaultdict(list), defaultdict(lambda: defaultdict(list))
    for r in rows:
        bots = [b for b in r["stats"]["bots"] if b.get("isBot")]
        mean = st.mean(b["frags"] for b in bots)
        for b in bots:
            rel[b["mode"]].append((r["match"], b["frags"] - mean)); fr[b["mode"]].append(b["frags"]); de[b["mode"]].append(b["deaths"])
            slot[b["mode"]][b["slot"]].append(b["frags"] - mean)
    return rel, fr, de, slot

def boot_ci(vals, n=4000, seed=1):
    rnd = random.Random(seed)
    means = sorted(st.mean(rnd.choices(vals, k=len(vals))) for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n)]

def main():
    path = sys.argv[1]
    good, bad = load(path)
    print(f"{path}: {len(good)} valid matches, {len(bad)} invalid/failed")
    for r in bad: print("  excluded match", r.get("match"), "-", r.get("error") or ("dead arms: " + ",".join(r.get("deadArms", []))))
    if not good: return
    rel, fr, de, slot = per_arm(good)
    lat = defaultdict(lambda: [0, 0, 0])
    for r in good:
        for arm, a in (r.get("arms") or {}).items():
            k = "arm:" + arm; lat[k][0] += a["calls"] - a["failures"]; lat[k][1] += a["ms"]; lat[k][2] += a["failures"] + a.get("busy", 0)
    print(f"\n{'arm':18} {'n':>3} {'rel.frags':>10} {'95% CI':>17} {'frags':>6} {'deaths':>6} {'K/D':>5} {'ms/dec':>7} {'fail+busy':>9}")
    for arm in sorted(rel, key=lambda a: -st.mean(v for _, v in rel[a])):
        vals = [v for _, v in rel[arm]]
        lo, hi = boot_ci(vals) if len(vals) > 1 else (float("nan"),) * 2
        k = lat.get(arm); ms = f"{k[1] / k[0]:.0f}" if k and k[0] else "-"
        print(f"{arm:18} {len(vals):>3} {st.mean(vals):>+10.2f} {f'[{lo:+.2f}, {hi:+.2f}]':>17} {st.mean(fr[arm]):>6.1f} {st.mean(de[arm]):>6.1f} {sum(fr[arm]) / max(1, sum(de[arm])):>5.2f} {ms:>7} {(k[2] if k else 0):>9}")
    print("\nreading it: rel.frags = frags minus the match average. Intervals that overlap zero or each other are NOT differences.")
    print("with these match counts only large effects show; the pilot of the earlier benchmark needed ~184 matches for a +1.3 effect.")

if __name__ == "__main__":
    main()
