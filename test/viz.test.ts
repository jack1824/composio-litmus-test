import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { renderHtml } from "../src/render.js";
import { buildGraph } from "../src/graph.js";
import { loadCatalogFile } from "../src/catalog.js";

const template = readFileSync("viz/template.html", "utf-8");

/** Extract the embedded data back out of a rendered page. */
function embeddedData(html: string) {
  const m = html.match(/const DATA = (.*);\n/);
  assert.ok(m, "DATA assignment not found");
  return JSON.parse(m![1]);
}

/**
 * A stand-in for the browser: every DOM / canvas call is accepted and returns another stub.
 * This cannot judge how the page looks; it proves the script parses, runs the layout, and does not throw.
 */
function stub(): any {
  const target: any = function () {};
  return new Proxy(target, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : p === "length" ? 0 : p === "measureText" ? () => ({ width: 40 }) : p === "getBoundingClientRect" ? () => ({ width: 1200, height: 800, left: 0, top: 0 }) : p === "getPropertyValue" ? () => "#888" : stub()),
    apply: () => stub(),
    set: () => true,
  });
}

function runPage(html: string) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1].replace("})();", "globalThis.__nodes = nodes; globalThis.__edges = edges; })();");
  const sandbox: any = {
    document: { getElementById: () => stub(), querySelector: () => stub(), createElement: () => stub(), documentElement: stub() },
    window: { addEventListener() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "#888" }),
    devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    Math, Object, Array, Set, Map, JSON, Infinity, String, Number,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(script, sandbox);
  return sandbox;
}

test("rendered page embeds exactly the graph it was given", () => {
  const graph = { nodes: [{ id: "A_ONE", service: "s" }, { id: "A_TWO", service: "s" }], edges: [{ from: "A_ONE", to: "A_TWO", label: "x_id" }] };
  const data = embeddedData(renderHtml(template, graph, new Map([["A_ONE", "First tool."]])));
  assert.deepEqual(data.edges, graph.edges);
  assert.deepEqual(data.nodes.map((n: any) => n.id), ["A_ONE", "A_TWO"]);
  assert.equal(data.nodes[0].desc, "First tool.");
});

test("hostile strings in a catalog cannot break out of the script element", () => {
  const evil = "</script><img src=x onerror=alert(1)><!--";
  const graph = { nodes: [{ id: evil, service: evil }], edges: [] };
  const html = renderHtml(template, graph, new Map([[evil, evil]]));
  assert.equal(html.split("</script>").length - 1, 1, "only the template's own closing tag may remain");
  assert.ok(!html.includes("<img src=x"));
  assert.equal(embeddedData(html).nodes[0].id, evil, "the data itself must survive unchanged");
});

test("the page script runs on the real GitHub graph and the layout stays finite and spread out", () => {
  const { tools } = loadCatalogFile("github_catalog.json");
  const graph = buildGraph(tools);
  const sandbox = runPage(renderHtml(template, graph, new Map()));
  const placed = (sandbox.__nodes as any[]).filter((n) => n.in.length + n.out.length > 0);
  assert.ok(placed.length > 300, `connected nodes: ${placed.length}`);
  assert.ok(placed.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)), "NaN/Infinity coordinate");
  const xs = placed.map((n) => n.x), ys = placed.map((n) => n.y);
  const spread = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  assert.ok(spread > 400 && spread < 20000, `layout spread ${spread}`);
  const distinct = new Set(placed.map((n) => `${Math.round(n.x / 3)},${Math.round(n.y / 3)}`)).size;
  assert.ok(distinct > placed.length * 0.9, "nodes collapsed onto the same spot");
});

test("the page script also runs on a graph with no edges", () => {
  const html = renderHtml(template, { nodes: [{ id: "A", service: "s" }], edges: [] }, new Map());
  assert.doesNotThrow(() => runPage(html));
});
