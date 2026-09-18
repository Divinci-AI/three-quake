// Runs the Divinci client against a local stand-in API to pin the request
// shapes (paths, auth header, bodies) and the response parsing.
import { chat, createRelease, listReleases, setEnrichment, tts } from "../npc-brain/divinci.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

Deno.test("divinci client sends the documented v1 requests", async () => {
  const seen: { method: string; path: string; key: string | null; body: unknown }[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const body = req.method === "GET" ? null : JSON.parse(await req.text());
    seen.push({ method: req.method, path: url.pathname, key: req.headers.get("x-api-key"), body });
    const ok = (o: unknown) => Response.json(o);
    if (url.pathname === "/api/v1/releases" && req.method === "GET") return ok([{ _id: "r1", slug: "quake-army", title: "t", status: "draft" }]);
    if (url.pathname === "/api/v1/releases") return ok({ _id: "r2", slug: "quake-ogre", title: "t", status: "draft" });
    if (url.pathname.endsWith("/enrichment")) return ok({ applied: ["persona"], skipped: [] });
    if (url.pathname === "/api/v1/chat/completions") return ok({ choices: [{ message: { content: '{"line":"Halt.","action":"none"}' } }], transcriptId: "t1" });
    if (url.pathname === "/api/v1/tts/generate") return ok({ url: "https://audio.example/x.mp3" });
    return new Response("nope", { status: 404 });
  });
  const cfg = { apiUrl: `http://127.0.0.1:${server.addr.port}`, apiKey: "divinci_test" };
  try {
    assert((await listReleases(cfg))[0].slug === "quake-army", "list");
    await createRelease(cfg, { slug: "quake-ogre", title: "Quake NPC: Ogre", description: "d", assistant: { id: "@cf/x", finetune: false } });
    await setEnrichment(cfg, "r2", { persona: "p", overwrite: true });
    const c = await chat(cfg, { releaseId: "r2", transcriptId: "t0", content: "hello" });
    assert(c.transcriptId === "t1" && c.text.includes("Halt."), "chat parsed");
    assert((await tts(cfg, { text: "Halt.", voice: "zeus" })) === "https://audio.example/x.mp3", "tts url");

    assert(seen.every((s) => s.key === "divinci_test"), "x-api-key on every call");
    const create = seen[1].body as Record<string, unknown>;
    for (const f of ["slug", "title", "description", "allowAnonymousChat", "maxAnonymousChatMessages", "assistant"]) {
      assert(f in create, `create body missing required ${f}`);
    }
    assert(seen[2].method === "PATCH" && seen[2].path === "/api/v1/releases/r2/enrichment", "enrichment route");
    const chatBody = seen[3].body as Record<string, unknown>;
    assert(chatBody.releaseId === "r2" && chatBody.transcriptId === "t0", "chat pins release + transcript");
    const ttsBody = seen[4].body as Record<string, unknown>;
    assert(ttsBody.voice === "zeus" && ttsBody.provider === "aura-2" && ttsBody.encoding === "mp3", "tts uses voice/encoding, not voiceId/format");
  } finally {
    await server.shutdown();
  }
});

Deno.test("divinci client surfaces non-JSON errors with the status", async () => {
  const server = Deno.serve({ port: 0, onListen() {} }, () => new Response("<html>502</html>", { status: 502 }));
  try {
    await chat({ apiUrl: `http://127.0.0.1:${server.addr.port}`, apiKey: "k" }, { releaseId: "r", content: "x" });
    throw new Error("expected a throw");
  } catch (err) {
    assert((err as Error).message.includes("502"), (err as Error).message);
  } finally {
    await server.shutdown();
  }
});
