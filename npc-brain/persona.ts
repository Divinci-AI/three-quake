// Request validation, per-message prompt building and reply parsing for
// npc-brain. No I/O here so it can be tested without a network or a key.

import { monsterFor, threadPrefixFor } from "./monsters.ts";

export type NpcAction = "none" | "attack";
export type NpcEvent = "talk" | "sight" | "taunt" | "frag" | "death";

export interface NpcReply {
  line: string;
  action: NpcAction;
}

export interface NpcRequest {
  character: string;
  event: NpcEvent;
  playerSaid: string;
  // stable per monster instance for one map; keys the Divinci transcript
  conversationId: string;
  history: { speaker: "player" | "npc"; text: string }[];
  context: {
    map: string;
    distance: number;
    monsterHealth: number;
    playerHealth: number;
    hostileToPlayer: boolean;
    opponent?: string; // bots: the other player this event is about
  };
}

export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    line: { type: "string", description: "What the character says aloud. One or two short sentences." },
    action: { type: "string", enum: ["none", "attack"] },
  },
  required: ["line", "action"],
  additionalProperties: false,
} as const;

// Used only by the direct-Anthropic backend; the Divinci backend keeps the
// same text in each release's thread prefix.
export function buildSystemPrompt(character: string): string {
  return threadPrefixFor(monsterFor(character));
}

const EVENT_TEXT: Record<NpcEvent, string> = {
  talk: "The marine stopped and spoke to you.",
  sight: "You just spotted the marine. Shout something at them. Do not wait for them to speak.",
  taunt: "Nothing specific just happened; you feel like mouthing off at your opponents.",
  frag: "You just fragged the player named in <situation>.",
  death: "You just got fragged by the player named in <situation>.",
};

export function buildUserTurn(req: NpcRequest, { includeHistory }: { includeHistory: boolean }): string {
  const c = req.context;
  if (req.character.startsWith("bot_")) {
    return [
      "<situation>",
      `map: ${c.map}`,
      `your health: ${c.monsterHealth}`,
      ...(c.opponent ? [`other player: ${c.opponent}`] : []),
      "</situation>",
      `<event>${EVENT_TEXT[req.event]}</event>`,
    ].join("\n");
  }
  const lines = [
    "<situation>",
    `map: ${c.map}`,
    `distance to the marine: ${c.distance} units`,
    `your health: ${c.monsterHealth}`,
    `the marine's health: ${c.playerHealth}`,
    `you are currently ${c.hostileToPlayer ? "fighting the marine" : "not yet fighting the marine"}`,
    "</situation>",
    `<event>${EVENT_TEXT[req.event]}</event>`,
  ];
  if (includeHistory && req.history.length > 0) {
    lines.push("<earlier_conversation>");
    for (const turn of req.history) lines.push(`${turn.speaker === "player" ? "Marine" : "You"}: ${turn.text}`);
    lines.push("</earlier_conversation>");
  }
  if (req.event === "talk") lines.push("<player_says>", req.playerSaid, "</player_says>");
  return lines.join("\n");
}

const MAX_SAID = 300;
const MAX_HISTORY = 12;

function str(v: unknown, max: number, field: string): string {
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  return v.slice(0, max);
}

function num(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${field} must be a number`);
  return Math.round(v);
}

// The caller may be a browser, so treat every field as untrusted.
export function parseRequest(raw: unknown): NpcRequest {
  if (!raw || typeof raw !== "object") throw new Error("body must be an object");
  const r = raw as Record<string, unknown>;
  const character = str(r.character, 64, "character");
  if (!/^[a-z0-9_]+$/.test(character)) throw new Error("character must be a classname");

  const event: NpcEvent = (["sight", "taunt", "frag", "death"] as const).find((e) => e === r.event) ?? "talk";
  const playerSaid = event === "talk" ? str(r.playerSaid, MAX_SAID, "playerSaid").trim() : "";
  if (event === "talk" && !playerSaid) throw new Error("playerSaid is empty");

  const conversationId = str(r.conversationId ?? `anon:${character}`, 128, "conversationId");
  if (!/^[A-Za-z0-9_:.-]+$/.test(conversationId)) throw new Error("conversationId has invalid characters");

  const history = (Array.isArray(r.history) ? r.history : []).slice(-MAX_HISTORY).map((t, i) => {
    const turn = t as Record<string, unknown>;
    const speaker = turn?.speaker === "npc" ? "npc" : "player";
    return { speaker, text: str(turn?.text, MAX_SAID, `history[${i}].text`) } as const;
  });

  const ctx = (r.context ?? {}) as Record<string, unknown>;
  return {
    character,
    event,
    playerSaid,
    conversationId,
    history,
    context: {
      map: str(ctx.map ?? "", 64, "context.map").replace(/[^a-zA-Z0-9_]/g, ""),
      distance: num(ctx.distance ?? 0, "context.distance"),
      monsterHealth: num(ctx.monsterHealth ?? 0, "context.monsterHealth"),
      playerHealth: num(ctx.playerHealth ?? 0, "context.playerHealth"),
      hostileToPlayer: ctx.hostileToPlayer === true,
      ...(typeof ctx.opponent === "string" && ctx.opponent
        ? { opponent: ctx.opponent.replace(/[^\x20-\x7e]/g, "").slice(0, 32) }
        : {}),
    },
  };
}

// Open models asked for JSON sometimes wrap it in prose or code fences, or
// skip it entirely. Take the JSON when it is there; otherwise the whole text
// is the line and nothing happens.
// The platform reports a failed generation as a normal-looking reply.
export const PLATFORM_FAILURE = /Failed communicating with AI/i;

export function parseModelReply(text: string): NpcReply {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (PLATFORM_FAILURE.test(cleaned)) throw new Error("the platform reported a failed generation");

  // preferred format: "ACTION: none|attack" and "LINE: ..."
  const lineTag = cleaned.match(/^\s*LINE:\s*(.+)$/im);
  if (lineTag) {
    const actionTag = cleaned.match(/^\s*ACTION:\s*(\w+)/im);
    return { line: lineTag[1].trim().replace(/^["']|["']$/g, ""), action: actionTag?.[1]?.toLowerCase() === "attack" ? "attack" : "none" };
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      if (obj && typeof obj.line === "string") {
        return { line: obj.line.trim(), action: obj.action === "attack" ? "attack" : "none" };
      }
    } catch { /* fall through to plain text */ }
  }
  const line = cleaned.replace(/^```\w*|```$/g, "").replace(/^["']|["']$/g, "").trim();
  return { line, action: "none" };
}

// What TTS should actually say: stage directions are for the screen only.
export function spokenText(line: string): string {
  return line
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
