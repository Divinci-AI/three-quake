// Pre-warm every question SHAPE an arm will see in a match, before any scored match. Some arms (the deciders) compile and cache a
// schema per question layout, and the first request of each new layout takes seconds (up to ~15 s measured), while the bot brain
// gives up after 5 s and falls back to plain Frogbot. Without this, those arms would be charged timeouts the others never see.
// Shapes: opponents 1..(players-1) for every persona, and for greedy also 0..12 items (the brain caps items at 12). Both option orders.
//   deno run --allow-net --allow-env --allow-read tools/arm-warm.ts --arm decider-4b --url http://127.0.0.1:8803 --players 5
import { askJev } from "../npc-brain/jev.ts";
import { type BotSituation, BOT_PERSONAS, buildQuestions, buildState, reversedSituation } from "../npc-brain/bots.ts";

function arg(name: string, def?: string): string {
  const i = Deno.args.indexOf(`--${name}`);
  if (i >= 0 && Deno.args[i + 1]) return Deno.args[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}
const arm = arg("arm"), url = arg("url").replace(/\/+$/, ""), players = Number(arg("players", "5"));
const cfg = { apiKey: Deno.env.get("MIND_ARMS_TOKEN") ?? "", url: `${url}/v1/systemone`, model: arm, timeoutMs: 300000, confidence: "concentration" as const };
const sit = (persona: string, k: number, items: number): BotSituation => ({
  mind: `arm:${arm}` as BotSituation["mind"], persona, bot: { name: "Bot", health: 80, armor: 0, weapon: "shotgun", frags: 2 },
  opponents: Array.from({ length: k }, (_, i) => ({ id: `p${i + 2}`, name: `Rival${i}`, frags: i, distance: 200 + 100 * i, killedMeRecently: i % 2 })),
  items: Array.from({ length: items }, (_, i) => ({ id: `i${i + 1}`, item: "armor", distance: 150 + 50 * i })),
});
let n = 0, slow = 0, worst = 0;
const t00 = performance.now();
for (const p of BOT_PERSONAS) {
  for (let k = 1; k <= Math.max(1, players - 1); k++) {
    for (let items = 0; items <= (p.key === "greedy" ? 12 : 0); items++) {
      const s = sit(p.key, k, items);
      for (const x of [s, reversedSituation(s)]) {
        const t0 = performance.now();
        await askJev(cfg, buildState(x, p), buildQuestions(x, p));
        const ms = performance.now() - t0;
        n++; worst = Math.max(worst, ms); if (ms > 2000) slow++;
      }
    }
  }
}
console.log(JSON.stringify({ arm, shapesRequests: n, slowOver2s: slow, worstMs: Math.round(worst), totalSec: Math.round((performance.now() - t00) / 1000) }));
