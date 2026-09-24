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
  apiKey: string; // empty for a local server that needs none
  url: string;
  model: string;
  timeoutMs: number;
  // "reported": use the server's own confidence (Jev: distribution concentration).
  // "concentration": recompute it from the probabilities, for servers whose
  // confidence is just the top probability (so1), so a 2-option choice can't
  // clear the gate by construction.
  confidence: "reported" | "concentration";
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
    confidence: "reported",
  };
}

// open-alternative-jev (so1) behind a local /v1/systemone-compatible server,
// e.g. notebooks/2026-09-23-djev-commander/so1_server.py in the monorepo.
// Off unless SO1_API_URL is set; free per call, so no spend ceiling applies.
export function so1ConfigFromEnv(): JevConfig | null {
  const url = Deno.env.get("SO1_API_URL");
  if (!url) return null;
  return { apiKey: "", url, model: "so1", timeoutMs: Number(Deno.env.get("SO1_TIMEOUT_MS") ?? 5000), confidence: "concentration" };
}

// 1 - H(p)/ln(n): 0 for a uniform answer, 1 for a certain one.
export function concentration(probabilities: Record<string, number>): number {
  const p = Object.values(probabilities).filter((x) => Number.isFinite(x) && x > 0);
  const n = Object.keys(probabilities).length;
  if (n < 2) return 1;
  const h = -p.reduce((s, x) => s + x * Math.log(x), 0);
  return Math.max(0, Math.min(1, 1 - h / Math.log(n)));
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
      headers: { ...(cfg.apiKey ? { "Authorization": `Bearer ${cfg.apiKey}` } : {}), "Content-Type": "application/json" },
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
  if (cfg.confidence === "concentration") {
    for (const a of Object.values(data.answers)) {
      if ((a.type === "choice" || a.type === "score") && a.probabilities) a.confidence = concentration(a.probabilities);
    }
  }
  return { answers: data.answers, inputTokens: Number(data.usage?.input_tokens ?? 0) };
}
