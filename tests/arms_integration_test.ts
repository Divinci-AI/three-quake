// Starts a fake Jev-compatible model server and the REAL brain as a subprocess, then asks it for bot decisions.
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const sit = (mind: string) => ({ mind, persona: "bully", bot: { name: "Ranger", health: 50, armor: 0, weapon: "shotgun", frags: 1 },
  opponents: [{ id: "p2", name: "Grunt", frags: 3, distance: 300, killedMeRecently: 1 }, { id: "p3", name: "Ogre", frags: 0, distance: 900, killedMeRecently: 0 }], items: [] });

Deno.test({ name: "brain routes arm:<name> to its server, averages both option orders, and accounts per arm", sanitizeOps: false, sanitizeResources: false, async fn() {
  const seen: { auth: string | null; keys: string[] }[] = [];
  let fail = false;
  const fake = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const b = await req.json();
    seen.push({ auth: req.headers.get("authorization"), keys: Object.keys(b.questions.focus.criteria) });
    if (fail) return new Response("boom", { status: 500 });
    // always prefers whichever option is called p3 (so order does not matter) with 0.9
    const probs: Record<string, number> = {};
    for (const k of Object.keys(b.questions.focus.criteria)) probs[k] = k === "p3" ? 0.9 : 0.05;
    return Response.json({ model: "fake", answers: { focus: { type: "choice", choice: "p3", probabilities: probs, confidence: 0.9 } } });
  });
  const brainPort = 18000 + Math.floor(Math.random() * 1000);
  const cmd = new Deno.Command(Deno.execPath(), { args: ["run", "--allow-net", "--allow-env", "--allow-read=npc-brain", "npc-brain/main.ts"], stdout: "null", stderr: "null",
    env: { NPC_BRAIN_PORT: String(brainPort), MIND_ARMS: `fake=http://127.0.0.1:${fake.addr.port}`, MIND_ARMS_TOKEN: "secret-token-xyz" } });
  const child = cmd.spawn();
  const base = `http://127.0.0.1:${brainPort}`;
  try {
    for (let i = 0; i < 60; i++) { try { await (await fetch(`${base}/bot/usage`)).text(); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    const post = (mind: string) => fetch(`${base}/bot?tag=t1`, { method: "POST", body: JSON.stringify(sit(mind)) }).then((r) => r.json());
    const ok = await post("arm:fake");
    assert(ok.source === "arm:fake" && ok.focusId === "p3", JSON.stringify(ok));
    assert(seen.length === 2, `both option orders asked, got ${seen.length}`);
    assert(seen[0].auth === "Bearer secret-token-xyz", "bearer sent to the arm");
    assert(seen[0].keys.join() !== seen[1].keys.join(), "second call reversed the options");
    const unknown = await post("arm:nope");
    assert(unknown.source === "no-arm" && unknown.focusId === null, JSON.stringify(unknown));
    fail = true;
    const bad = await post("arm:fake");
    assert(bad.source === "error" && bad.focusId === null, JSON.stringify(bad));
    const u = await (await fetch(`${base}/bot/usage?tag=t1`)).json();
    assert(u.arms.fake.calls === 2 && u.arms.fake.failures === 1, JSON.stringify(u));
    const all = await (await fetch(`${base}/bot/usage`)).json();
    assert(all.armNames.join() === "fake" && JSON.stringify(all).indexOf("secret-token-xyz") < 0, "no secret in usage");
  } finally { child.kill(); await child.status; await fake.shutdown(); }
} });
