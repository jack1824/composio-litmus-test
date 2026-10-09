/**
 * Pure HTML assembly for the visualization (kept separate from the CLI so it can be tested).
 */
import type { Graph } from "./graph.js";

const PLACEHOLDER = "/*__GRAPH_DATA__*/null";

export function firstSentence(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const end = clean.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? clean.slice(0, end + 1) : clean;
  return sentence.length > max ? sentence.slice(0, max - 1) + "…" : sentence;
}

/** Embed the graph in the template. `descriptions` maps node id -> one-line description for tooltips. */
export function renderHtml(template: string, graph: Graph, descriptions: Map<string, string>): string {
  if (!template.includes(PLACEHOLDER)) throw new Error("template is missing the graph-data placeholder");
  const data = {
    nodes: graph.nodes.map((n) => ({ id: n.id, service: n.service, desc: descriptions.get(n.id) ?? "" })),
    edges: graph.edges,
  };
  // The JSON sits inside a <script>: keep it from closing the element, opening a comment, or hitting a JS line terminator.
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(new RegExp("[\\u2028\\u2029]", "g"), " ");
  return template.replace(PLACEHOLDER, () => json);
}
