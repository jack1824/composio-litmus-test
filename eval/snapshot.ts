/**
 * Write the golden edge snapshot for the GitHub catalog: one sorted `producer > consumer . label` line per edge.
 * test/snapshot.test.ts compares the generator's output to it, so any change to scoring, selection or tie-breaking
 * shows up as an explicit diff that has to be reviewed and committed. Usage: `npm run snapshot`.
 */
import { writeFileSync } from "fs";
import { loadCatalogFile } from "../src/catalog.js";
import { buildGraph } from "../src/graph.js";

const lines = buildGraph(loadCatalogFile("github_catalog.json").tools).edges.map((e) => `${e.from} > ${e.to} . ${e.label}`).sort();
writeFileSync("eval/github.edges.snapshot.txt", lines.join("\n") + "\n");
console.error(`wrote eval/github.edges.snapshot.txt (${lines.length} edges)`);
