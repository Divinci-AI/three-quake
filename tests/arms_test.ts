import { ArmStats, ARM_RE, armName, isArm, parseArms } from "../npc-brain/arms.ts";
import { parseSituation } from "../npc-brain/bots.ts";

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function throws(f: () => unknown, what: string) { let t = false; try { f(); } catch { t = true; } assert(t, what); }

Deno.test("arm names: only arm:<lowercase id>, nothing that could smuggle anything", () => {
  for (const ok of ["arm:clef", "arm:clef-flash", "arm:decider-4b", "arm:d3.edge", "arm:a1_b"]) assert(isArm(ok), ok);
  for (const bad of ["clef", "arm:", "arm:Clef", "arm:-x", "arm:a b", "arm:a/b", "arm:x".padEnd(30, "x"), "jev", "so1", "arm:a;b", "arm:../x", 5, null, undefined]) assert(!isArm(bad), String(bad));
  assert(armName("arm:clef") === "clef" && ARM_RE.test("arm:ok"), "armName");
});

Deno.test("parseArms builds the /v1/systemone URL, carries the token and the arm name", () => {
  const m = parseArms("clef=https://h:8443/dm/clef/, d3=http://127.0.0.1:8082/v1/systemone", "tok");
  const c = m.get("clef")!;
  assert(c.url === "https://h:8443/dm/clef/v1/systemone" && c.apiKey === "tok" && c.model === "clef" && c.confidence === "concentration", JSON.stringify(c));
  assert(m.get("d3")!.url === "http://127.0.0.1:8082/v1/systemone", "no double suffix");
  assert(parseArms(undefined, undefined).size === 0 && parseArms("", "x").size === 0, "empty");
});

Deno.test("parseArms refuses bad names, schemes and duplicates", () => {
  throws(() => parseArms("Clef=http://x", ""), "uppercase name");
  throws(() => parseArms("clef=ftp://x", ""), "ftp scheme");
  throws(() => parseArms("clef=file:///etc/passwd", ""), "file scheme");
  throws(() => parseArms("clef", ""), "no url");
  throws(() => parseArms("a=http://x,a=http://y", ""), "duplicate");
});

Deno.test("parseSituation keeps a valid arm mind and falls back to jev for anything else", () => {
  const base = { bot: { name: "b", health: 1 }, opponents: [], items: [] };
  assert(parseSituation({ ...base, mind: "arm:clef" }).mind === "arm:clef", "arm kept");
  assert(parseSituation({ ...base, mind: "so1" }).mind === "so1", "so1");
  for (const bad of ["arm:Clef", "arm:x y", "random", 3, undefined]) assert(parseSituation({ ...base, mind: bad }).mind === "jev", String(bad));
});

Deno.test("ArmStats counts calls, failures, busy and mean latency of successes only", () => {
  const s = new ArmStats();
  s.ok("a", 100); s.ok("a", 300); s.fail("a"); s.busy("a"); s.ok("b", 50);
  const r = s.summary() as Record<string, { calls: number; failures: number; busy: number; meanMs: number | null; slowest: number }>;
  assert(r.a.calls === 3 && r.a.failures === 1 && r.a.busy === 1 && r.a.meanMs === 200 && r.a.slowest === 300, JSON.stringify(r.a));
  assert(r.b.meanMs === 50, "b");
  const none = new ArmStats(); none.fail("c");
  assert((none.summary() as Record<string, { meanMs: number | null }>).c.meanMs === null, "no successes -> null");
});
