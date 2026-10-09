import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCatalog } from "../src/catalog.js";
import { verifyCandidates, type ChatClient } from "../src/llm.js";
import type { Candidate } from "../src/infer.js";

const tools = parseCatalog([
  { slug: "X_LIST_A", description: "Lists a.", outputParameters: { type: "object", properties: { data: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "integer" } } } } } } } } },
  { slug: "X_GET_A", description: "Gets a.", inputParameters: { type: "object", required: ["a_id"], properties: { a_id: { type: "integer", description: "The id of a." } } } },
]).tools;

const cand = (score: number, n = 1): Candidate[] =>
  Array.from({ length: n }, (_, i) => ({ producer: "X_LIST_A", consumer: "X_GET_A", param: `a_id${i}`, score, deprecated: false, why: "entity=1 via items.id[]" }));

/** A fake model that answers with a canned reply and counts calls. */
function fake(reply: (call: number, userContent: string) => string | Error) {
  const client = { calls: 0, chat: { completions: { create: async (args: any) => {
    const r = reply(client.calls++, args.messages[1].content);
    if (r instanceof Error) throw r;
    return { choices: [{ message: { content: r } }], usage: { prompt_tokens: 100, completion_tokens: 10 } };
  } } } };
  return client as typeof client & ChatClient;
}

test("dry run counts and estimates but never calls the model", async () => {
  const client = fake(() => "{}");
  const { candidates, report } = await verifyCandidates(tools, cand(0.5, 30), client, { dryRun: true, batchSize: 25 });
  assert.equal(client.calls, 0);
  assert.equal(candidates.length, 30);
  assert.equal(report.sent, 30);
  assert.equal(report.batches, 2);
  assert.ok(report.estimatedPromptTokens > 0);
});

test("only an explicit keep=false for a known id removes an edge", async () => {
  const client = fake(() => JSON.stringify({ judgments: [{ id: 1, keep: false, reason: "wrong scope" }, { id: 2, keep: true, reason: "ok" }, { id: 99, keep: false, reason: "unknown id" }, { id: 3 }] }));
  const input = cand(0.5, 4);
  const { candidates, report } = await verifyCandidates(tools, input, client);
  assert.deepEqual(candidates.map((c) => c.param), ["a_id1", "a_id2", "a_id3"]);
  assert.equal(report.dropped, 1);
  assert.equal(report.promptTokens, 100);
});

test("a failing batch keeps its edges and later batches still run", async () => {
  const client = fake((call) => (call === 0 ? new Error("boom") : JSON.stringify({ judgments: [{ id: 1, keep: false, reason: "x" }] })));
  const { candidates, report } = await verifyCandidates(tools, cand(0.5, 4), client, { batchSize: 2 });
  assert.equal(report.failedBatches, 1);
  assert.equal(candidates.length, 3); // batch 1 kept in full, batch 2 lost one
});

test("malformed or non-JSON answers keep every edge", async () => {
  for (const reply of ["not json", "{}", '{"judgments": "nope"}', ""]) {
    const { candidates } = await verifyCandidates(tools, cand(0.5, 3), fake(() => reply));
    assert.equal(candidates.length, 3, `reply ${JSON.stringify(reply)}`);
  }
});

test("trusted edges are never sent, the cap keeps the least certain first, and nothing is ever added", async () => {
  let sent = "";
  const client = fake((_, content) => ((sent = content), JSON.stringify({ judgments: [] })));
  const input = [...cand(0.95, 3), ...cand(0.6, 2), ...cand(0.5, 2)];
  const { candidates, report } = await verifyCandidates(tools, input, client, { maxEdges: 3, trustAbove: 0.75 });
  assert.equal(report.sent, 3);
  assert.equal(JSON.parse(sent).length, 3);
  assert.ok(candidates.every((c) => input.includes(c)), "output must be a subset of the input");
  assert.equal(candidates.length, input.length);
});

test("without a client, or with nothing doubtful, the input is returned untouched and no request is made", async () => {
  const client = fake(() => "{}");
  assert.equal((await verifyCandidates(tools, cand(0.5, 3), undefined)).candidates.length, 3);
  assert.equal((await verifyCandidates(tools, cand(0.99, 3), client)).candidates.length, 3);
  assert.equal(client.calls, 0);
});

test("cards carry what a reviewer needs and nothing that was not in the catalog", async () => {
  let sent = "";
  const client = fake((_, content) => ((sent = content), JSON.stringify({ judgments: [] })));
  await verifyCandidates(tools, cand(0.5, 1), client);
  const [card] = JSON.parse(sent);
  assert.deepEqual(Object.keys(card).sort(), ["consumer", "id", "producer"]);
  assert.equal(card.consumer.slug, "X_GET_A");
  assert.equal(card.producer.slug, "X_LIST_A");
});

test("a reply that throws midway (a null entry) keeps every edge of that batch, including drops listed before it", async () => {
  const client = fake(() => '{"judgments":[{"id":1,"keep":false,"reason":"x"},null]}');
  const { candidates, report } = await verifyCandidates(tools, cand(0.5, 3), client);
  assert.equal(candidates.length, 3);
  assert.equal(report.failedBatches, 1);
  assert.equal(report.dropped, 0);
});
