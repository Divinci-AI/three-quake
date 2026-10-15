// Smoke test for point-of-view recording: a short match of 3 plain Frogbots, observer locked to bot 1, demo recorded and downloaded.
//   node tools/pov-smoke.mjs   (needs `deno task web`)  -> bench/pov/smoke.dem + smoke-*.png
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? "/Users/michael/Documents/server/workspace/clients/tests/package.json");
const { chromium } = require("@playwright/test");
const BASE = process.env.BASE ?? "http://127.0.0.1:8093/";
const SECONDS = Number(process.env.SECONDS ?? 25);
const FOLLOW = process.env.FOLLOW ?? "1";
mkdirSync("bench/pov", { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 }, acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
await page.goto(BASE + "?pak=frogbot.pak");
await page.waitForFunction(() => typeof window.Cbuf_AddText === "function", null, { timeout: 120000 });
await page.evaluate((f) => window.Cbuf_AddText(`bot_voice 0\nbot_mind_modes off,off,off\nbot_follow ${f}\nbotmatch e1m1 3 smoke\n`), FOLLOW);
await page.waitForFunction((map) => window.sv?.active && window.sv.name === map && window.cls?.signon === 4, "e1m1", { timeout: 120000, polling: 200 });
await page.evaluate(() => window.Cbuf_AddText("god\nnotarget\nnoclip\n"));
await page.waitForFunction(async () => (await import("/src/bot_mind.js")).BotMind_Stats().bots.filter((b) => b.isBot).length >= 3, null, { timeout: 120000, polling: 1000 });
const t0 = await page.evaluate(() => window.sv.time);
const info = [];
for (const frac of [0.3, 0.9]) {
  await page.waitForFunction((end) => window.sv.time >= end, t0 + SECONDS * frac, { timeout: 180000, polling: 500 });
  const st = await page.evaluate(async () => {
    const { BotMind_Stats } = await import("/src/bot_mind.js");
    const { svs, sv } = await import("/src/server.js");
    const bots = BotMind_Stats().bots.filter((b) => b.isBot);
    const obs = svs.clients[0].edict.v;
    const players = [...sv.edicts].filter((e) => e && !e.free && e.v?.classname === "player" && e !== svs.clients[0].edict);
    return { obs: [...obs.origin].map(Math.round), obsAngles: [...obs.angles].map(Math.round), obsHealth: obs.health,
      botOrigins: players.map((e) => [...e.v.origin].map(Math.round)), botAngles: players.map((e) => [...e.v.v_angle].map(Math.round)),
      names: bots.map((b) => b.name), frags: bots.map((b) => b.frags) };
  });
  info.push(st);
  await page.screenshot({ path: `bench/pov/smoke-${frac}.png` });
}
await page.waitForFunction((end) => window.sv.time >= end, t0 + SECONDS, { timeout: 180000, polling: 500 });
const dl = page.waitForEvent("download", { timeout: 30000 });
await page.evaluate(() => window.Cbuf_AddText("stop\n"));
const d = await dl;
await d.saveAs("bench/pov/smoke.dem");
console.log(JSON.stringify({ follow: FOLLOW, demo: d.suggestedFilename(), bytes: statSync("bench/pov/smoke.dem").size, samples: info, pageErrors: errors.slice(0, 3) }, null, 1));
await browser.close();
