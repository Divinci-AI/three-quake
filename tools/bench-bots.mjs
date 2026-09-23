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
const PERMS = [["jev", "off", "random"], ["off", "random", "jev"], ["random", "jev", "off"],
  ["jev", "random", "off"], ["off", "jev", "random"], ["random", "off", "jev"]];

// The brain must actually be able to reach Jev, or "jev" is just "off".
// A real (tiny) situation, so a billing or key failure shows up here and not
// 30 matches later.
const probe = await fetch("http://127.0.0.1:8797/bot", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bot: { name: "probe", health: 50 }, opponents: [{ id: "p2", name: "rival", frags: 3, distance: 300, killedMeRecently: 1 }], items: [{ id: "i9", item: "rocket launcher", distance: 200 }] }) }).then((r) => r.json()).catch(() => null);
if (!probe || probe.source !== "jev") { console.error("Jev is not answering (source=" + probe?.source + "); refusing to run. Check the npc-brain log and TypeSafe credits."); process.exit(2); }

mkdirSync("bench/results", { recursive: true });
console.log(`run ${RUN}: ${MATCHES} matches x ${MINUTES} min on ${MAP} -> ${OUT}`);
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });

for (let m = 0; m < MATCHES; m++) {
  const perm = PERMS[m % PERMS.length];
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  const started = Date.now();
  try {
    await page.goto(BASE + "?pak=frogbot.pak");
    await page.waitForFunction(() => typeof window.Cbuf_AddText === "function", null, { timeout: 120000 });
    await page.evaluate((modes) => window.Cbuf_AddText(`bot_voice 0\nbot_mind_modes ${modes}\nfraglimit 0\ntimelimit 0\nskill 5\n`), perm.join(","));
    await page.evaluate((map) => window.Cbuf_AddText(`botmatch ${map} 3\n`), MAP);
    // observer flags as soon as the map is up, BEFORE botmatch adds bots (~6 s later)
    await page.waitForFunction((map) => window.sv?.active && window.sv.name === map && window.cls?.signon === 4, MAP, { timeout: 120000, polling: 200 });
    await page.evaluate(() => window.Cbuf_AddText("god\nnotarget\nnoclip\n"));
    await page.waitForFunction(async () => {
      const { BotMind_Stats } = await import("/src/bot_mind.js");
      return window.sv?.active && BotMind_Stats().bots.filter((b) => b.isBot).length >= 3;
    }, null, { timeout: 120000, polling: 1000 });
    const t0 = await page.evaluate(() => window.sv.time);
    await page.waitForFunction((end) => window.sv.time >= end, t0 + MINUTES * 60, { timeout: (MINUTES * 60 + 120) * 1000, polling: 2000 });
    const stats = await page.evaluate(async () => (await import("/src/bot_mind.js")).BotMind_Stats());
    const jevBot = stats.bots.find((b) => b.mode === "jev");
    const valid = !!jevBot && jevBot.decisions > 0;
    const line = { run: RUN, match: m, map: MAP, perm, minutes: MINUTES, wallSeconds: Math.round((Date.now() - started) / 1000), serverTime: t0, valid, stats };
    appendFileSync(OUT, JSON.stringify(line) + "\n");
    const bots = stats.bots.filter((b) => b.isBot).map((b) => `${b.mode}:${b.frags}f/${b.deaths}d`).join("  ");
    console.log(`match ${m + 1}/${MATCHES} [${perm}] ${bots}  (${line.wallSeconds}s)`);
    if (!valid) {
      console.error(`match ${m + 1}: the Jev bot got ZERO Jev decisions, so this match measured Frogbot vs Frogbot. Aborting the run.`);
      break;
    }
  } catch (err) {
    appendFileSync(OUT, JSON.stringify({ run: RUN, match: m, perm, error: String(err).slice(0, 300) }) + "\n");
    console.log(`match ${m + 1}/${MATCHES} FAILED: ${String(err).slice(0, 160)}`);
  } finally {
    await page.close();
  }
}
await browser.close();
console.log("done ->", OUT);
