import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalogFile } from "../src/catalog.js";

const { tools } = loadCatalogFile("github_catalog.json");
const bySlug = new Map(tools.map((t) => [t.slug, t]));

const GOLD_FILES = ["eval/github.gold.json", "eval/github.holdout.json"];

/** The labels are hand-written, so guard them: a typo'd slug would silently count as a miss. */
for (const file of GOLD_FILES) {
  const gold = JSON.parse(readFileSync(file, "utf-8"));

  test(`${file}: labels refer to real tools and real required parameters`, () => {
    const problems: string[] = [];
    const checkConsumer = (c: { consumer: string; param: string }, label: string) => {
      const tool = bySlug.get(c.consumer);
      if (!tool) return problems.push(`${label}: unknown consumer ${c.consumer}`);
      const input = tool.inputs.find((i) => i.name === c.param);
      if (!input) problems.push(`${label}: ${c.consumer} has no param ${c.param}`);
      else if (!input.required) problems.push(`${label}: ${c.consumer}.${c.param} is not required`);
    };
    for (const c of gold.cases) {
      checkConsumer(c, "case");
      for (const p of [...c.accept, ...c.reject]) if (!bySlug.has(p)) problems.push(`case ${c.consumer}.${c.param}: unknown producer ${p}`);
    }
    gold.negatives.forEach((n: any) => checkConsumer(n, "negative"));
    gold.ambiguous.forEach((a: any) => checkConsumer(a, "ambiguous"));
    assert.deepEqual(problems, []);
  });

  test(`${file}: accepted producers expose output and do not need the value they supply`, () => {
    const problems: string[] = [];
    for (const c of gold.cases) {
      for (const p of c.accept) {
        const tool = bySlug.get(p)!;
        if (tool.outputs.length === 0) problems.push(`${p} accepted for ${c.consumer}.${c.param} but exposes no output`);
        if (tool.inputs.some((i) => i.required && i.name === c.param)) problems.push(`${p} accepted for ${c.param} but itself requires ${c.param}`);
      }
    }
    assert.deepEqual(problems, []);
  });

  test(`${file}: no producer is both accepted and rejected, and no case is duplicated`, () => {
    for (const c of gold.cases) {
      assert.deepEqual(c.accept.filter((p: string) => c.reject.includes(p)), [], `${c.consumer}.${c.param}`);
    }
    const keys = gold.cases.map((c: any) => `${c.consumer}|${c.param}`);
    assert.equal(new Set(keys).size, keys.length);
  });
}

test("the held-out set does not reuse a (consumer, param) pair from the tuning set", () => {
  const key = (c: any) => `${c.consumer}|${c.param}`;
  const tuning = new Set(JSON.parse(readFileSync(GOLD_FILES[0], "utf-8")).cases.map(key));
  const reused = JSON.parse(readFileSync(GOLD_FILES[1], "utf-8")).cases.map(key).filter((k: string) => tuning.has(k));
  assert.deepEqual(reused, []);
});
