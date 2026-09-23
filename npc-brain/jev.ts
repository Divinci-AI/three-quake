// Minimal client for TypeSafe's System One API (model: Jev). Plain fetch,
// like the monorepo's categorize-text/typesafe-direct.ts and the
// meeting-pager worker: no SDK, a hard timeout, the body read as text, and
// errors reported by class only (never the message text, never the key).

export type JevQuestion =
  | { type: "noul"; instructions: string | Record<string, unknown>; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string | Record<string, unknown>; criteria: Record<string, string> }
  | { type: "score"; instructions: string | Record<string, unknown>; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> };

export interface JevConfig {
  apiKey: string;
  url: string;
  model: string;
  timeoutMs: number;
}

export class JevError extends Error {
  constructor(readonly kind: "timeout" | "http" | "unparseable" | "malformed", readonly status = 0) {
    super(`jev ${kind}${status ? ` ${status}` : ""}`);
  }
}

export function jevConfigFromEnv(): JevConfig | null {
  const apiKey = Deno.env.get("TYPESAFE_API_KEY");
  if (!apiKey) return null;
  return {
    apiKey,
    url: Deno.env.get("TYPESAFE_API_URL") ?? "https://api.typesafe.ai/v1/systemone",
    model: Deno.env.get("TYPESAFE_MODEL") ?? "jev-latest",
    timeoutMs: Number(Deno.env.get("TYPESAFE_TIMEOUT_MS") ?? 2500),
  };
}

export async function askJev(
  cfg: JevConfig,
  state: Record<string, unknown>,
  questions: Record<string, JevQuestion>,
): Promise<{ answers: Record<string, JevAnswer>; inputTokens: number }> {
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, state, questions }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    throw new JevError((err as Error).name === "TimeoutError" ? "timeout" : "http");
  }
  const text = await res.text();
  if (!res.ok) throw new JevError("http", res.status);
  let data: { answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number } };
  try {
    data = JSON.parse(text);
  } catch {
    throw new JevError("unparseable", res.status);
  }
  if (!data.answers || typeof data.answers !== "object") throw new JevError("malformed", res.status);
  return { answers: data.answers, inputTokens: Number(data.usage?.input_tokens ?? 0) };
}
