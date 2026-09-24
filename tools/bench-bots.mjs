// Bot benchmark: Jev vs plain Frogbot vs a random control, one bot of each
// per match, rotating which join slot gets which mind. Writes one JSON line
// per match to bench/results/<run>.jsonl; analyse with tools/bench-report.py.
//
//   MATCHES=30 MINUTES=3 MAP=e1m1 node tools/bench-bots.mjs
//
// Needs: `deno task web`, frogbot.pak, and npc-brain running with a
// TYPESAFE_API_KEY (otherwise the "jev" bot silently gets no decisions; the
// runner refuses to start in that case).
import { createRequire } from "node:module";
import { mkdirSync, appendFileSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? "/Users/michael/Documents/server/workspace/clients/tests/package.json");
const { chromium } = require("@playwright/test");

const MATCHES = Number(process.env.MATCHES ?? 30);
const MINUTES = Number(process.env.MINUTES ?? 3);
const MAP = process.env.MAP ?? "e1m1";
const BASE = process.env.BASE ?? "http://127.0.0.1:8093/";
const RUN = process.env.RUN ?? new Date().toISOString().replace(/[:.]/g, "-");
const OUT = `bench/results/${RUN}.jsonl`;
const BUDGET = Number(process.env.BUDGET ?? 20); // Jev decisions per bot per match
// Item steering for greedy bots: off unless ITEMS=1 (it cost pickups in the v2 pilot).
const ITEMS = process.env.ITEMS === "1" ? 1 : 0;
// One persona for ALL three bots in a match, so the minds are compared like
// for like. Match m gets perm m%6 and persona m%5: 6 and 5 are coprime, so
// every 30 consecutive matches contain each (perm, persona) pair exactly once,
// interleaved rather than in blocks (time drift cannot masquerade as persona).
const PERSONAS = (process.env.PERSONAS ?? "vindictive,greedy,showoff,cautious,bully").split(",").filter(Boolean);
// Stop the whole run once the brain has spent this many Jev input tokens.
// At the published $0.042/Mtok, 2,000,000 tokens is about $0.08.
const MAX_RUN_TOKENS = Number(process.env.MAX_RUN_TOKENS ?? 2_000_000);
const USAGE_URL = "http://127.0.0.1:8797/bot/usage";
const usage = () => fetch(USAGE_URL).then((r) => r.json()).catch(() => null);
const PERMS = [["jev", "off", "random"], ["off", "random", "jev"], ["random", "jev", "off"],
  ["jev", "random", "off"], ["off", "jev", "random"], ["random", "off", "jev"]];

// The brain must actually be able to reach Jev, or "jev" is just "off".
// A real (tiny) situation, so a billing or key failure shows up here and not
// 30 matches later.
const probe = await fetch("http://127.0.0.1:8797/bot", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bot: { name: "probe", health: 50 }, opponents: [{ id: "p2", name: "rival", frags: 3, distance: 300, killedMeRecently: 1 }], items: [{ id: "i9", item: "rocket launcher", distance: 200 }] }) }).then((r) => r.json()).catch(() => null);
if (!probe || probe.source !== "jev") { console.error("Jev is not answering (source=" + probe?.source + "); refusing to run. Check the npc-brain log and TypeSafe credits."); process.exit(2); }

const usageAtStart = await usage();
if (!usageAtStart) { console.error("npc-brain has no /bot/usage (old brain?); refusing to run without spend accounting."); process.exit(2); }
mkdirSync("bench/results", { recursive: true });
console.log(`run ${RUN}: ${MATCHES} matches x ${MINUTES} min on ${MAP}, concurrency ${process.env.CONCURRENCY ?? 1}, budget ${BUDGET}/bot/match, items ${ITEMS}, personas ${PERSONAS.join("/")}, token cap ${MAX_RUN_TOKENS} -> ${OUT}`);
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });

// Matches can run side by side (CONCURRENCY=3): each page is its own server.
// Spend is charged per match by tag, and each match records how closely game
// time kept pace with wall time, so a machine too loaded to run in real time
// shows up in the data instead of silently changing the game.
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 1));
let nextMatch = 0;
let stopReason = null;

async function runMatch(m) {
  const perm = PERMS[m % PERMS.length];
  const persona = PERSONAS[m % PERSONAS.length];
  const tag = `${RUN}-${m}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  const started = Date.now();
  try {
    await page.goto(BASE + "?pak=frogbot.pak");
    await page.waitForFunction(() => typeof window.Cbuf_AddText === "function", null, { timeout: 120000 });
    await page.evaluate(({ modes, budget, persona, items, url }) => window.Cbuf_AddText(`bot_voice 0\nbot_mind_modes ${modes}\nbot_mind_budget ${budget}\nbot_mind_personas ${persona}\nbot_mind_goals ${items}\nbot_mind_url "${url}"\nfraglimit 0\ntimelimit 0\nskill 5\n`),
      { modes: perm.join(","), budget: BUDGET, persona, items: ITEMS, url: `http://127.0.0.1:8797/bot?tag=${tag}` });
    await page.evaluate((map) => window.Cbuf_AddText(`botmatch ${map} 3\n`), MAP);
    // observer flags as soon as the map is up, BEFORE botmatch adds bots (~6 s later)
    await page.waitForFunction((map) => window.sv?.active && window.sv.name === map && window.cls?.signon === 4, MAP, { timeout: 120000, polling: 200 });
    await page.evaluate(() => window.Cbuf_AddText("god\nnotarget\nnoclip\n"));
    await page.waitForFunction(async () => {
      const { BotMind_Stats } = await import("/src/bot_mind.js");
      return window.sv?.active && BotMind_Stats().bots.filter((b) => b.isBot).length >= 3;
    }, null, { timeout: 120000, polling: 1000 });
    // game time and wall time, both read inside the page at the same instants
    const t0 = await page.evaluate(() => (window.__bench0 = { sv: window.sv.time, wall: performance.now() }).sv);
    await page.waitForFunction((end) => window.sv.time >= end, t0 + MINUTES * 60, { timeout: (MINUTES * 60 * 3 + 120) * 1000, polling: 2000 });
    const realtime = await page.evaluate(() => (window.sv.time - window.__bench0.sv) / ((performance.now() - window.__bench0.wall) / 1000));
    const stats = await page.evaluate(async () => (await import("/src/bot_mind.js")).BotMind_Stats());
    const jevBot = stats.bots.find((b) => b.mode === "jev");
    const valid = !!jevBot && jevBot.decisions > 0;
    const tu = await fetch(`${USAGE_URL}?tag=${tag}`).then((r) => r.json()).catch(() => null);
    const jevUsage = tu ? { calls: tu.calls, inputTokens: tu.inputTokens, failures: tu.failures } : null;
    const line = { run: RUN, match: m, map: MAP, perm, persona, items: ITEMS, minutes: MINUTES, budget: BUDGET, concurrency: CONCURRENCY,
      wallSeconds: Math.round((Date.now() - started) / 1000), realtime: Number(realtime.toFixed(3)), serverTime: t0, valid, jevUsage, stats };
    appendFileSync(OUT, JSON.stringify(line) + "\n");
    const bots = stats.bots.filter((b) => b.isBot).map((b) => `${b.mode}:${b.frags}f/${b.deaths}d`).join("  ");
    console.log(`match ${m + 1}/${MATCHES} [${perm}] ${persona} ${bots}  jev: ${jevUsage?.calls} calls, ${jevUsage?.inputTokens} tok  realtime ${realtime.toFixed(2)}  (${line.wallSeconds}s)`);
    if (!valid) stopReason = `match ${m + 1}: the Jev bot got ZERO Jev decisions, so this match measured Frogbot vs Frogbot`;
  } catch (err) {
    appendFileSync(OUT, JSON.stringify({ run: RUN, match: m, perm, persona, error: String(err).slice(0, 300) }) + "\n");
    console.log(`match ${m + 1}/${MATCHES} FAILED: ${String(err).slice(0, 160)}`);
  } finally {
    await page.close();
  }
  const u = await usage();
  if (u && u.inputTokens - usageAtStart.inputTokens > MAX_RUN_TOKENS) stopReason = `token cap reached (${u.inputTokens - usageAtStart.inputTokens} > ${MAX_RUN_TOKENS})`;
}

async function worker() {
  while (!stopReason && nextMatch < MATCHES) await runMatch(nextMatch++);
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (stopReason) console.error(`stopped early: ${stopReason}`);
const usageEnd = await usage();
if (usageEnd) {
  const tok = usageEnd.inputTokens - usageAtStart.inputTokens;
  console.log(`Jev spend this run: ${usageEnd.calls - usageAtStart.calls} calls, ${tok} input tokens, ~$${(tok * 0.042 / 1e6).toFixed(4)} at list price, ${usageEnd.failures - usageAtStart.failures} failures`);
}
await browser.close();
console.log("done ->", OUT);
