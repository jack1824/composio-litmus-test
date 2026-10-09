/**
 * Cards for a blind check of the LLM verifier's decisions: every edge it dropped, plus a random sample of the
 * doubtful edges (score below the trust threshold) that it kept. Judges see neither scores nor which group an
 * edge is in. Usage: node --import tsx eval/audit_verifier.ts <outDir> <deterministic.json> <llm.json> [seed] [nKept]
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { loadCatalogFile, type Tool } from "../src/catalog.js";
import { inferCandidates } from "../src/infer.js";
import { DEFAULT_VERIFY } from "../src/llm.js";

const [outDir, detPath, llmPath, seedArg = "5", nKeptArg = "30"] = process.argv.slice(2);
if (!outDir || !detPath || !llmPath) throw new Error("usage: audit_verifier.ts <outDir> <deterministic.json> <llm.json> [seed] [nKept]");
mkdirSync(outDir, { recursive: true });

let seed = Number(seedArg);
const random = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffle = <T>(a: T[]) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

const { tools } = loadCatalogFile("github_catalog.json");
const by = new Map(tools.map((t) => [t.slug, t]));
const key = (e: { from: string; to: string; label: string }) => `${e.from}>${e.to}>${e.label}`;
const det = JSON.parse(readFileSync(detPath, "utf-8")).edges as { from: string; to: string; label: string }[];
const kept = new Set((JSON.parse(readFileSync(llmPath, "utf-8")).edges as typeof det).map(key));
const dropped = det.filter((e) => !kept.has(key(e)));
const doubtfulKept = new Set(inferCandidates(tools).filter((c) => c.score < DEFAULT_VERIFY.trustAbove && kept.has(`${c.producer}>${c.consumer}>${c.param}`)).map((c) => `${c.producer}>${c.consumer}>${c.param}`));
const keptSample = shuffle(det.filter((e) => doubtfulKept.has(key(e)))).slice(0, Number(nKeptArg));

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const consumerCard = (t: Tool, param: string) => ({ slug: t.slug, description: cut(t.description.replace(/\s+/g, " "), 320), input: { name: param, description: cut(t.inputs.find((i) => i.name === param)?.description ?? "", 280) }, requiredInputs: t.inputs.filter((i) => i.required).map((i) => i.name) });
const producerCard = (t: Tool) => ({ slug: t.slug, description: cut(t.description.replace(/\s+/g, " "), 320), requiredInputs: t.inputs.filter((i) => i.required).map((i) => i.name), returns: t.outputs.filter((o) => o.containers.length <= 2).slice(0, 40).map((o) => [...o.containers, o.name].join(".") + (o.inArray ? "[]" : "")) });

const items = shuffle([...dropped.map((e) => ({ e, group: "dropped" })), ...keptSample.map((e) => ({ e, group: "kept" }))]).map(({ e, group }, i) => ({ id: i + 1, group, e, card: { id: i + 1, need: consumerCard(by.get(e.to)!, e.label), proposedProducer: producerCard(by.get(e.from)!) } }));
const batchSize = Math.ceil(items.length / 3);
for (const set of ["A", "B"]) {
  const order = set === "A" ? items : shuffle(items);
  for (let b = 0; b < 3; b++) writeFileSync(`${outDir}/edges_${set}${b + 1}.json`, JSON.stringify(order.slice(b * batchSize, (b + 1) * batchSize).map((x) => x.card), null, 1));
}
mkdirSync(`${outDir}_key`, { recursive: true });
writeFileSync(`${outDir}_key/key.json`, JSON.stringify(items.map(({ id, group, e }) => ({ id, group, ...e })), null, 1));
console.error(`dropped ${dropped.length}, kept-doubtful sampled ${keptSample.length} of ${doubtfulKept.size}; ${items.length} cards in 3 batches x 2 judge sets`);
