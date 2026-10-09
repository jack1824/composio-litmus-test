/**
 * Evaluation harness. Runs the real generator on a catalog (exactly as the grader does),
 * then scores the resulting dependency_graph.json against the hand-labeled gold file and
 * checks structural invariants. Usage: `npm run eval [-- gold.json catalog.json]`.
 *
 * What it measures:
 *   - case recall:    for each gold (consumer, param), did we emit at least one accepted producer?
 *   - judged precision: of the edges we emitted for gold cases, how many are accepted vs rejected?
 *                       Edges in neither list are "unjudged" and reported, not scored.
 *   - negative leaks: params that must get no edge but did (user-supplied values, enums, ...).
 *   - invariants:     endpoints are catalog slugs, no self/duplicate edges, label is a real input.
 * Exit code is 1 on invariant violations, negative leaks, rejected producers emitted, or recall below 90%.
 * The graph is written to a temporary file, so running the eval never overwrites ./dependency_graph.json.
 */
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { loadCatalogFile } from "../src/catalog.js";

const goldPath = process.argv[2] ?? "eval/github.gold.json";
const catalogPath = process.argv[3] ?? "github_catalog.json";

interface Edge { from: string; to: string; label?: string }
const gold = JSON.parse(readFileSync(goldPath, "utf-8"));

const tmp = mkdtempSync(join(tmpdir(), "depgraph-eval-"));
const OUT = join(tmp, "dependency_graph.json");
execFileSync("node", ["--import", "tsx", "src/generate.ts", catalogPath], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, DEP_GRAPH_OUT: OUT } });
const graph = JSON.parse(readFileSync(OUT, "utf-8")) as { nodes: { id: string }[]; edges: Edge[] };
rmSync(tmp, { recursive: true, force: true });
const { tools } = loadCatalogFile(catalogPath);
const bySlug = new Map(tools.map((t) => [t.slug, t]));

const edgesFor = (consumer: string, param: string) => graph.edges.filter((e) => e.to === consumer && e.label === param);
let failed = false;
const section = (title: string) => console.log(`\n== ${title}`);

// ---- gold cases -----------------------------------------------------------
section(`gold cases (${gold.cases.length})`);
let hits = 0, accepted = 0, rejected = 0, unjudged = 0;
const misses: string[] = [], rejectedEdges: string[] = [], unjudgedEdges: string[] = [];
for (const c of gold.cases) {
  const edges = edgesFor(c.consumer, c.param);
  const acc = edges.filter((e) => c.accept.includes(e.from));
  const rej = edges.filter((e) => c.reject.includes(e.from));
  const unj = edges.filter((e) => !c.accept.includes(e.from) && !c.reject.includes(e.from));
  if (acc.length) hits++;
  else misses.push(`${c.consumer}.${c.param}${c.source === "readme" ? "  [README example]" : ""}`);
  accepted += acc.length; rejected += rej.length; unjudged += unj.length;
  rej.forEach((e) => rejectedEdges.push(`${e.from} -> ${c.consumer}.${c.param}`));
  unj.forEach((e) => unjudgedEdges.push(`${e.from} -> ${c.consumer}.${c.param}`));
}
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
console.log(`case recall:       ${hits}/${gold.cases.length} = ${pct(hits, gold.cases.length)}`);
console.log(`judged precision:  ${accepted}/${accepted + rejected} = ${pct(accepted, accepted + rejected)}   (accepted edges / (accepted + rejected))`);
console.log(`unjudged edges:    ${unjudged}   (emitted for gold cases but in neither list; audit by hand)`);
if (hits / gold.cases.length < 0.9 || rejected > 0) failed = true;
if (misses.length) console.log(`MISSES:\n  ${misses.join("\n  ")}`);
if (rejectedEdges.length) console.log(`REJECTED EDGES EMITTED (false positives):\n  ${rejectedEdges.join("\n  ")}`);
if (unjudgedEdges.length) console.log(`UNJUDGED:\n  ${unjudgedEdges.join("\n  ")}`);

// ---- negatives ------------------------------------------------------------
section(`negatives (${gold.negatives.length}): params that must get no edge`);
const leaks = gold.negatives.filter((n: any) => edgesFor(n.consumer, n.param).length > 0);
console.log(`leaks: ${leaks.length}`);
for (const n of leaks) console.log(`  LEAK ${n.consumer}.${n.param} <- ${edgesFor(n.consumer, n.param).map((e) => e.from).join(", ")}   (${n.reason})`);
if (leaks.length) failed = true;

// ---- ambiguous ------------------------------------------------------------
section(`ambiguous (${gold.ambiguous.length}): reported, not scored`);
for (const a of gold.ambiguous) console.log(`  ${a.consumer}.${a.param}: ${edgesFor(a.consumer, a.param).length} edge(s)`);

// ---- invariants -----------------------------------------------------------
section("invariants");
const problems: string[] = [];
const seen = new Set<string>();
for (const e of graph.edges) {
  const key = `${e.from}|${e.to}|${e.label}`;
  if (seen.has(key)) problems.push(`duplicate edge ${key}`);
  seen.add(key);
  if (!bySlug.has(e.from)) problems.push(`edge from unknown slug ${e.from}`);
  if (!bySlug.has(e.to)) problems.push(`edge to unknown slug ${e.to}`);
  if (e.from === e.to) problems.push(`self edge ${e.from}`);
  if (!bySlug.get(e.to)?.inputs.some((i) => i.name === e.label && i.required)) problems.push(`label ${e.label} is not a required input of ${e.to}`);
  if (bySlug.get(e.from) && bySlug.get(e.from)!.outputs.length === 0) problems.push(`producer ${e.from} exposes no output`);
}
const nodeIds = new Set(graph.nodes.map((n) => n.id));
for (const t of tools) if (!nodeIds.has(t.slug)) problems.push(`catalog tool missing from nodes: ${t.slug}`);
console.log(problems.length ? `VIOLATIONS (${problems.length}):\n  ${problems.slice(0, 20).join("\n  ")}` : "ok");
if (problems.length) failed = true;

// ---- graph health ---------------------------------------------------------
section("graph health");
const touched = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
const labelCounts: Record<string, number> = {};
const fanIn: Record<string, number> = {};
for (const e of graph.edges) {
  labelCounts[e.label ?? ""] = (labelCounts[e.label ?? ""] ?? 0) + 1;
  fanIn[`${e.to}.${e.label}`] = (fanIn[`${e.to}.${e.label}`] ?? 0) + 1;
}
const top = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}:${v}`).join("  ");
console.log(`nodes ${graph.nodes.length}, edges ${graph.edges.length}, connected nodes ${touched.size} (${pct(touched.size, graph.nodes.length)})`);
console.log(`top labels:  ${top(labelCounts, 12)}`);
console.log(`max fan-in per (consumer.param): ${top(fanIn, 3)}`);
console.log(`mutual dependencies (A feeds B and B feeds A): ${countMutual(graph.edges)}`);

function countMutual(edges: Edge[]): number {
  const pairs = new Set(edges.map((e) => `${e.from}>${e.to}`));
  return edges.filter((e) => e.from < e.to && pairs.has(`${e.to}>${e.from}`)).length;
}

process.exit(failed ? 1 : 0);
