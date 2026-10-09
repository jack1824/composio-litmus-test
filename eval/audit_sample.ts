/**
 * Draw the samples for an independent audit of the generated graph and write them as "cards" a
 * reviewer (human or model) can judge WITHOUT seeing the matcher's scores or reasoning.
 *
 *   precision sample: random emitted edges, each shown as consumer input + producer tool
 *   recall sample:    random required inputs, stratified by how the matcher treated them, shown
 *                     without any of our edges, so a reviewer can say where the value really comes from
 *
 * Usage: node --import tsx eval/audit_sample.ts <outDir> [seed] [nEdges] [nInputs]
 * Sampling is seeded, so the same inputs always draw the same sample.
 */
import { mkdirSync, writeFileSync } from "fs";
import { loadCatalogFile, type Tool } from "../src/catalog.js";
import { buildGraph } from "../src/graph.js";
import { classifyInputs } from "../src/infer.js";

const [outDir, seedArg = "7", nEdgesArg = "100", nInputsArg = "60"] = process.argv.slice(2);
if (!outDir) throw new Error("usage: audit_sample.ts <outDir> [seed] [nEdges] [nInputs]");
mkdirSync(outDir, { recursive: true });

function rng(seed: number) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const random = rng(Number(seedArg));
function sample<T>(items: T[], n: number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
const chunk = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

const { tools } = loadCatalogFile("github_catalog.json");
const by = new Map(tools.map((t) => [t.slug, t]));
const graph = buildGraph(tools);
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

const consumerCard = (t: Tool, param: string) => ({
  slug: t.slug,
  description: cut(t.description.replace(/\s+/g, " "), 320),
  input: { name: param, description: cut(t.inputs.find((i) => i.name === param)?.description ?? "", 280) },
  requiredInputs: t.inputs.filter((i) => i.required).map((i) => i.name),
});
const producerCard = (t: Tool) => ({
  slug: t.slug,
  description: cut(t.description.replace(/\s+/g, " "), 320),
  requiredInputs: t.inputs.filter((i) => i.required).map((i) => i.name),
  returns: t.outputs.filter((o) => o.containers.length <= 2).slice(0, 40).map((o) => [...o.containers, o.name].join(".") + (o.inArray ? "[]" : "")),
});

// ---- precision sample: edges ----------------------------------------------------------------
const edges = sample(graph.edges, Number(nEdgesArg)).map((e, i) => ({
  id: i + 1,
  need: consumerCard(by.get(e.to)!, e.label),
  proposedProducer: producerCard(by.get(e.from)!),
}));
// two independent judge sets see the same edges in different orders and groupings
const setA = chunk(edges, 20);
const setB = chunk(sample(edges, edges.length), 20);
setA.forEach((c, i) => writeFileSync(`${outDir}/edges_A${i + 1}.json`, JSON.stringify(c, null, 1)));
setB.forEach((c, i) => writeFileSync(`${outDir}/edges_B${i + 1}.json`, JSON.stringify(c, null, 1)));
writeFileSync(`${outDir}/edges_truth_key.json`, JSON.stringify(edges.map((e, i) => ({ id: e.id, from: graph.edges.find((g) => g.to === e.need.slug && g.label === e.need.input.name && g.from === e.proposedProducer.slug)!.from, to: e.need.slug, label: e.need.input.name })), null, 1));

// ---- recall sample: inputs ------------------------------------------------------------------
const emitted = new Set(graph.edges.map((e) => `${e.to}|${e.label}`));
const all = classifyInputs(tools).filter((c) => c.status !== "ambient");
const strata = {
  withEdges: all.filter((c) => c.status === "considered" && emitted.has(`${c.consumer}|${c.param}`)),
  consideredNoEdges: all.filter((c) => c.status === "considered" && !emitted.has(`${c.consumer}|${c.param}`)),
  excluded: all.filter((c) => c.status === "excluded"),
};
const nIn = Number(nInputsArg);
const picked = [...sample(strata.withEdges, Math.round(nIn * 0.4)), ...sample(strata.consideredNoEdges, Math.round(nIn * 0.3)), ...sample(strata.excluded, Math.round(nIn * 0.3))];
const needs = sample(picked, picked.length).map((c, i) => ({ id: i + 1, ...consumerCard(by.get(c.consumer)!, c.param) }));
chunk(needs, 20).forEach((c, i) => writeFileSync(`${outDir}/needs_${i + 1}.json`, JSON.stringify(c, null, 1)));
writeFileSync(`${outDir}/needs_key.json`, JSON.stringify(sample(picked, picked.length).length ? needs.map((n) => {
  const c = picked.find((p) => p.consumer === n.slug && p.param === n.input.name)!;
  return { id: n.id, consumer: c.consumer, param: c.param, status: c.status, ourProducers: graph.edges.filter((e) => e.to === c.consumer && e.label === c.param).map((e) => e.from) };
}) : [], null, 1));

console.error(`edges: ${edges.length} in ${setA.length}+${setB.length} batches; inputs: ${needs.length} in ${chunk(needs, 20).length} batches (strata sizes: ${Object.entries(strata).map(([k, v]) => `${k}=${v.length}`).join(", ")})`);
