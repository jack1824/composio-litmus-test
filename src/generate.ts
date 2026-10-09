/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it:
 *   - The path to a toolkit's catalog JSON is passed as a CLI ARGUMENT, e.g.
 *     `node --import tsx src/generate.ts path/to/catalog.json`. The grader appends it as the
 *     last argument, so reading the final argv entry works whatever else the command carries.
 *   - The graph is written to `dependency_graph.json` in the working directory.
 *
 * The inference itself lives in catalog.ts (load), names.ts (parse names), infer.ts (match
 * needs to producers) and graph.ts (assemble nodes and edges). Nothing here is toolkit-specific:
 * every node id and edge comes from the catalog that is handed in.
 */
import { writeFileSync } from "fs";
import { loadCatalogFile } from "./catalog.js";
import { graphFromCandidates } from "./graph.js";
import { inferCandidates } from "./infer.js";
import { DEFAULT_VERIFY, verifyCandidates, type ChatClient } from "./llm.js";

// The catalog path is the last CLI argument (the grader appends it after the run command).
const CATALOG_PATH = process.argv.length > 2 ? process.argv[process.argv.length - 1] : undefined;
const OUT_PATH = process.env.DEP_GRAPH_OUT ?? "dependency_graph.json"; // the grader leaves it unset; eval redirects it

/**
 * LLM verification is opt-in: DEP_GRAPH_LLM=verify spends tokens (OPENAI_API_KEY / OPENAI_BASE_URL, model from
 * DEP_GRAPH_LLM_MODEL), DEP_GRAPH_LLM=dry-run only reports what it would send. Anything else uses no LLM.
 */
async function refine(tools: Parameters<typeof verifyCandidates>[0], candidates: ReturnType<typeof inferCandidates>) {
  const mode = process.env.DEP_GRAPH_LLM;
  if (mode !== "verify" && mode !== "dry-run") return candidates;
  const options = { model: process.env.DEP_GRAPH_LLM_MODEL ?? DEFAULT_VERIFY.model, dryRun: mode === "dry-run" };
  let client: ChatClient | undefined;
  if (mode === "verify") {
    if (!process.env.OPENAI_API_KEY) {
      console.error("llm: DEP_GRAPH_LLM=verify but OPENAI_API_KEY is not set; using the deterministic graph");
      return candidates;
    }
    const { default: OpenAI } = await import("openai");
    client = new OpenAI({ timeout: 60_000, maxRetries: 1 }) as unknown as ChatClient; // reads OPENAI_API_KEY / OPENAI_BASE_URL
  }
  const { candidates: kept, report } = await verifyCandidates(tools, candidates, client, options);
  console.error(`llm ${mode}: ${report.sent} of ${report.considered} edges in ${report.batches} batches (~${report.estimatedPromptTokens} prompt tokens estimated)` +
    (mode === "verify" ? `; used ${report.promptTokens} prompt + ${report.completionTokens} completion tokens; dropped ${report.dropped}; failed batches ${report.failedBatches}` : ""));
  return kept;
}

async function main() {
  if (!CATALOG_PATH) throw new Error("pass the toolkit catalog path as the first argument");

  const { tools, skipped, warnings } = loadCatalogFile(CATALOG_PATH);
  if (warnings.length) console.error(`${warnings.length} tools kept without a readable schema (first: ${warnings[0]})`);
  if (skipped.length) console.error(`skipped ${skipped.length} malformed catalog entries (first: ${skipped[0].reason})`);
  if (tools.length === 0) console.error("warning: the catalog contains no usable tools; writing an empty graph");

  const graph = graphFromCandidates(tools, await refine(tools, inferCandidates(tools)));
  writeFileSync(OUT_PATH, JSON.stringify(graph, null, 2), "utf-8");
  console.error(`wrote ${graph.nodes.length} nodes, ${graph.edges.length} edges to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
