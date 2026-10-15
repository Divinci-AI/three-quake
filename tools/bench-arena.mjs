// Decision-model tournament: N open models (arms) play one deathmatch against each other, every match, with fair rotation.
//   ARMS="arm:clef-flash,arm:decider-4b,arm:d3-edge,so1,off" MATCHES=25 MINUTES=3 node tools/bench-arena.mjs
// Design (written down before any run):
//  - slot rotation: match m shifts the arm list by m mod N, so every arm sits in every join slot equally often;
//  - persona: floor(m/N) mod P, so each (slot, persona) pair appears once per N*P matches and persona is never confounded with slot;
//  - point of view: every match is recorded as a native demo; the observer is locked to the bot whose arm is
//    arms[floor(m/N) mod N], so each arm's point of view is captured in every slot (FOLLOW=0 turns the camera off, RECORD=0 the demo);
//  - validity: a match where an arm got zero decisions is flagged, never silently averaged in.
// Needs: `deno task web`, frogbot.pak, the brain (`deno task brain`) with MIND_ARMS set for every arm: names.
import { createRequire } from "node:module";
import { mkdirSync, appendFileSync } from "node:fs";
import { makePlan } from "./arena-plan.mjs";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? "/Users/michael/Documents/server/workspace/clients/tests/package.json");
const { chromium } = require("@playwright/test");

const ARMS = (process.env.ARMS ?? "arm:clef-flash,arm:decider-4b,arm:d3-edge,so1,off").split(",").map((s) => s.trim()).filter(Boolean);
const N = ARMS.length;
if (N < 2 || N > 7 || new Set(ARMS).size !== N) { console.error("ARMS: 2..7 distinct modes"); process.exit(2); }
const MATCHES = Number(process.env.MATCHES ?? 5 * N);
const MINUTES = Number(process.env.MINUTES ?? 3);
const MAP = process.env.MAP ?? "e1m1";
const BASE = process.env.BASE ?? "http://127.0.0.1:8093/";
const BRAIN = process.env.BRAIN ?? "http://127.0.0.1:8797";
const RUN = process.env.RUN ?? "arena-" + new Date().toISOString().replace(/[:.]/g, "-");
const RECORD = process.env.RECORD !== "0", FOLLOW = process.env.FOLLOW !== "0";
const BUDGET = Number(process.env.BUDGET ?? 400); // decisions per bot per match (free models: effectively off)
const PERSONAS = (process.env.PERSONAS ?? "vindictive,greedy,showoff,cautious,bully").split(",").filter(Boolean);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 1));
const OUT = `bench/results/${RUN}.jsonl`, POVDIR = `bench/pov/${RUN}`;
const needsBrain = ARMS.filter((a) => a !== "off" && a !== "random");

// every model arm must really answer, or "arm:x" is just plain Frogbot
for (const a of needsBrain) {
  const probe = await fetch(`${BRAIN}/bot`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mind: a, bot: { name: "probe", health: 50 }, opponents: [{ id: "p2", name: "rival", frags: 3, distance: 300, killedMeRecently: 1 }], items: [] }) }).then((r) => r.json()).catch(() => null);
  if (!probe || probe.source !== a) { console.error(`arm ${a} is not answering (source=${probe?.source}); refusing to run.`); process.exit(2); }
}
mkdirSync("bench/results", { recursive: true }); if (RECORD) mkdirSync(POVDIR, { recursive: true });
console.log(`run ${RUN}: ${MATCHES} matches x ${MINUTES} min, ${N} arms [${ARMS.join(" ")}], follow ${FOLLOW}, record ${RECORD}, concurrency ${CONCURRENCY} -> ${OUT}`);
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
let nextMatch = 0, stopReason = null;

const plan = makePlan(ARMS, PERSONAS);

async function runMatchOnce(m, attempt) {
  const { modes, persona, followArm, followSlot } = plan(m);
  const tag = `${RUN}-${m}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
  const demo = RECORD ? `${RUN}-m${m}-${followArm.replace(/[^a-z0-9]/g, "")}`.replace(/[^a-z0-9_-]/gi, "").slice(0, 60) : "";
  const page = await browser.newPage({ viewport: { width: 640, height: 400 }, acceptDownloads: true });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
  const started = Date.now();
  try {
    await page.goto(BASE + `?pak=frogbot.pak&maxclients=${N + 1}`); // the engine caps a bot match at 3 bots unless asked for more clients
    await page.waitForFunction(() => typeof window.Cbuf_AddText === "function", null, { timeout: 120000 });
    await page.evaluate(({ map, modes, budget, persona, url, follow, n, demo }) => window.Cbuf_AddText(
      `bot_voice 0\nbot_mind_modes "${modes}"\nbot_mind_budget ${budget}\nbot_mind_personas "${persona}"\nbot_mind_goals 0\nbot_mind_url "${url}"\nbot_follow ${follow}\nbotmatch ${map} ${n}${demo ? " " + demo : ""}\n`),
      { map: MAP, modes: modes.join(","), budget: BUDGET, persona, url: `${BRAIN}/bot?tag=${tag}`, follow: FOLLOW ? followSlot + 1 : 0, n: N, demo });
    await page.waitForFunction((map) => window.sv?.active && window.sv.name === map && window.cls?.signon === 4, MAP, { timeout: 120000, polling: 200 });
    await page.evaluate(() => window.Cbuf_AddText("god\nnotarget\nnoclip\n"));
    await page.waitForFunction(async (n) => (await import("/src/bot_mind.js")).BotMind_Stats().bots.filter((b) => b.isBot).length >= n, N, { timeout: 180000, polling: 1000 });
    const t0 = await page.evaluate(() => (window.__bench0 = { sv: window.sv.time, wall: performance.now() }).sv);
    // Watch the game clock instead of one long wait: a stalled page (seen in ~15% of matches under laptop load) is abandoned after 90 s
    // without progress rather than after 11 minutes, with the page errors and last clock reading in the failure.
    for (let last = t0, lastAt = Date.now(), end = Date.now() + (MINUTES * 60 * 3 + 120) * 1000; ;) {
      const now = await page.evaluate(() => window.sv.time).catch(() => null);
      if (now !== null && now >= t0 + MINUTES * 60) break;
      if (now !== null && now > last) { last = now; lastAt = Date.now(); }
      if (Date.now() - lastAt > 90000 || Date.now() > end) throw new Error(`game clock stalled at sv.time=${last.toFixed(1)} (started ${t0.toFixed(1)}); page errors: ${JSON.stringify(pageErrors.slice(-3))}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    const realtime = await page.evaluate(() => (window.sv.time - window.__bench0.sv) / ((performance.now() - window.__bench0.wall) / 1000));
    const stats = await page.evaluate(async () => (await import("/src/bot_mind.js")).BotMind_Stats());
    let demoFile = null;
    if (RECORD) {
      const dl = page.waitForEvent("download", { timeout: 60000 });
      await page.evaluate(() => window.Cbuf_AddText("stop\n"));
      demoFile = `${POVDIR}/${demo}.dem`; await (await dl).saveAs(demoFile);
    }
    const u = await fetch(`${BRAIN}/bot/usage?tag=${tag}`).then((r) => r.json()).catch(() => null);
    const bots = stats.bots.filter((b) => b.isBot);
    // every bot must run the mode the plan gave it (a console-parsing slip once turned all of them into "jev"), and every model arm must have decided
    const wrong = bots.filter((b) => !modes.includes(b.mode)).map((b) => `unexpected:${b.mode}`);
    const dead = [...wrong, ...bots.filter((b) => b.mode.startsWith("arm:") || b.mode === "so1").filter((b) => !(b.decisions > 0)).map((b) => b.mode)];
    const line = { run: RUN, match: m, map: MAP, modes, persona, minutes: MINUTES, followArm, followSlot: FOLLOW ? followSlot : null, demo: demoFile,
      wallSeconds: Math.round((Date.now() - started) / 1000), realtime: Number(realtime.toFixed(3)), serverTime: t0, valid: dead.length === 0, deadArms: dead, arms: u?.arms ?? null, stats };
    appendFileSync(OUT, JSON.stringify(line) + "\n");
    console.log(`match ${m + 1}/${MATCHES} ${persona} follow=${followArm} ${bots.map((b) => `${b.mode}:${b.frags}f/${b.deaths}d`).join("  ")}  realtime ${realtime.toFixed(2)} (${line.wallSeconds}s)${dead.length ? "  INVALID: no decisions from " + dead : ""}`);
    if (dead.length) stopReason = `match ${m + 1}: ${dead} got ZERO decisions`;
  } catch (err) {
    appendFileSync(OUT, JSON.stringify({ run: RUN, match: m, modes, persona, error: String(err).slice(0, 300) }) + "\n");
    console.log(`match ${m + 1}/${MATCHES} FAILED (attempt ${attempt}): ${String(err).slice(0, 260)}`);
    return false;
  } finally { await page.close(); }
  return true;
}
// A failed match is tried once more with the same plan (the seed of the rotation does not change), so a flaky page does not leave a hole in the balanced cycle.
async function runMatch(m) { for (let attempt = 1; attempt <= 2; attempt++) if (await runMatchOnce(m, attempt)) return; }
// ONLY=10,11 replays just those match indices (0-based) with the SAME deterministic plan, e.g. matches that failed for laptop reasons; use a new RUN name.
const QUEUE = process.env.ONLY ? process.env.ONLY.split(",").map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m < MATCHES) : Array.from({ length: MATCHES }, (_, i) => i);
async function worker() { while (!stopReason && nextMatch < QUEUE.length) await runMatch(QUEUE[nextMatch++]); }
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
if (stopReason) console.error(`stopped early: ${stopReason}`);
await browser.close();
console.log("done ->", OUT);
