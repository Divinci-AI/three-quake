// Spike for ONE decision-model arm, before it plays: sends the questions the Quake bots really ask (the brain's own
// buildState/buildQuestions/askJev), in both option orders, over seeded random situations for every persona.
// Reports: ok rate, latency, validity of choices, option-order bias, and persona-consistency (does the choice follow the
// persona's stated temperament by a simple rule). It does NOT measure fragging strength; the arena does.
// The arms listen on the Jetson's loopback (8802..8807); reach them through an SSH tunnel (ssh -L 8802:127.0.0.1:8802 ...), no token or TLS.
// (Deno rejects the proxy's self-signed certificate: it is flagged CA:TRUE, rustls says CaUsedAsEndEntity.)
//   deno run --allow-net --allow-read --allow-write tools/arm-spike.ts --arm clef-flash --url http://127.0.0.1:8802 --n 12 --out bench/spike-clef-flash.json
import { askJev, JevError } from "../npc-brain/jev.ts";
import { type BotSituation, BOT_PERSONAS, buildQuestions, buildState, reversedSituation } from "../npc-brain/bots.ts";
import { expected, makeSituation, rng } from "./arm-lib.ts";

function arg(name: string, def?: string): string {
  const i = Deno.args.indexOf(`--${name}`);
  if (i >= 0 && Deno.args[i + 1]) return Deno.args[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}

const arm = arg("arm");
const base = arg("url").replace(/\/+$/, "");
const N = Number(arg("n", "12"));
const out = arg("out", `bench/spike-${arm}.json`);
const cfg = { apiKey: Deno.env.get("MIND_ARMS_TOKEN") ?? "", url: `${base}/v1/systemone`, model: arm, timeoutMs: Number(arg("timeout", "15000")), confidence: "concentration" as const };

// One throwaway call with a long timeout: the first request after a start compiles kernels (45 s on Clef) and would otherwise count as a failure.
{
  const w = makeSituation(rng(1), "bully", arm);
  const t0 = performance.now();
  try { await askJev({ ...cfg, timeoutMs: 300000 }, buildState(w, BOT_PERSONAS[4]), buildQuestions(w, BOT_PERSONAS[4])); console.log(`warm-up ok in ${Math.round(performance.now() - t0)} ms`); }
  catch (e) { console.error(`warm-up FAILED: ${String(e)}`); Deno.exit(3); }
}

const r = rng(20261015);
const rows: Record<string, unknown>[] = [];
let calls = 0, fails = 0;
const lat: number[] = [];
const errs: Record<string, number> = {};
for (const p of BOT_PERSONAS) {
  for (let i = 0; i < N; i++) {
    const s = makeSituation(r, p.key, arm);
    const answers: Record<string, string | null>[] = [];
    for (const sit of [s, reversedSituation(s)]) {
      const t0 = performance.now();
      calls++;
      try {
        const a = await askJev(cfg, buildState(sit, p), buildQuestions(sit, p));
        lat.push(performance.now() - t0);
        const f = a.answers.focus as { choice?: string } | undefined;
        answers.push({ focus: f?.choice ?? null, goal: (a.answers.goal as { choice?: string } | undefined)?.choice ?? null });
      } catch (e) {
        fails++;
        const k = e instanceof JevError ? `${(e as { code?: string }).code ?? "jev"}:${(e as { status?: number }).status ?? ""}` : String(e).slice(0, 60);
        errs[k] = (errs[k] ?? 0) + 1;
        answers.push({ focus: null, goal: null });
      }
    }
    const valid = (c: string | null) => c === "none" || s.opponents.some((o) => o.id === c);
    const exp = expected(s, p.key);
    rows.push({ persona: p.key, opponents: s.opponents.length, fwd: answers[0].focus, rev: answers[1].focus, validFwd: valid(answers[0].focus), validRev: valid(answers[1].focus),
      first: s.opponents[0].id, last: s.opponents[s.opponents.length - 1].id, expected: exp });
  }
}

const ok = rows.filter((x) => x.fwd && x.rev);
const pct = (n: number, d: number) => d ? Math.round(1000 * n / d) / 10 : null;
const q = (a: number[], f: number) => { const b = [...a].sort((x, y) => x - y); return b.length ? Math.round(b[Math.min(b.length - 1, Math.floor(f * b.length))]) : null; };
const consistent = (x: Record<string, unknown>, choice: unknown) => x.persona === "cautious" ? choice !== x.expected : choice === x.expected;
const scored = (pick: "fwd" | "rev") => rows.filter((x) => x.expected && x[pick]);
const report = {
  arm, url: base, situations: rows.length, calls, failures: fails, errors: errs,
  okRatePct: pct(calls - fails, calls), latencyMs: { p50: q(lat, 0.5), p95: q(lat, 0.95), max: q(lat, 1) },
  validChoicePct: pct(rows.filter((x) => x.validFwd).length + rows.filter((x) => x.validRev).length, rows.length * 2),
  // order bias: same situation, options reversed, how often does the answer change? And does it favour the first-listed option?
  orderFlipPct: pct(ok.filter((x) => x.fwd !== x.rev).length, ok.length),
  pickedFirstListedPct: pct(rows.filter((x) => x.fwd === x.first).length + rows.filter((x) => x.rev === x.last).length, rows.length * 2), // rev lists the original last first
  personaConsistentPct: { fwd: pct(scored("fwd").filter((x) => consistent(x, x.fwd)).length, scored("fwd").length), rev: pct(scored("rev").filter((x) => consistent(x, x.rev)).length, scored("rev").length), n: scored("fwd").length },
  pickedNonePct: pct(rows.filter((x) => x.fwd === "none").length, rows.length),
  note: "persona rules: vindictive->most recent killer; showoff->leader; bully->fewest frags; cautious->NOT the leader. Chance level differs by opponent count. Not a strength measure.",
};
await Deno.writeTextFile(out, JSON.stringify({ report, rows }, null, 1));
console.log(JSON.stringify(report, null, 1));
