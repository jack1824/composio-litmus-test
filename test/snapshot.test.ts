import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalogFile } from "../src/catalog.js";
import { buildGraph } from "../src/graph.js";

test("the GitHub graph matches the committed golden snapshot exactly (update deliberately with `npm run snapshot`)", () => {
  const expected = readFileSync("eval/github.edges.snapshot.txt", "utf-8").trim().split("\n");
  const actual = buildGraph(loadCatalogFile("github_catalog.json").tools).edges.map((e) => `${e.from} > ${e.to} . ${e.label}`).sort();
  const want = new Set(expected), have = new Set(actual);
  const added = actual.filter((l) => !want.has(l)), removed = expected.filter((l) => !have.has(l));
  assert.deepEqual({ added: added.slice(0, 10), removed: removed.slice(0, 10), counts: [actual.length, expected.length] }, { added: [], removed: [], counts: [expected.length, expected.length] });
});
