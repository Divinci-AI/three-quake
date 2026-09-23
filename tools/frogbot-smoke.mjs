// Headless smoke test: Frogbot in three-quake. Needs `deno task web` running and
// frogbot.pak built (tools/build-frogbot-pak.sh). Playwright is borrowed from the
// Divinci monorepo; point PLAYWRIGHT_FROM at any package.json that has it.

import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? "/Users/michael/Documents/server/workspace/clients/tests/package.json");
const { chromium } = require("@playwright/test");
const S = process.env.OUT_DIR ?? ".";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
await page.goto("http://127.0.0.1:8093/?pak=frogbot.pak");
await page.waitForFunction(() => typeof window.Cbuf_AddText === "function", null, { timeout: 90000 });
await page.evaluate(() => window.Cbuf_AddText("maxplayers 4\ndeathmatch 3\nfraglimit 20\ntimelimit 10\nskill 5\nmap e1m1\n"));
try {
  await page.waitForFunction(() => window.sv?.active && window.sv.name === "e1m1" && window.cls?.signon === 4, null, { timeout: 45000 });
} catch (e) {
  await page.screenshot({ path: `${S}/frogbot-spike-fail.png` });
  const st = await page.evaluate(() => ({ svActive: window.sv?.active, svName: window.sv?.name, signon: window.cls?.signon, state: window.cls?.state }));
  console.log("LOAD FAILED", JSON.stringify(st));
  console.log(logs.slice(-60).join(String.fromCharCode(10)));
  await browser.close(); process.exit(1);
}
await page.waitForTimeout(3000);
await page.evaluate(() => window.Cbuf_AddText("god\naddbot\n"));
await page.waitForTimeout(1500);
await page.evaluate(() => window.Cbuf_AddText("addbot\n"));
await page.waitForTimeout(1500);
await page.evaluate(() => window.Cbuf_AddText("addbot\n"));
const snap = () => page.evaluate(async () => {
  const { PR_GetString } = await import("/src/progs.js");
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const e = window.sv.edicts[i];
    if (!e || e.free) { out.push({ edict: i, free: true }); continue; }
    out.push({ edict: i, cls: PR_GetString(e.v.classname), name: PR_GetString(e.v.netname), health: Math.round(e.v.health), frags: e.v.frags, weapon: e.v.weapon, origin: Array.from(e.v.origin).map(Math.round) });
  }
  return out;
});
await page.waitForTimeout(3000);
const a = await snap();
await page.waitForTimeout(60000);
const board = await page.evaluate(() => (window.cl.scores || []).filter((x) => x && x.name).map((x) => ({ name: x.name, frags: x.frags })));
console.log("SCOREBOARD", JSON.stringify(board));
const b = await snap();
await page.screenshot({ path: `${S}/frogbot-spike.png` });
console.log("maxclients:", await page.evaluate(async () => (await import("/src/server.js")).svs.maxclients));
console.log("T0", JSON.stringify(a));
console.log("T8", JSON.stringify(b));
const interesting = logs.filter((l) => /frog|bot|error|PR_|progs|unknown|builtin|waypoint|not found|PAGEERROR|entered|joined/i.test(l));
console.log("--- logs (" + logs.length + " total) ---\n" + interesting.slice(0, 40).join("\n"));
await browser.close();
