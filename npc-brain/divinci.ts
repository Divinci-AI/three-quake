// Minimal client for the Divinci public API (/api/v1), authenticated with a
// workspace API key. Only the calls npc-brain needs.

export interface DivinciConfig {
  apiUrl: string; // e.g. https://api.stage.divinci.app
  apiKey: string;
}

export class DivinciError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

async function call<T>(cfg: DivinciConfig, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(`${cfg.apiUrl}/api/v1${path}`, {
    method,
    headers: { "x-api-key": cfg.apiKey, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new DivinciError(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status, text);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DivinciError(`${method} ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status, text);
  }
}

export interface Release {
  _id: string;
  slug: string;
  title: string;
  status: string;
  assistant?: { id: string };
  threadPrefix?: { id: string } | null;
}

export async function listReleases(cfg: DivinciConfig): Promise<Release[]> {
  const data = await call<unknown>(cfg, "GET", "/releases");
  if (Array.isArray(data)) return data as Release[];
  const d = data as Record<string, unknown>;
  for (const k of ["releases", "items", "data"]) if (Array.isArray(d[k])) return d[k] as Release[];
  throw new Error(`unexpected /releases shape: ${JSON.stringify(data).slice(0, 200)}`);
}

export function createRelease(cfg: DivinciConfig, body: {
  slug: string;
  title: string;
  description: string;
  assistant: { id: string; finetune: boolean };
  fallbackAssistants?: { id: string; finetune: boolean }[];
}): Promise<Release> {
  return call<Release>(cfg, "POST", "/releases", {
    ...body,
    allowAnonymousChat: false,
    maxAnonymousChatMessages: 0,
  });
}

// Sets the thread prefix (persona), welcome message and starters.
export function setEnrichment(cfg: DivinciConfig, releaseId: string, body: {
  persona: string;
  welcome?: string;
  starters?: string[];
  overwrite: boolean;
}): Promise<{ applied: string[]; skipped: string[] }> {
  return call(cfg, "PATCH", `/releases/${encodeURIComponent(releaseId)}/enrichment`, body);
}

export interface ChatResult {
  text: string;
  transcriptId: string;
}

export async function chat(cfg: DivinciConfig, args: {
  releaseId: string;
  transcriptId?: string;
  content: string;
}): Promise<ChatResult> {
  const data = await call<{
    choices?: { message?: { content?: string } }[];
    transcriptId?: string;
  }>(cfg, "POST", "/chat/completions", {
    releaseId: args.releaseId,
    transcriptId: args.transcriptId,
    messages: [{ role: "user", content: args.content }],
  }, 120_000);
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !data.transcriptId) {
    throw new Error(`unexpected chat response: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { text, transcriptId: data.transcriptId };
}

export async function tts(cfg: DivinciConfig, args: { text: string; voice: string }): Promise<string> {
  const data = await call<{ url?: string }>(cfg, "POST", "/tts/generate", {
    text: args.text,
    provider: "aura-2",
    voice: args.voice,
    encoding: "mp3",
  });
  if (!data.url) throw new Error("tts response had no url");
  return data.url;
}

export function configFromEnv(): DivinciConfig | null {
  const apiKey = Deno.env.get("QUAKE_DIVINCI_API_KEY");
  if (!apiKey) return null;
  const apiUrl = (Deno.env.get("QUAKE_DIVINCI_API_URL") ?? "https://api.stage.divinci.app").replace(/\/+$/, "");
  return { apiUrl, apiKey };
}
