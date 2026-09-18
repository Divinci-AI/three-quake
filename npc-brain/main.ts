// npc-brain -- the only process that talks to the model.
//
// The game (browser or Deno game server) POSTs { character, playerSaid,
// history, context } and gets back { line, action }. Keeping this a separate
// service means the API key never ships to a browser, and the game only ever
// sees two validated fields.
//
//   ANTHROPIC_API_KEY=... deno task brain           # real replies
//   NPC_BRAIN_MOCK=1 deno task brain                # canned replies, no key
//
// Env: NPC_BRAIN_PORT (8797), NPC_MODEL (claude-opus-5), NPC_EFFORT (low),
//      NPC_ALLOWED_ORIGINS (comma list; loopback origins are always allowed)

import Anthropic from "npm:@anthropic-ai/sdk@^0.126.0";
import { buildSystemPrompt, buildUserTurn, parseRequest, REPLY_SCHEMA, type NpcReply } from "./persona.ts";

const PORT = Number(Deno.env.get("NPC_BRAIN_PORT") ?? 8797);
const MODEL = Deno.env.get("NPC_MODEL") ?? "claude-opus-5";
const EFFORT = (Deno.env.get("NPC_EFFORT") ?? "low") as "low" | "medium" | "high";
const MOCK = Deno.env.get("NPC_BRAIN_MOCK") === "1";
const EXTRA_ORIGINS = (Deno.env.get("NPC_ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const client = MOCK ? null : new Anthropic();

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

function json(body: unknown, status: number, origin: string | null): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

const MOCK_LINES = [
  "You talk too much for someone standing in my hallway.",
  "I have orders. You are not in them.",
  "Leave now and I will pretend I never saw you.",
];

async function reply(req: ReturnType<typeof parseRequest>): Promise<NpcReply> {
  if (!client) {
    const line = MOCK_LINES[Math.floor(Math.random() * MOCK_LINES.length)];
    return { line, action: /attack|fight|kill/i.test(req.playerSaid) ? "attack" : "none" };
  }

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: REPLY_SCHEMA },
    },
    system: buildSystemPrompt(req.character),
    messages: [{ role: "user", content: buildUserTurn(req) }],
  });

  if (response.stop_reason === "refusal") {
    return { line: "...", action: "none" };
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error(`no text block (stop_reason=${response.stop_reason})`);
  try {
    return JSON.parse(text.text) as NpcReply;
  } catch {
    throw new Error(`model returned non-JSON: ${text.text.slice(0, 120)}`);
  }
}

Deno.serve({ hostname: "127.0.0.1", port: PORT }, async (request) => {
  const origin = request.headers.get("Origin");
  if (!originAllowed(origin)) return json({ error: "origin not allowed" }, 403, null);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin ?? "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin",
      },
    });
  }
  if (request.method !== "POST" || new URL(request.url).pathname !== "/npc") {
    return json({ error: "not found" }, 404, origin);
  }

  let parsed;
  try {
    parsed = parseRequest(JSON.parse(await request.text()));
  } catch (err) {
    return json({ error: `bad request: ${(err as Error).message}` }, 400, origin);
  }

  try {
    return json(await reply(parsed), 200, origin);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "rate limited" }, 429, origin);
    if (err instanceof Anthropic.APIError) {
      console.error(`[npc-brain] API ${err.status}: ${err.message}`);
      return json({ error: "model error" }, 502, origin);
    }
    console.error("[npc-brain]", err);
    return json({ error: "internal error" }, 500, origin);
  }
});

console.warn(`[npc-brain] listening on http://127.0.0.1:${PORT}/npc (${MOCK ? "MOCK" : `${MODEL}, effort=${EFFORT}`})`);
