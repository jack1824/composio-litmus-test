/**
 * Graph assembly: tools + inferred dependencies -> the `{ nodes, edges }` shape the checks read.
 */
import type { Tool } from "./catalog.js";
import { inferCandidates, type Candidate, type InferOptions } from "./infer.js";
import { commonPrefix, parseSlug, stem, tokens } from "./names.js";

export interface GraphNode {
  id: string;
  service: string;
}
export interface GraphEdge {
  from: string;
  to: string;
  label: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function buildGraph(tools: Tool[], options: Partial<InferOptions> = {}): Graph {
  return graphFromCandidates(tools, inferCandidates(tools, options));
}

/** Assemble the output from already-chosen candidates (so an optional refinement step can sit in between). */
export function graphFromCandidates(tools: Tool[], candidates: Candidate[]): Graph {
  const services = assignServices(tools);
  const nodes = tools.map((t) => ({ id: t.slug, service: services.get(t.slug)! }));
  const edges = candidates.map((c) => ({ from: c.producer, to: c.consumer, label: c.param }));
  return { nodes, edges };
}

// Tags that describe how a tool behaves or is exposed, not what area of the product it belongs to.
const META_TAG = /hint$|^important$|^mcpignore$|^deprecated$|^graphql$/i;

/**
 * A node's `service` is the coarse product area it belongs to. Catalogs already carry area tags
 * ("issues", "pulls", "gists"), so reuse the catalog's own vocabulary: pick the single-word tag
 * that names the tool's subject (CREATE_AN_ISSUE -> "issues"), else the tool's first area tag,
 * else the subject itself.
 */
function assignServices(tools: Tool[]): Map<string, string> {
  const prefix = commonPrefix(tools.map((t) => t.slug));
  const vocabulary = tagVocabulary(tools);
  const services = new Map<string, string>();
  for (const tool of tools) {
    const { head, scope } = parseSlug(tool.slug, prefix);
    const subjectTag = [...head].reverse().concat(scope).map((w) => vocabulary.get(w)).find(Boolean);
    const ownTag = tool.tags.find((t) => !META_TAG.test(t));
    services.set(tool.slug, subjectTag ?? ownTag?.toLowerCase() ?? (head.join(" ") || prefix[0] || "general"));
  }
  return services;
}

/** stem of a single-word area tag -> its most common spelling in the catalog. */
function tagVocabulary(tools: Tool[]): Map<string, string> {
  const spellings = new Map<string, Map<string, number>>();
  for (const tool of tools) {
    for (const tag of tool.tags) {
      const words = tokens(tag);
      if (words.length !== 1 || META_TAG.test(tag)) continue;
      const counts = spellings.get(stem(words[0])) ?? new Map<string, number>();
      counts.set(tag.toLowerCase(), (counts.get(tag.toLowerCase()) ?? 0) + 1);
      spellings.set(stem(words[0]), counts);
    }
  }
  return new Map(
    [...spellings].map(([key, counts]) => [key, [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0]]),
  );
}
