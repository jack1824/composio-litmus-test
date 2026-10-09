/**
 * Build the committed visualization: a single self-contained HTML file with the graph embedded.
 * Usage: `npm run visualize [-- graph.json catalog.json out.html]`.
 *
 * The graph is embedded (not fetched) because dependency_graph.json is gitignored, so a page that
 * loaded it would be empty in a fresh clone. Descriptions come from the catalog for tooltips.
 */
import { readFileSync, writeFileSync } from "fs";
import { loadCatalogFile } from "./catalog.js";
import type { Graph } from "./graph.js";
import { firstSentence, renderHtml } from "./render.js";

const [graphPath = "dependency_graph.json", catalogPath = "github_catalog.json", outPath = "visualization.html"] = process.argv.slice(2);

const graph = JSON.parse(readFileSync(graphPath, "utf-8")) as Graph;
const descriptions = new Map(loadCatalogFile(catalogPath).tools.map((t) => [t.slug, firstSentence(t.description)]));
writeFileSync(outPath, renderHtml(readFileSync("viz/template.html", "utf-8"), graph, descriptions), "utf-8");
console.error(`wrote ${outPath} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
