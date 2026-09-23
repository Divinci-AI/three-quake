// Create (or reconcile) one Divinci release per Quake monster type.
//
//   deno task setup-releases            # dry run: shows what would change
//   deno task setup-releases --apply    # create drafts + set thread prefixes
//
// Idempotent: releases are matched by slug, so re-running only fills gaps
// (and, with --apply, refreshes each thread prefix). Writes the classname ->
// releaseId map to npc-brain/releases.json, keyed by API host.
//
// Uses QUAKE_DIVINCI_API_KEY only, never DIVINCI_API_KEY, so a shell that
// holds a production key for other work cannot point the game at it.

import { configFromEnv, createRelease, listReleases, setEnrichment, type Release } from "./divinci.ts";
import { MONSTERS, slugFor, threadPrefixFor } from "./monsters.ts";

const MODEL = Deno.env.get("NPC_DIVINCI_MODEL") ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FALLBACK_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const MANIFEST = new URL("./releases.json", import.meta.url);

const apply = Deno.args.includes("--apply");
const cfg = configFromEnv();
if (!cfg) {
  console.error("QUAKE_DIVINCI_API_KEY is not set.");
  Deno.exit(2);
}

const host = new URL(cfg.apiUrl).host;
console.log(`${apply ? "APPLY" : "DRY RUN"} against ${host} with model ${MODEL}`);

const existing = await listReleases(cfg);
const bySlug = new Map<string, Release>();
for (const r of existing) {
  // prefer a live release over a draft with the same slug
  const prev = bySlug.get(r.slug);
  if (!prev || (prev.status !== "available" && r.status === "available")) bySlug.set(r.slug, r);
}

const manifest: Record<string, Record<string, string>> = await Deno.readTextFile(MANIFEST)
  .then((t) => JSON.parse(t)).catch(() => ({}));
const map: Record<string, string> = {};

for (const m of MONSTERS) {
  const slug = slugFor(m);
  let release = bySlug.get(slug);
  if (release) {
    console.log(`= ${slug.padEnd(22)} exists (${release.status}) ${release._id}`);
  } else if (apply) {
    release = await createRelease(cfg, {
      slug,
      title: `Quake NPC: ${m.name}`,
      description: `Voice of the ${m.name} (${m.classname}) in three-quake. Managed by npc-brain/setup-releases.ts.`,
      assistant: { id: MODEL, finetune: false },
      fallbackAssistants: [{ id: FALLBACK_MODEL, finetune: false }],
    });
    console.log(`+ ${slug.padEnd(22)} created ${release._id}`);
  } else {
    console.log(`+ ${slug.padEnd(22)} would create`);
    continue;
  }

  if (apply) {
    const r = await setEnrichment(cfg, release._id, {
      persona: threadPrefixFor(m),
      welcome: m.voice ? `The ${m.name} watches you.` : `The ${m.name} eyes you.`,
      starters: ["Why are you here?", "I don't want to fight.", "Get out of my way."],
      overwrite: true,
    });
    console.log(`  thread prefix set (applied: ${JSON.stringify(r.applied ?? null).slice(0, 80)})`);
  }
  map[m.classname] = release._id;
}

if (apply) {
  manifest[host] = map;
  await Deno.writeTextFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${Object.keys(map).length} releases to npc-brain/releases.json [${host}]`);
}
