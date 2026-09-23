// Headless smoke test: bot bodies reach the client. Runs `botmatch`, then parks
// the (noclip) player beside bots and counts frames in which the client holds
// each bot's body. All zeros means bots are invisible again (see sv_main.js,
// SV_WritePlayersToClient: bot bodies live in player slots with no client).
// Needs `deno task web` and frogbot.pak.
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? "/Users/michael/Documents/server/workspace/clients/tests/package.json");
const { chromium } = require("@playwright/test");
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
await page.goto("http://127.0.0.1:8093/?pak=frogbot.pak");
await page.waitForFunction(() => typeof window.Cbuf_AddText === "function", null, { timeout: 90000 });
await page.evaluate(() => window.Cbuf_AddText("botmatch\n"));
await page.waitForFunction(() => window.sv?.active && window.cls?.signon === 4 && window.cl.scores?.filter((x) => x && x.name).length >= 4, null, { timeout: 90000 });
await page.evaluate(() => window.Cbuf_AddText("noclip\n"));
await page.waitForTimeout(500);
let seen = { 1: 0, 2: 0, 3: 0 }, dead = 0, samples = 0;
for (let k = 0; k < 30; k++) {
  await page.waitForTimeout(500);
  if (k % 4 === 0) await page.evaluate(() => { const b = window.sv.edicts[2 + (Math.floor(Math.random() * 3))]; const o = b.v.origin; window.sv.edicts[1].v.origin = [o[0] + 60, o[1], o[2] + 20]; });
  const r = await page.evaluate(async () => {
    const { CL_GetPredictedPlayer } = await import("/src/cl_pred.js");
    return [1, 2, 3].map((j) => { const p = CL_GetPredictedPlayer(j); return p ? { j, dead: (p.flags & 0x200) !== 0 } : null; });
  });
  samples++;
  for (const p of r) if (p) { seen[p.j]++; if (p.dead) dead++; }
}
console.log("frames the client HAD each bot body (of " + samples + "):", JSON.stringify(seen));
await browser.close();
