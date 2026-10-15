// Re-render a recorded demo (a bot's point of view) to mp4, deterministically: host_framerate fixes the time step, so
// every output frame is exactly 1/FPS of demo time no matter how slowly software WebGL draws it.
//   node tools/render-pov.mjs bench/pov/smoke.dem out.mp4 [--seconds 10] [--fps 30] [--size 1280x720]   (needs `deno task web`)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? "/Users/michael/Documents/server/workspace/clients/tests/package.json");
const { chromium } = require("@playwright/test");
const [demo, out, ...rest] = process.argv.slice(2);
const opt = (n, d) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : d; };
const SECONDS = Number(opt("seconds", 10)), FPS = Number(opt("fps", 30)), [W, H] = opt("size", "1280x720").split("x").map(Number);
if (!demo || !out) { console.error("usage: render-pov.mjs <demo.dem> <out.mp4> [--seconds N] [--fps N] [--size WxH]"); process.exit(2); }
const BASE = process.env.BASE ?? "http://127.0.0.1:8093/";
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio"] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(BASE + "?pak=frogbot.pak");
await page.waitForFunction(() => typeof window.Cbuf_AddText === "function", null, { timeout: 120000 });
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const { CL_PlayDemoFromData } = await import("/src/cl_demo.js");
  window.Cbuf_AddText(`host_framerate ${1 / 30}\nbot_mind 0\n`);
  CL_PlayDemoFromData(bytes);
}, readFileSync(demo).toString("base64"));
const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out], { stdio: ["pipe", "inherit", "inherit"] });
const canvas = page.locator("canvas").first();
const total = Math.round(SECONDS * FPS);
let n = 0;
const t0 = Date.now();
for (; n < total; n++) {
  const playing = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(async () => r((await import("/src/client.js")).cls.demoplayback)))));
  if (!playing) break;
  ff.stdin.write(await canvas.screenshot({ type: "jpeg", quality: 92 }));
}
ff.stdin.end(); await new Promise((r) => ff.on("close", r));
console.log(`rendered ${n} frames (${(n / FPS).toFixed(1)} s of demo) in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${out}`);
await browser.close();
