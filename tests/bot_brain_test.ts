import { BOT_PERSONAS, personaOf, buildQuestions, buildState, decide, parseSituation, personaFor, MIN_CONFIDENCE } from "../npc-brain/bots.ts";
import type { JevAnswer } from "../npc-brain/jev.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const raw = {
  bot: { name: "Reptile", health: 45, armor: 0, weapon: "shotgun", frags: 2 },
  opponents: [
    { id: "p1", name: "player", frags: 5, distance: 400, killedMeRecently: 2 },
    { id: "p131", name: "goldenboy", frags: 1, distance: 900, killedMeRecently: 0 },
  ],
  items: [{ id: "i71", item: "nailgun", distance: 300 }],
};

Deno.test("parseSituation rejects bad ids and strips unsafe text", () => {
  const s = parseSituation({ ...raw, opponents: [{ ...raw.opponents[0], name: "Evil\u0000Nameÿ" }] });
  assert(s.opponents[0].name === "EvilName", s.opponents[0].name);
  let threw = false;
  try { parseSituation({ ...raw, items: [{ id: "i71; DROP", item: "x", distance: 1 }] }); } catch { threw = true; }
  assert(threw, "an id outside the pattern must be refused");
});

const greedy = BOT_PERSONAS.find((p) => p.key === "greedy")!;
const vindictive = BOT_PERSONAS.find((p) => p.key === "vindictive")!;

Deno.test("every option Jev can pick comes from the situation, plus none", () => {
  const q = buildQuestions(parseSituation(raw), greedy);
  assert(q.focus.type === "choice" && Object.keys(q.focus.criteria).sort().join() === "none,p1,p131", JSON.stringify(q.focus));
  assert(q.goal?.type === "choice" && Object.keys(q.goal.criteria).sort().join() === "i71,none", "goal options");
  const st = buildState(parseSituation(raw), personaFor("Reptile"));
  assert(!JSON.stringify(st).includes("p131"), "ids stay out of the state; only criteria carry them");
});

Deno.test("one call asks the least it can: no taunt question, items only for greedy", () => {
  const qv = buildQuestions(parseSituation(raw), vindictive);
  assert(Object.keys(qv).join() === "focus", `vindictive asks only focus, got ${Object.keys(qv)}`);
  assert(!JSON.stringify(buildState(parseSituation(raw), vindictive)).includes("nailgun"), "no items in a non-greedy state");
  const qg = buildQuestions(parseSituation({ ...raw, items: [] }), greedy);
  assert(Object.keys(qg).join() === "focus", "greedy with nothing worth grabbing asks only focus");
  assert(!("taunt_now" in buildQuestions(parseSituation(raw), greedy)), "taunting is a code rule now");
});

Deno.test("decide is confidence-gated and ignores options that were never offered", () => {
  const s = parseSituation(raw);
  const a = (choice: string, confidence: number): JevAnswer => ({ type: "choice", choice, confidence, probabilities: {} });
  const d1 = decide(s, { focus: a("p1", 0.8), goal: a("i71", 0.9) });
  assert(d1.focusId === "p1" && d1.goalId === "i71", JSON.stringify(d1));
  const d2 = decide(s, { focus: a("p1", MIN_CONFIDENCE - 0.01), goal: a("i99", 0.99) });
  assert(d2.focusId === null && d2.goalId === null, JSON.stringify(d2));
  const d3 = decide(s, {});
  assert(d3.focusId === null && d3.goalId === null, "no answers -> Frogbot decides");
});

Deno.test("persona assignment is stable per name", () => {
  assert(personaFor("Reptile").key === personaFor("Reptile").key, "stable");
});

Deno.test("an engine-pinned persona wins over the name hash; an unknown one is ignored", () => {
  assert(personaOf(parseSituation({ ...raw, persona: "bully" })).key === "bully", "pinned");
  const fromName = personaFor(raw.bot.name).key;
  assert(personaOf(parseSituation({ ...raw, persona: "admin; drop" })).key === fromName, "unknown key falls back to the name");
  assert(personaOf(parseSituation(raw)).key === fromName, "absent falls back to the name");
});
