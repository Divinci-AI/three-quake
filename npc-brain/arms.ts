// Named "arms" for the decision-model tournament: any open System One model (Clef, decider, d3, so1...) behind a
// Jev-compatible /v1/systemone URL. A bot slot says `arm:<name>`; MIND_ARMS maps names to URLs.
//   MIND_ARMS="clef-flash=https://192.168.2.89:8443/dm/clef-flash,decider-4b=https://192.168.2.89:8443/dm/decider-4b"
//   MIND_ARMS_TOKEN=<bearer for the Jetson proxy>   (environment only, never logged)
// Free per call, so there is no spend ceiling; each arm gets a small in-flight cap and per-arm latency accounting.
import type { JevConfig } from "./jev.ts";

export const ARM_RE = /^arm:[a-z0-9][a-z0-9._-]{0,23}$/;
export const isArm = (mind: unknown): mind is `arm:${string}` => typeof mind === "string" && ARM_RE.test(mind);
export const armName = (mind: string) => mind.slice(4);

export function parseArms(spec: string | undefined, token: string | undefined, timeoutMs = 5000): Map<string, JevConfig> {
  const arms = new Map<string, JevConfig>();
  for (const part of (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    const name = i > 0 ? part.slice(0, i).trim() : "";
    let url = i > 0 ? part.slice(i + 1).trim() : "";
    if (!ARM_RE.test(`arm:${name}`)) throw new Error(`MIND_ARMS: bad arm name ${JSON.stringify(name)}`);
    if (!/^https?:\/\//.test(url)) throw new Error(`MIND_ARMS: arm ${name} needs an http(s) URL`);
    if (arms.has(name)) throw new Error(`MIND_ARMS: duplicate arm ${name}`);
    url = url.replace(/\/+$/, "");
    if (!url.endsWith("/v1/systemone")) url += "/v1/systemone";
    arms.set(name, { apiKey: token ?? "", url, model: name, timeoutMs, confidence: "concentration" });
  }
  return arms;
}

export interface ArmStat { calls: number; failures: number; ms: number; slowest: number; busy: number }
export class ArmStats {
  private s = new Map<string, ArmStat>();
  get(name: string): ArmStat {
    let v = this.s.get(name);
    if (!v) { v = { calls: 0, failures: 0, ms: 0, slowest: 0, busy: 0 }; this.s.set(name, v); }
    return v;
  }
  ok(name: string, ms: number) { const v = this.get(name); v.calls++; v.ms += ms; v.slowest = Math.max(v.slowest, ms); }
  fail(name: string) { const v = this.get(name); v.calls++; v.failures++; }
  busy(name: string) { this.get(name).busy++; }
  summary() { return Object.fromEntries([...this.s].map(([k, v]) => [k, { ...v, meanMs: v.calls - v.failures ? Math.round(v.ms / (v.calls - v.failures)) : null }])); }
}
