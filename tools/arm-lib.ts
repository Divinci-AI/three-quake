// Shared by arm-spike.ts and arm-warm.ts: seeded situations and the persona rules.
import { type BotSituation } from "../npc-brain/bots.ts";

// mulberry32: the same situations for every arm
export function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEAPONS = ["shotgun", "super shotgun", "nailgun", "rocket launcher", "lightning gun"];
const NAMES = ["Grunt", "Ogre", "Ranger", "Shambler", "Knight", "Zombie", "Fiend", "Scrag"];

export function makeSituation(r: () => number, persona: string, arm: string): BotSituation {
  const n = 2 + Math.floor(r() * 3); // 2..4 opponents
  const names = [...NAMES].sort(() => r() - 0.5).slice(0, n);
  const opponents = names.map((name, i) => ({
    id: `p${i + 2}`, name, frags: Math.floor(r() * 12), distance: 100 + Math.floor(r() * 1500), killedMeRecently: r() < 0.35 ? 1 + Math.floor(r() * 3) : 0,
  }));
  const items = persona === "greedy" ? [{ id: "i1", item: "megahealth", distance: 200 + Math.floor(r() * 800) }, { id: "i2", item: "red armor", distance: 100 + Math.floor(r() * 800) }, { id: "i3", item: "rocket launcher", distance: 100 + Math.floor(r() * 800) }] : [];
  return { mind: `arm:${arm}` as BotSituation["mind"], persona, bot: { name: "Bot", health: 20 + Math.floor(r() * 100), armor: Math.floor(r() * 150), weapon: WEAPONS[Math.floor(r() * WEAPONS.length)], frags: Math.floor(r() * 10) }, opponents, items };
}

// What a reader of the temperament would expect. null = the rule has no clear answer for this situation (not scored).
export function expected(s: BotSituation, persona: string): string | null {
  const o = s.opponents;
  const best = (f: (x: typeof o[0]) => number, dir: 1 | -1) => {
    const sorted = [...o].sort((a, b) => dir * (f(a) - f(b)));
    return sorted.length > 1 && f(sorted[0]) === f(sorted[1]) ? null : sorted[0].id;
  };
  switch (persona) {
    case "vindictive": return o.some((x) => x.killedMeRecently > 0) ? best((x) => x.killedMeRecently, -1) : null;
    case "showoff": return best((x) => x.frags, -1); // leader
    case "bully": return best((x) => x.frags, 1); // fewest frags
    case "cautious": { const lead = best((x) => x.frags, -1); return lead; } // scored as "must NOT pick the leader"
    default: return null; // greedy is judged on the item question, not here
  }
}

