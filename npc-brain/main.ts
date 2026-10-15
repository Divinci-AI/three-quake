// npc-brain -- the only process that talks to a model.
//
// The game (browser, or the Deno game server) POSTs a talk/sight event and
// gets back { line, action, audioId? }. The line is shown at once; the
// audio, if any, is fetched from GET /audio/<audioId>, which waits for TTS
// to finish. The game only ever sees validated fields, and no key ever
// reaches a browser.
//
// Backends (NPC_BACKEND, or picked from the environment):
//   divinci    one Divinci release per monster type (npc-brain/releases.json),
//              Cloudflare models, Aura-2 TTS.   needs QUAKE_DIVINCI_API_KEY
//   anthropic  Claude directly, no TTS.          needs ANTHROPIC_API_KEY
//   mock       canned lines, no network.         NPC_BRAIN_MOCK=1
//
// Env: NPC_BRAIN_PORT (8797), QUAKE_DIVINCI_API_URL (staging),
//      NPC_MODEL / NPC_EFFORT (anthropic only), NPC_ALLOWED_ORIGINS.

import Anthropic from "npm:@anthropic-ai/sdk@^0.126.0";
import { buildSystemPrompt, buildUserTurn, parseModelReply, parseRequest, REPLY_SCHEMA, spokenText,
  type NpcReply, type NpcRequest } from "./persona.ts";
import { chat, configFromEnv, DivinciError, tts, type DivinciConfig } from "./divinci.ts";
import { GENERIC_CLASSNAME, monsterFor } from "./monsters.ts";
import { ArmStats, armName, isArm, parseArms } from "./arms.ts";
import { askJev, concentration, jevConfigFromEnv, JevError, so1ConfigFromEnv } from "./jev.ts";
import { averageAnswers, type BotSituation, buildQuestions, buildState, decide, parseSituation, personaOf, reversedSituation } from "./bots.ts";

const PORT = Number(Deno.env.get("NPC_BRAIN_PORT") ?? 8797);
const EXTRA_ORIGINS = (Deno.env.get("NPC_ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_IN_FLIGHT = 4;

const divinci = configFromEnv();
const backend = Deno.env.get("NPC_BACKEND")
  ?? (Deno.env.get("NPC_BRAIN_MOCK") === "1" ? "mock"
    : divinci ? "divinci"
    : Deno.env.get("ANTHROPIC_API_KEY") ? "anthropic"
    : "mock");

//---------------------------------------------------------------------------
// divinci backend

let releases: Record<string, string> = {};
if (backend === "divinci") {
  if (!divinci) throw new Error("NPC_BACKEND=divinci needs QUAKE_DIVINCI_API_KEY");
  const manifest = JSON.parse(await Deno.readTextFile(new URL("./releases.json", import.meta.url)).catch(() => "{}"));
  releases = manifest[new URL(divinci.apiUrl).host] ?? {};
  if (Object.keys(releases).length === 0) {
    throw new Error(`no releases for ${new URL(divinci.apiUrl).host} in npc-brain/releases.json; run: deno task setup-releases --apply`);
  }
}

// conversationId -> transcriptId, and a per-conversation queue so two quick
// events for the same monster continue ONE transcript instead of forking it.
const transcripts = new Map<string, string>();
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.catch(() => {}).finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

function divinciReply(cfg: DivinciConfig, req: NpcRequest): Promise<NpcReply> {
  const releaseId = releases[req.character] ?? releases[GENERIC_CLASSNAME];
  if (!releaseId) throw new Error(`no release for ${req.character}`);
  return serialized(req.conversationId, async () => {
    const result = await chat(cfg, {
      releaseId,
      transcriptId: transcripts.get(req.conversationId),
      // the transcript carries the history, so the turn does not repeat it
      content: buildUserTurn(req, { includeHistory: false }),
    });
    transcripts.set(req.conversationId, result.transcriptId);
    return parseModelReply(result.text);
  });
}

//---------------------------------------------------------------------------
// audio: synthesized in the background, served once ready

interface Audio { bytes: ArrayBuffer; type: string }
const audio = new Map<string, { at: number; p: Promise<Audio> }>();
const AUDIO_TTL_MS = 5 * 60_000;

function startSpeech(cfg: DivinciConfig, text: string, voice: string): string {
  const now = Date.now();
  for (const [k, v] of audio) if (now - v.at > AUDIO_TTL_MS || audio.size > 64) audio.delete(k);
  const id = crypto.randomUUID().replace(/-/g, "");
  const p = (async () => {
    const url = await tts(cfg, { text, voice });
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`fetching tts audio -> ${res.status}`);
    return { bytes: await res.arrayBuffer(), type: res.headers.get("content-type") ?? "audio/mpeg" };
  })();
  p.catch((err) => console.error(`[npc-brain] tts failed: ${(err as Error).message}`));
  audio.set(id, { at: now, p });
  return id;
}

//---------------------------------------------------------------------------
// anthropic + mock backends

const claude = backend === "anthropic" ? new Anthropic() : null;
const CLAUDE_MODEL = Deno.env.get("NPC_MODEL") ?? "claude-opus-5";
const CLAUDE_EFFORT = (Deno.env.get("NPC_EFFORT") ?? "low") as "low" | "medium" | "high";

async function anthropicReply(req: NpcRequest): Promise<NpcReply> {
  const response = await claude!.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: CLAUDE_EFFORT, format: { type: "json_schema", schema: REPLY_SCHEMA } },
    system: buildSystemPrompt(req.character),
    messages: [{ role: "user", content: buildUserTurn(req, { includeHistory: true }) }],
  });
  if (response.stop_reason === "refusal") return { line: "...", action: "none" };
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error(`no text block (stop_reason=${response.stop_reason})`);
  return parseModelReply(text.text);
}

const MOCK_LINES = [
  "You talk too much for someone standing in my hallway.",
  "I have orders. You are not in them.",
  "Leave now and I will pretend I never saw you.",
];

function mockReply(req: NpcRequest): NpcReply {
  if (req.event === "sight") return { line: "Intruder! Over here!", action: "none" };
  const line = MOCK_LINES[Math.floor(Math.random() * MOCK_LINES.length)];
  return { line, action: /attack|fight|kill/i.test(req.playerSaid) ? "attack" : "none" };
}

//---------------------------------------------------------------------------
// HTTP

function originAllowed(origin: string | null): boolean {
  if (!origin) return true; // non-browser caller (the Deno game server)
  if (EXTRA_ORIGINS.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function cors(origin: string | null): Record<string, string> {
  return origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {};
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

let inFlight = 0;

async function handleNpc(request: Request, origin: string | null): Promise<Response> {
  let req: NpcRequest;
  try {
    req = parseRequest(JSON.parse(await request.text()));
  } catch (err) {
    return json({ error: `bad request: ${(err as Error).message}` }, 400, origin);
  }
  if (inFlight >= MAX_IN_FLIGHT) return json({ error: "busy" }, 429, origin);

  inFlight++;
  try {
    const reply = backend === "divinci" ? await divinciReply(divinci!, req)
      : backend === "anthropic" ? await anthropicReply(req)
      : mockReply(req);

    let audioId: string | undefined;
    const voice = monsterFor(req.character).voice;
    const spoken = spokenText(reply.line);
    if (backend === "divinci" && voice && spoken) audioId = startSpeech(divinci!, spoken, voice);

    return json({ ...reply, audioId }, 200, origin);
  } catch (err) {
    if (err instanceof DivinciError) {
      console.error(`[npc-brain] divinci: ${err.message}`);
      return json({ error: "divinci error", status: err.status }, 502, origin);
    }
    if (err instanceof Anthropic.RateLimitError) return json({ error: "rate limited" }, 429, origin);
    if (err instanceof Anthropic.APIError) {
      console.error(`[npc-brain] anthropic ${err.status}: ${err.message}`);
      return json({ error: "model error" }, 502, origin);
    }
    console.error("[npc-brain]", err);
    return json({ error: "internal error" }, 500, origin);
  } finally {
    inFlight--;
  }
}

//---------------------------------------------------------------------------
// /bot: Jev decides whom a Frogbot bot focuses on and (greedy bots only) what
// it grabs. TypeSafe keys carry no spend limit of their own, so this process
// enforces one: a hard call ceiling, then it answers "let Frogbot decide".

const jev = jevConfigFromEnv();
// A second System One mind: open-weights so1 behind a local server. Free per
// call, so it has no spend ceiling; its server answers one request at a time,
// so it gets a small in-flight cap instead.
const so1 = so1ConfigFromEnv();
const SO1_MAX_IN_FLIGHT = 2;
// Ask each so1 decision in both option orders and average (on by default:
// Qwen3.5-4B's choice flipped with the order in 2 of 3 probes, 2026-09-24).
const SO1_ORDER_AVERAGE = Deno.env.get("SO1_ORDER_AVERAGE") !== "0";
let so1Calls = 0;
let so1Failures = 0;
let so1InFlight = 0;
// Tournament arms: any open Jev-compatible server by name (see arms.ts). One request in flight per arm is plenty (the
// servers serialise on the GPU); a few may queue.
const arms = parseArms(Deno.env.get("MIND_ARMS"), Deno.env.get("MIND_ARMS_TOKEN"), Number(Deno.env.get("MIND_ARMS_TIMEOUT_MS") ?? 8000));
const ARM_MAX_IN_FLIGHT = 3;
const armInFlight = new Map<string, number>();
const armStats = new ArmStats();
const tagArms = new Map<string, ArmStats>();
const BOT_MAX_CALLS = Number(Deno.env.get("BOT_MIND_MAX_CALLS") ?? 500);
const BOT_MAX_IN_FLIGHT = 6;
let botCalls = 0;
let botTokens = 0;
let botFailures = 0;
// Per-tag spend, so concurrent benchmark matches can each be charged exactly
// (the engine appends ?tag=<run>-<match> to bot_mind_url). Bounded.
type Usage = { calls: number; inputTokens: number; failures: number; so1Calls: number; so1Failures: number };
const tagUsage = new Map<string, Usage>();
const MAX_TAGS = 2000;
function tagOf(request: Request): string | null {
  const t = new URL(request.url).searchParams.get("tag");
  return t && /^[A-Za-z0-9_.:-]{1,80}$/.test(t) ? t : null;
}
function charge(tag: string | null, f: (u: Usage) => void) {
  if (!tag) return;
  let u = tagUsage.get(tag);
  if (!u) {
    if (tagUsage.size >= MAX_TAGS) return;
    u = { calls: 0, inputTokens: 0, failures: 0, so1Calls: 0, so1Failures: 0 };
    tagUsage.set(tag, u);
  }
  f(u);
}
let botInFlight = 0;
// A 402 (org out of credits) or 401 will not fix itself mid-match; stop
// calling for a while instead of failing every decision, and say so once.
let jevBlockedUntil = 0;
const JEV_BLOCK_MS = 5 * 60_000;
const FALLBACK = { focusId: null, goalId: null };

async function handleBot(request: Request, origin: string | null): Promise<Response> {
  let situation;
  try {
    situation = parseSituation(JSON.parse(await request.text()));
  } catch (err) {
    return json({ error: `bad request: ${(err as Error).message}` }, 400, origin);
  }
  if (situation.mind === "so1") return handleSo1(situation, tagOf(request), origin);
  if (isArm(situation.mind)) return handleArm(situation, situation.mind, tagOf(request), origin);
  if (!jev) return json({ ...FALLBACK, source: "no-key" }, 200, origin);
  if (botCalls >= BOT_MAX_CALLS) return json({ ...FALLBACK, source: "ceiling" }, 200, origin);
  if (botInFlight >= BOT_MAX_IN_FLIGHT) return json({ ...FALLBACK, source: "busy" }, 200, origin);
  if (Date.now() < jevBlockedUntil) return json({ ...FALLBACK, source: "blocked" }, 200, origin);

  const tag = tagOf(request);
  botCalls++;
  charge(tag, (u) => u.calls++);
  botInFlight++;
  const started = Date.now();
  try {
    const persona = personaOf(situation);
    const { answers, inputTokens } = await askJev(jev, buildState(situation, persona), buildQuestions(situation, persona));
    botTokens += inputTokens;
    charge(tag, (u) => (u.inputTokens += inputTokens));
    const decision = decide(situation, answers);
    console.warn(`[bot-mind] ok ms=${Date.now() - started} tokens=${inputTokens} calls=${botCalls} totalTokens=${botTokens} persona=${persona.key} focus=${decision.focusId ?? "-"} goal=${decision.goalId ?? "-"}`);
    return json({ ...decision, persona: persona.key, source: "jev" }, 200, origin);
  } catch (err) {
    botFailures++;
    charge(tag, (u) => u.failures++);
    const kind = err instanceof JevError ? err.message : "internal";
    console.error(`[bot-mind] failed kind=${kind} ms=${Date.now() - started}`);
    if (err instanceof JevError && (err.status === 402 || err.status === 401)) {
      jevBlockedUntil = Date.now() + JEV_BLOCK_MS;
      console.error(`[bot-mind] BLOCKED: TypeSafe answered ${err.status} (${err.status === 402 ? "organization out of credits" : "key rejected"}). Bots fall back to Frogbot for ${JEV_BLOCK_MS / 60000} min.`);
      return json({ ...FALLBACK, source: "blocked" }, 200, origin);
    }
    return json({ ...FALLBACK, source: "error" }, 200, origin);
  } finally {
    botInFlight--;
  }
}

async function handleArm(situation: BotSituation, mind: string, tag: string | null, origin: string | null): Promise<Response> {
  const name = armName(mind);
  const cfg = arms.get(name);
  if (!cfg) return json({ ...FALLBACK, source: "no-arm" }, 200, origin);
  const perTag = tag ? (tagArms.get(tag) ?? (tagArms.size < MAX_TAGS ? tagArms.set(tag, new ArmStats()).get(tag) : undefined)) : undefined;
  if ((armInFlight.get(name) ?? 0) >= ARM_MAX_IN_FLIGHT) {
    armStats.busy(name); perTag?.busy(name);
    return json({ ...FALLBACK, source: "busy" }, 200, origin);
  }
  armInFlight.set(name, (armInFlight.get(name) ?? 0) + 1);
  const started = Date.now();
  try {
    const persona = personaOf(situation);
    let { answers } = await askJev(cfg, buildState(situation, persona), buildQuestions(situation, persona));
    if (SO1_ORDER_AVERAGE) {
      const r = reversedSituation(situation);
      const second = await askJev(cfg, buildState(r, persona), buildQuestions(r, persona));
      answers = averageAnswers(answers, second.answers, concentration);
    }
    const decision = decide(situation, answers);
    const ms = Date.now() - started;
    armStats.ok(name, ms); perTag?.ok(name, ms);
    return json({ ...decision, persona: persona.key, source: mind }, 200, origin);
  } catch (err) {
    armStats.fail(name); perTag?.fail(name);
    console.error(`[bot-mind] arm ${name} failed kind=${err instanceof JevError ? err.message : "internal"} ms=${Date.now() - started}`);
    return json({ ...FALLBACK, source: "error" }, 200, origin);
  } finally {
    armInFlight.set(name, (armInFlight.get(name) ?? 1) - 1);
  }
}

async function handleSo1(situation: BotSituation, tag: string | null, origin: string | null): Promise<Response> {
  if (!so1) return json({ ...FALLBACK, source: "no-so1" }, 200, origin);
  if (so1InFlight >= SO1_MAX_IN_FLIGHT) return json({ ...FALLBACK, source: "busy" }, 200, origin);
  so1Calls++;
  charge(tag, (u) => u.so1Calls++);
  so1InFlight++;
  const started = Date.now();
  try {
    const persona = personaOf(situation);
    let { answers } = await askJev(so1, buildState(situation, persona), buildQuestions(situation, persona));
    if (SO1_ORDER_AVERAGE) {
      const r = reversedSituation(situation);
      const second = await askJev(so1, buildState(r, persona), buildQuestions(r, persona));
      answers = averageAnswers(answers, second.answers, concentration);
    }
    const decision = decide(situation, answers);
    console.warn(`[bot-mind] so1 ok ms=${Date.now() - started} calls=${so1Calls} persona=${persona.key} focus=${decision.focusId ?? "-"} (conf ${decision.debug.focus?.toFixed(2) ?? "-"}) goal=${decision.goalId ?? "-"}`);
    return json({ ...decision, persona: persona.key, source: "so1" }, 200, origin);
  } catch (err) {
    so1Failures++;
    charge(tag, (u) => u.so1Failures++);
    console.error(`[bot-mind] so1 failed kind=${err instanceof JevError ? err.message : "internal"} ms=${Date.now() - started}`);
    return json({ ...FALLBACK, source: "error" }, 200, origin);
  } finally {
    so1InFlight--;
  }
}

async function handleAudio(id: string, origin: string | null): Promise<Response> {
  const entry = audio.get(id);
  if (!entry) return json({ error: "no such audio" }, 404, origin);
  try {
    const a = await entry.p;
    return new Response(a.bytes, { status: 200, headers: { "Content-Type": a.type, ...cors(origin) } });
  } catch {
    return json({ error: "tts failed" }, 502, origin);
  }
}

Deno.serve({ hostname: "127.0.0.1", port: PORT }, (request) => {
  const origin = request.headers.get("Origin");
  if (!originAllowed(origin)) return json({ error: "origin not allowed" }, 403, null);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin ?? "*",
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin",
      },
    });
  }

  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/npc") return handleNpc(request, origin);
  if (request.method === "POST" && path === "/bot") return handleBot(request, origin);
  // spend so far, for the benchmark to record per match (no secrets in it)
  if (request.method === "GET" && path === "/bot/usage") {
    const tag = tagOf(request);
    if (tag) return json({ tag, ...(tagUsage.get(tag) ?? { calls: 0, inputTokens: 0, failures: 0, so1Calls: 0, so1Failures: 0 }), arms: tagArms.get(tag)?.summary() ?? {} }, 200, origin);
    return json({ calls: botCalls, inputTokens: botTokens, failures: botFailures, ceiling: BOT_MAX_CALLS, so1Calls, so1Failures, arms: armStats.summary(), armNames: [...arms.keys()] }, 200, origin);
  }
  const m = path.match(/^\/audio\/([a-f0-9]{32})$/);
  if (request.method === "GET" && m) return handleAudio(m[1], origin);
  return json({ error: "not found" }, 404, origin);
});

const where = backend === "divinci" ? `divinci @ ${new URL(divinci!.apiUrl).host}, ${Object.keys(releases).length} releases`
  : backend === "anthropic" ? `anthropic ${CLAUDE_MODEL}` : "MOCK";
console.warn(`[npc-brain] listening on http://127.0.0.1:${PORT} (${where}; bot mind: ${jev ? `jev ${jev.model}, ceiling ${BOT_MAX_CALLS}` : "jev off (no TYPESAFE_API_KEY)"}; ${so1 ? `so1 @ ${so1.url}` : "so1 off (no SO1_API_URL)"})`);
