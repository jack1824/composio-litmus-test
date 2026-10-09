import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCatalog, loadCatalogFile } from "../src/catalog.js";
import { buildGraph, type Graph } from "../src/graph.js";
import type { InferOptions } from "../src/infer.js";
import { entityScore } from "../src/infer.js";
import { sameWord } from "../src/names.js";

// ---- tiny catalog builders (not GitHub: different naming styles on purpose) ------------------

type Fields = Record<string, string>;
const props = (fields: Fields) => Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, { type: t }]));
const wrap = (data: object) => ({
  type: "object",
  properties: { data: { type: "object", properties: data }, error: { type: "string" }, successful: { type: "boolean" } },
});
/** A response that lists items under `key`. */
const listOf = (key: string, fields: Fields) => wrap({ [key]: { type: "array", items: { type: "object", properties: props(fields) } } });
/** A response that describes a single object. */
const single = (fields: Fields) => wrap(props(fields));

interface ToolDef {
  slug: string;
  required?: Fields;
  optional?: Fields;
  out?: object;
  description?: Record<string, string>;
  enums?: string[];
  tags?: string[];
}
const tool = (d: ToolDef) => ({
  slug: d.slug,
  tags: d.tags ?? [],
  inputParameters: {
    type: "object",
    required: Object.keys(d.required ?? {}),
    properties: Object.fromEntries(
      Object.entries({ ...(d.required ?? {}), ...(d.optional ?? {}) }).map(([k, t]) => [
        k,
        { type: t, description: d.description?.[k] ?? "", ...(d.enums?.includes(k) ? { enum: ["a", "b"] } : {}) },
      ]),
    ),
  },
  outputParameters: d.out,
});
const graphOf = (defs: ToolDef[], options: Partial<InferOptions> = {}) => buildGraph(parseCatalog(defs.map(tool)).tools, options);
const edgesInto = (g: Graph, to: string, label: string) => g.edges.filter((e) => e.to === to && e.label === label).map((e) => e.from);

// ---- generalization: other toolkits, other naming styles -------------------------------------

test("camelCase toolkit (Slack-like): ids come from the matching list tool", () => {
  const g = graphOf([
    { slug: "SLACK_LIST_CHANNELS", out: listOf("channels", { id: "string", name: "string" }) },
    { slug: "SLACK_LIST_USERS", out: listOf("members", { id: "string", name: "string" }) },
    { slug: "SLACK_POST_MESSAGE", required: { channelId: "string", text: "string" } },
    { slug: "SLACK_GET_USER_INFO", required: { userId: "string" } },
    { slug: "SLACK_ARCHIVE_CHANNEL", required: { channelId: "string" } },
  ]);
  assert.deepEqual(edgesInto(g, "SLACK_POST_MESSAGE", "channelId"), ["SLACK_LIST_CHANNELS"]);
  assert.deepEqual(edgesInto(g, "SLACK_ARCHIVE_CHANNEL", "channelId"), ["SLACK_LIST_CHANNELS"]);
  assert.deepEqual(edgesInto(g, "SLACK_GET_USER_INFO", "userId"), ["SLACK_LIST_USERS"]);
  assert.deepEqual(edgesInto(g, "SLACK_POST_MESSAGE", "text"), []); // free text is the user's
});

test("generic response containers fall back to the tool's own subject (Notion-like `results`)", () => {
  const g = graphOf([
    { slug: "NOTION_SEARCH_PAGES", out: listOf("results", { id: "string" }) },
    { slug: "NOTION_LIST_DATABASES", out: listOf("results", { id: "string" }) },
    { slug: "NOTION_GET_PAGE", required: { page_id: "string" } },
    { slug: "NOTION_QUERY_DATABASE", required: { database_id: "string" } },
  ]);
  assert.deepEqual(edgesInto(g, "NOTION_GET_PAGE", "page_id"), ["NOTION_SEARCH_PAGES"]);
  assert.deepEqual(edgesInto(g, "NOTION_QUERY_DATABASE", "database_id"), ["NOTION_LIST_DATABASES"]);
});

test("a toolkit with no shared slug prefix still works", () => {
  const g = graphOf([
    { slug: "list_projects", out: listOf("projects", { id: "string" }) },
    { slug: "get_task_by_project", required: { project_id: "string" } },
    { slug: "archive_workspace" },
  ]);
  assert.deepEqual(edgesInto(g, "get_task_by_project", "project_id"), ["list_projects"]);
});

// ---- the traps a naive implementation falls into ---------------------------------------------

test("same field name, different entity: a comment id of one kind does not come from another kind", () => {
  const g = graphOf([
    { slug: "X_LIST_ISSUE_COMMENTS", required: { issue_number: "integer" }, out: listOf("comments", { id: "integer" }) },
    { slug: "X_LIST_GIST_COMMENTS", required: { gist_id: "string" }, out: listOf("comments", { id: "integer" }) },
    { slug: "X_UPDATE_AN_ISSUE_COMMENT", required: { comment_id: "integer" } },
    { slug: "X_UPDATE_A_GIST_COMMENT", required: { comment_id: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_UPDATE_AN_ISSUE_COMMENT", "comment_id"), ["X_LIST_ISSUE_COMMENTS"]);
  assert.deepEqual(edgesInto(g, "X_UPDATE_A_GIST_COMMENT", "comment_id"), ["X_LIST_GIST_COMMENTS"]);
});

test("a tool never supplies a value it needs itself", () => {
  const g = graphOf([
    { slug: "X_GET_AN_ISSUE", required: { issue_number: "integer" }, out: single({ number: "integer" }) },
    { slug: "X_LIST_ISSUES", out: listOf("issues", { number: "integer" }) },
    { slug: "X_CLOSE_ISSUE", required: { issue_number: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_CLOSE_ISSUE", "issue_number"), ["X_LIST_ISSUES"]);
});

test("a getter that merely lists the id as optional is not a source of that id either", () => {
  const g = graphOf([
    { slug: "X_GET_A_WORKFLOW", optional: { workflow_id: "integer" }, out: single({ id: "integer" }) },
    { slug: "X_LIST_WORKFLOWS", out: listOf("workflows", { id: "integer" }) },
    { slug: "X_ENABLE_A_WORKFLOW", required: { workflow_id: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_ENABLE_A_WORKFLOW", "workflow_id"), ["X_LIST_WORKFLOWS"]);
});

test("a secondary object nested in a response does not make the tool a source of that object's ids", () => {
  const g = graphOf([
    { slug: "X_LIST_PULL_REQUESTS", out: listOf("pull_requests", { number: "integer" }) },
    { slug: "X_CREATE_A_CHECK_RUN", out: wrap({ id: { type: "integer" }, pull_requests: { type: "array", items: { type: "object", properties: props({ number: "integer" }) } } }) },
    { slug: "X_MERGE_A_PULL_REQUEST", required: { pull_number: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_MERGE_A_PULL_REQUEST", "pull_number"), ["X_LIST_PULL_REQUESTS"]);
});

test("a tool that creates something does not look up the name it is giving it", () => {
  const g = graphOf([
    { slug: "X_LIST_BRANCHES", out: listOf("branches", { name: "string" }) },
    { slug: "X_CREATE_BRANCH", required: { branch: "string" }, description: { branch: "The name of the new branch" } },
    { slug: "X_DELETE_BRANCH", required: { branch: "string" }, description: { branch: "The name of the branch" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_CREATE_BRANCH", "branch"), []);
  assert.deepEqual(edgesInto(g, "X_DELETE_BRANCH", "branch"), ["X_LIST_BRANCHES"]);
});

test("scope words separate otherwise identical entities (repository vs organization webhooks)", () => {
  const g = graphOf([
    { slug: "X_LIST_REPOSITORY_WEBHOOKS", out: listOf("webhooks", { id: "integer" }) },
    { slug: "X_LIST_ORGANIZATION_WEBHOOKS", out: listOf("webhooks", { id: "integer" }) },
    { slug: "X_GET_A_REPOSITORY_WEBHOOK", required: { hook_id: "integer" } },
    { slug: "X_GET_AN_ORGANIZATION_WEBHOOK", required: { hook_id: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_GET_A_REPOSITORY_WEBHOOK", "hook_id"), ["X_LIST_REPOSITORY_WEBHOOKS"]);
  assert.deepEqual(edgesInto(g, "X_GET_AN_ORGANIZATION_WEBHOOK", "hook_id"), ["X_LIST_ORGANIZATION_WEBHOOKS"]);
});

test("inputs required by most tools are ambient context and get no edges", () => {
  const consumers = ["A", "B", "C", "D", "E", "F"].map((s) => ({ slug: `X_DO_${s}`, required: { workspace_id: "string" } }));
  const g = graphOf([{ slug: "X_LIST_WORKSPACES", out: listOf("workspaces", { id: "string" }) }, ...consumers]);
  assert.equal(g.edges.length, 0);
});

test("a bare username is the user's to supply unless handle inference is switched on", () => {
  const defs: ToolDef[] = [
    { slug: "X_LIST_USERS", out: listOf("users", { login: "string" }) },
    { slug: "X_ADD_COLLABORATOR", required: { username: "string" } },
  ];
  assert.equal(graphOf(defs).edges.length, 0);
  assert.deepEqual(edgesInto(graphOf(defs, { inferHandles: true }), "X_ADD_COLLABORATOR", "username"), ["X_LIST_USERS"]);
});

test("enums, arrays, objects and booleans are never dependencies, even when a lister exposes a matching id", () => {
  const g = graphOf([
    { slug: "X_LIST_LABELS", out: listOf("labels", { id: "string", name: "string" }) },
    { slug: "X_SET_THING", required: { label_id: "string", label_ids: "array", label_object_id: "object", label_flag_id: "boolean" } },
    { slug: "X_SET_OTHER", required: { label_name: "string" }, enums: ["label_name"] },
  ]);
  assert.deepEqual(edgesInto(g, "X_SET_THING", "label_id"), ["X_LIST_LABELS"]); // the control: the string input is wired
  assert.deepEqual(g.edges.filter((e) => ["label_ids", "label_object_id", "label_flag_id", "label_name"].includes(e.label)), []);
});
test("a bare noun is only an identifier when its description says so", () => {
  const defs: ToolDef[] = [
    { slug: "X_LIST_CONTENTS", out: listOf("contents", { name: "string" }) },
    { slug: "X_CREATE_BLOB", required: { content: "string" }, description: { content: "The content to be stored in the new blob." } },
    { slug: "X_ARCHIVE_CONTENT", required: { content: "string" }, description: { content: "The name of the content item" } },
  ];
  const g = graphOf(defs);
  assert.deepEqual(edgesInto(g, "X_CREATE_BLOB", "content"), []);
  assert.deepEqual(edgesInto(g, "X_ARCHIVE_CONTENT", "content"), ["X_LIST_CONTENTS"]);
});

test("a more specific kind (pages deployment) does not stand in for the generic one", () => {
  const g = graphOf([
    { slug: "X_LIST_DEPLOYMENTS", out: listOf("deployments", { id: "integer" }) },
    { slug: "X_CREATE_A_PAGES_DEPLOYMENT", out: single({ id: "integer" }) },
    { slug: "X_GET_DEPLOYMENT", required: { deployment_id: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_GET_DEPLOYMENT", "deployment_id"), ["X_LIST_DEPLOYMENTS"]);
});

test("tools whose responses expose nothing are never producers", () => {
  const g = graphOf([
    { slug: "X_ARCHIVE_THING" },
    { slug: "X_READ_THING", required: { thing_id: "integer" } },
  ]);
  assert.equal(g.edges.length, 0);
});

test("a deleting tool never supplies an id, even when it returns one and needs nothing circular", () => {
  const g = graphOf([
    { slug: "X_DELETE_THING_BY_LABEL", required: { label: "string" }, description: { label: "The name of the label." }, out: single({ id: "integer" }) },
    { slug: "X_GET_THING", required: { thing_id: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_GET_THING", "thing_id"), []);
});
test("compound nouns (pull -> pull request) match only when the word never stands alone in the catalog", () => {
  const standalone = new Set(["release", "branch", "pull request"]);
  assert.equal(entityScore(["pull"], ["pull", "request"], standalone), 0.85); // "pull" is never a subject by itself
  assert.equal(entityScore(["release"], ["release", "asset"], standalone), 0.5); // releases are their own thing
  assert.equal(entityScore(["branch"], ["branch", "policy"], standalone), 0.5);
  assert.equal(entityScore(["pull"], ["pull", "request"]), 0.5); // no catalog evidence: unconfirmed
  assert.equal(entityScore(["run"], ["workflow", "run"]), 0.75);
  assert.equal(entityScore(["check", "run"], ["workflow", "run"]), 0);
  assert.equal(entityScore(["hook"], ["webhook"]), 1);
});

test("a release asset is not a release (the producer's own subject stands alone elsewhere in the catalog)", () => {
  const g = graphOf([
    { slug: "X_LIST_RELEASES", out: listOf("releases", { id: "integer" }) },
    { slug: "X_GET_A_RELEASE_ASSET", required: { asset_id: "integer" }, out: single({ id: "integer" }) },
    { slug: "X_LIST_RELEASE_ASSETS", required: { release_id: "integer" }, out: listOf("assets", { id: "integer" }) },
  ]);
  assert.deepEqual(edgesInto(g, "X_LIST_RELEASE_ASSETS", "release_id"), ["X_LIST_RELEASES"]);
  assert.deepEqual(edgesInto(g, "X_GET_A_RELEASE_ASSET", "asset_id"), ["X_LIST_RELEASE_ASSETS"]);
});

test("a name that must be unique is the caller's choice when creating, but a lookup elsewhere", () => {
  const g = graphOf([
    { slug: "X_LIST_TAGS", out: listOf("tags", { name: "string" }) },
    { slug: "X_CREATE_A_RELEASE", required: { tag_name: "string" }, description: { tag_name: "The name of the tag for this release. This tag must be unique for published releases." } },
    { slug: "X_GET_RELEASE_BY_TAG", required: { tag_name: "string" }, description: { tag_name: "The name of the tag." } },
  ]);
  assert.deepEqual(edgesInto(g, "X_CREATE_A_RELEASE", "tag_name"), []);
  assert.deepEqual(edgesInto(g, "X_GET_RELEASE_BY_TAG", "tag_name"), ["X_LIST_TAGS"]);
});

test("creating something is only a fallback: an existing list wins, and creators survive when nothing can be listed", () => {
  const withList = graphOf([
    { slug: "X_LIST_GISTS", out: listOf("gists", { id: "string" }) },
    { slug: "X_CREATE_A_GIST", out: single({ id: "string" }) },
    { slug: "X_LIST_GIST_COMMITS", required: { gist_id: "string" } },
  ]);
  assert.deepEqual(edgesInto(withList, "X_LIST_GIST_COMMITS", "gist_id"), ["X_LIST_GISTS"]);
  const createOnly = graphOf([
    { slug: "X_CREATE_A_GIST", out: single({ id: "string" }) },
    { slug: "X_LIST_GIST_COMMITS", required: { gist_id: "string" } },
  ]);
  assert.deepEqual(edgesInto(createOnly, "X_LIST_GIST_COMMITS", "gist_id"), ["X_CREATE_A_GIST"]);
});

test("words after FOR that only describe the action do not block a match (APPROVE_WORKFLOW_RUN_FOR_FORK_PULL_REQUEST)", () => {
  const g = graphOf([
    { slug: "X_LIST_WORKFLOW_RUNS", out: listOf("workflow_runs", { id: "integer" }) },
    { slug: "X_APPROVE_WORKFLOW_RUN_FOR_FORK_PULL_REQUEST", required: { run_id: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_APPROVE_WORKFLOW_RUN_FOR_FORK_PULL_REQUEST", "run_id"), ["X_LIST_WORKFLOW_RUNS"]);
});

test("a generic trailing word is not what a create tool is naming (CREATE_A_TAG_OBJECT.tag is the caller's)", () => {
  const g = graphOf([
    { slug: "X_LIST_TAGS", out: listOf("tags", { name: "string" }) },
    { slug: "X_CREATE_A_TAG_OBJECT", required: { tag: "string" }, description: { tag: "The tag's name, typically a version." } },
    { slug: "X_DELETE_A_TAG", required: { tag: "string" }, description: { tag: "The name of the tag." } },
  ]);
  assert.deepEqual(edgesInto(g, "X_CREATE_A_TAG_OBJECT", "tag"), []);
  assert.deepEqual(edgesInto(g, "X_DELETE_A_TAG", "tag"), ["X_LIST_TAGS"]);
});

test("an input with an attribute-style prefix (file_sha) is still looked up", () => {
  const g = graphOf([
    { slug: "X_LIST_FILES", out: listOf("files", { sha: "string" }) },
    { slug: "X_GET_A_BLOB", required: { file_sha: "string" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_GET_A_BLOB", "file_sha"), ["X_LIST_FILES"]);
});

test("a database is not a base, and a username is not a name", () => {
  assert.equal(sameWord("base", "database"), false);
  assert.equal(sameWord("name", "username"), false);
  assert.equal(sameWord("hook", "webhook"), true);
});

test("a deprecated producer is used only when nothing current can supply the value", () => {
  const dep = (d: ToolDef) => ({ ...tool(d), isDeprecated: true });
  const mixed = buildGraph(parseCatalog([dep({ slug: "X_LIST_OLD_THINGS", out: listOf("things", { id: "integer" }) }), tool({ slug: "X_LIST_THINGS", out: listOf("things", { id: "integer" }) }), tool({ slug: "X_GET_THING", required: { thing_id: "integer" } })]).tools);
  assert.deepEqual(edgesInto(mixed, "X_GET_THING", "thing_id"), ["X_LIST_THINGS"]);
  const onlyOld = buildGraph(parseCatalog([dep({ slug: "X_LIST_THINGS", out: listOf("things", { id: "integer" }) }), tool({ slug: "X_GET_THING", required: { thing_id: "integer" } })]).tools);
  assert.deepEqual(edgesInto(onlyOld, "X_GET_THING", "thing_id"), ["X_LIST_THINGS"]);
});

test("scope keys: a frequent pair that nothing produces is ambient; a lone frequent input a lister supplies is not", () => {
  const pad = Array.from({ length: 18 }, (_, i) => ({ slug: `X_PAD_${i}` }));
  const six = ["A", "B", "C", "D", "E", "F"];
  // Lone frequent input with a producer: stays a dependency.
  const lone = graphOf([{ slug: "X_LIST_CHANNELS", out: listOf("channels", { id: "string" }) }, ...six.map((s) => ({ slug: `X_DO_${s}`, required: { channel_id: "string" } as Fields })), ...pad]);
  assert.equal(lone.edges.length, 6);
  // A pair always required together that no tool produces: ambient context, no edges.
  const pair = graphOf([{ slug: "X_LIST_THINGS", out: listOf("things", { id: "string" }) }, ...six.map((s) => ({ slug: `X_DO_${s}`, required: { tenant_id: "string", region_id: "string" } as Fields })), ...pad]);
  assert.equal(pair.edges.length, 0);
  // The same pair, but a lister exists for one of them: that one is looked up.
  const produced = graphOf([{ slug: "X_LIST_TENANTS", out: listOf("tenants", { id: "string" }) }, ...six.map((s) => ({ slug: `X_DO_${s}`, required: { tenant_id: "string", region_id: "string" } as Fields })), ...pad]);
  assert.equal(produced.edges.filter((e) => e.label === "tenant_id").length, 6);
  assert.equal(produced.edges.filter((e) => e.label === "region_id").length, 0);
  // A frequent pair whose one half names a container noun (workspace) is ambient even though a lister exists; the
  // pair clause is what makes it so, because 24% of the catalog is below the "required almost everywhere" bar.
  const container = graphOf([{ slug: "X_LIST_WORKSPACES", out: listOf("workspaces", { id: "string" }) }, ...six.map((s) => ({ slug: `X_DO_${s}`, required: { workspace_id: "string", region_id: "string" } as Fields })), ...pad]);
  assert.equal(container.edges.filter((e) => e.label === "workspace_id").length, 0);
  const aloneContainer = graphOf([{ slug: "X_LIST_WORKSPACES", out: listOf("workspaces", { id: "string" }) }, ...six.map((s) => ({ slug: `X_DO_${s}`, required: { workspace_id: "string" } as Fields })), ...pad]);
  assert.equal(aloneContainer.edges.filter((e) => e.label === "workspace_id").length, 6);
});
// ---- the output contract ---------------------------------------------------------------------

test("output changes when the input changes (nothing is hardcoded)", () => {
  const base: ToolDef[] = [
    { slug: "X_LIST_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_GET_THING", required: { thing_id: "integer" } },
  ];
  assert.equal(graphOf(base).edges.length, 1);
  assert.equal(graphOf([base[1]]).edges.length, 0); // producer removed
  assert.equal(graphOf([{ ...base[0], out: listOf("things", { title: "string" }) }, base[1]]).edges.length, 0); // producer no longer exposes an id
  assert.equal(graphOf([{ slug: "X_LIST_WIDGETS", out: listOf("widgets", { id: "integer" }) }, base[1]]).edges.length, 0); // producer is about something else
});

test("a list tool's single collection counts as what the tool lists, even under a synonym (Slack `members`)", () => {
  const g = graphOf([
    { slug: "X_LIST_USERS", out: listOf("members", { id: "string" }) },
    { slug: "X_GET_USER", required: { user_id: "string" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_GET_USER", "user_id"), ["X_LIST_USERS"]);
});

test("...but not when the list tool returns several collections, where the synonym is ambiguous", () => {
  const g = graphOf([
    { slug: "X_LIST_USERS", out: wrap({ members: { type: "array", items: { type: "object", properties: props({ id: "string" }) } }, bots: { type: "array", items: { type: "object", properties: props({ id: "string" }) } } }) },
    { slug: "X_GET_USER", required: { user_id: "string" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_GET_USER", "user_id"), []);
});

test("the empty catalog produces an empty graph and the output is deterministic", () => {
  assert.deepEqual(buildGraph([]), { nodes: [], edges: [] });
  const defs: ToolDef[] = [
    { slug: "X_LIST_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_LIST_OTHER_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_GET_THING", required: { thing_id: "integer" } },
  ];
  assert.deepEqual(graphOf(defs), graphOf(defs));
});

test("node service reuses the catalog's own area tags", () => {
  const g = graphOf([
    { slug: "X_CREATE_AN_ISSUE", tags: ["important", "Repository Management", "createHint"] },
    { slug: "X_LIST_ISSUES", tags: ["issues", "readOnlyHint"] },
    { slug: "X_LIST_PULLS", tags: ["pulls"] },
    { slug: "X_ODD_THING", tags: ["Misc Area"] },
  ]);
  const service = Object.fromEntries(g.nodes.map((n) => [n.id, n.service]));
  assert.equal(service.X_CREATE_AN_ISSUE, "issues");
  assert.equal(service.X_LIST_ISSUES, "issues");
  assert.equal(service.X_LIST_PULLS, "pulls");
  assert.equal(service.X_ODD_THING, "misc area");
});

// ---- invariants on the real catalog ----------------------------------------------------------

test("GitHub graph: structural invariants hold for every edge", () => {
  const { tools } = loadCatalogFile("github_catalog.json");
  const g = buildGraph(tools);
  const by = new Map(tools.map((t) => [t.slug, t]));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const e of g.edges) {
    const key = `${e.from}|${e.to}|${e.label}`;
    if (seen.has(key)) problems.push(`duplicate ${key}`);
    seen.add(key);
    if (e.from === e.to) problems.push(`self edge ${e.from}`);
    if (!by.get(e.from)?.outputs.length) problems.push(`producer without output ${e.from}`);
    const input = by.get(e.to)?.inputs.find((i) => i.name === e.label);
    if (!input?.required) problems.push(`label ${e.label} is not a required input of ${e.to}`);
    if (input?.isEnum) problems.push(`enum input ${e.to}.${e.label} got an edge`);
  }
  assert.deepEqual(problems, []);
  assert.equal(g.nodes.length, tools.length);
  assert.ok(g.nodes.every((n) => n.service.length > 0));
});

test("GitHub graph: ambient owner/repo/org inputs never produce edges", () => {
  const g = buildGraph(loadCatalogFile("github_catalog.json").tools);
  assert.deepEqual([...new Set(g.edges.map((e) => e.label).filter((l) => ["owner", "repo", "org"].includes(l)))], []);
});

test("GitHub graph: README's two examples are discovered", () => {
  const g = buildGraph(loadCatalogFile("github_catalog.json").tools);
  assert.ok(edgesInto(g, "GITHUB_CREATE_AN_ISSUE_COMMENT", "issue_number").includes("GITHUB_LIST_REPOSITORY_ISSUES"));
  assert.ok(edgesInto(g, "GITHUB_MERGE_A_PULL_REQUEST", "pull_number").includes("GITHUB_LIST_PULL_REQUESTS"));
});

// ---- regression guard against the labeled sets ----------------------------------------------

/** The cases the matcher is known to miss. A new miss, or a fixed one, must be a deliberate edit here. */
const KNOWN_MISSES: Record<string, string[]> = {
  "eval/github.gold.json": ["GITHUB_ACCEPT_REPOSITORY_INVITATION.invitation_id"], // names cannot tell the invitee's list from the repository's
  "eval/github.holdout.json": [],
};
for (const file of Object.keys(KNOWN_MISSES)) {
  test(`${file}: exactly the known cases are missed, nothing rejected is emitted, nothing leaks`, () => {
    const gold = JSON.parse(readFileSync(file, "utf-8"));
    const g = buildGraph(loadCatalogFile("github_catalog.json").tools);
    const missed = gold.cases.filter((c: any) => !edgesInto(g, c.consumer, c.param).some((p) => c.accept.includes(p))).map((c: any) => `${c.consumer}.${c.param}`);
    const rejectedEmitted = gold.cases.flatMap((c: any) => edgesInto(g, c.consumer, c.param).filter((p) => c.reject.includes(p)));
    const leaks = gold.negatives.filter((n: any) => edgesInto(g, n.consumer, n.param).length > 0);
    assert.deepEqual(missed, KNOWN_MISSES[file]);
    assert.deepEqual(rejectedEmitted, []);
    assert.deepEqual(leaks, []);
  });
}

test("a bare noun whose description asks for an id is matched on the id (Stripe-style `customer`), unless a name is offered too", () => {
  const g = graphOf([
    { slug: "X_LIST_CUSTOMERS", out: listOf("customers", { id: "string", name: "string" }) },
    { slug: "X_RETRIEVE_INVOICES_FOR_CUSTOMER", required: { customer: "string" }, description: { customer: "The ID of the customer." } },
    { slug: "X_LIST_ORGS", out: listOf("orgs", { id: "integer", login: "string" }) },
    { slug: "X_GET_ORG_SETTINGS", required: { org: "string" }, description: { org: "The unique identifier or name of the organization." } },
  ]);
  assert.deepEqual(edgesInto(g, "X_RETRIEVE_INVOICES_FOR_CUSTOMER", "customer"), ["X_LIST_CUSTOMERS"]);
  assert.deepEqual(edgesInto(g, "X_GET_ORG_SETTINGS", "org"), []); // asks for a name; the lister only has an id and a login
});

test("an item's own id spelled long-hand (messages[].message_id, CREATE_AN_ORDER -> order_id) is not a foreign key", () => {
  const g = graphOf([
    { slug: "X_LIST_MESSAGES", required: { channel_id: "string" }, out: listOf("messages", { messageId: "string", subject: "string" }) },
    { slug: "X_CREATE_AN_ORDER", out: single({ order_id: "string" }) },
    { slug: "X_GET_A_MESSAGE", required: { message_id: "string" } },
    { slug: "X_REFUND_AN_ORDER", required: { order_id: "string" } },
    { slug: "X_LIST_CHANNELS", out: listOf("channels", { id: "string" }) },
  ]);
  assert.deepEqual(edgesInto(g, "X_GET_A_MESSAGE", "message_id"), ["X_LIST_MESSAGES"]);
  assert.deepEqual(edgesInto(g, "X_REFUND_AN_ORDER", "order_id"), ["X_CREATE_AN_ORDER"]);
});

test("an id naming ANOTHER entity stays a weak foreign key (workflow_id inside workflow_runs[])", () => {
  const g = graphOf([
    { slug: "X_LIST_WORKFLOW_RUNS", out: listOf("workflow_runs", { id: "integer", workflow_id: "integer" }) },
    { slug: "X_LIST_WORKFLOWS", out: listOf("workflows", { id: "integer" }) },
    { slug: "X_ENABLE_A_WORKFLOW", required: { workflow_id: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_ENABLE_A_WORKFLOW", "workflow_id"), ["X_LIST_WORKFLOWS"]);
});

test("an unrecognised verb does not disqualify a producer: a tool returning one collection is a lister", () => {
  const g = graphOf([
    { slug: "X_ENUMERATE_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_EXPORT_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_GET_THING", required: { thing_id: "integer" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_GET_THING", "thing_id").sort(), ["X_ENUMERATE_THINGS", "X_EXPORT_THINGS"]);
});

test("multi-word toolkit prefixes and a prefix shared by only most slugs still produce edges", () => {
  const mk = (p: string) => graphOf([
    { slug: `${p}_LIST_EVENTS`, out: listOf("events", { id: "string" }) },
    { slug: `${p}_GET_EVENT`, required: { event_id: "string" } },
    { slug: `${p}_DELETE_EVENT`, required: { event_id: "string" } },
  ]);
  for (const prefix of ["CAL", "GOOGLE_CALENDAR", "MICROSOFT_TEAMS_CAL"]) assert.equal(mk(prefix).edges.length, 2, prefix);
  const mixed = graphOf([
    { slug: "ACME_LIST_EVENTS", out: listOf("events", { id: "string" }) },
    { slug: "ACME_GET_EVENT", required: { event_id: "string" } },
    { slug: "ACME_DELETE_EVENT", required: { event_id: "string" } },
    { slug: "ACME_ARCHIVE_EVENT", required: { event_id: "string" } },
    { slug: "OTHER_PING" },
  ]);
  assert.equal(mixed.edges.length, 3);
});

test("a focused catalog keeps its core dependency even when most of its tools need the same input", () => {
  // Every consumer needs issue_number (and owner/repo): 100% of the issue tools. It is still looked up, not ambient.
  const withScope = (extra: Fields): Fields => ({ owner: "string", repo: "string", ...extra });
  const g = graphOf([
    { slug: "X_LIST_REPOSITORY_ISSUES", required: withScope({}), out: listOf("issues", { number: "integer" }) },
    { slug: "X_CREATE_AN_ISSUE_COMMENT", required: withScope({ issue_number: "integer" }) },
    { slug: "X_CLOSE_ISSUE", required: withScope({ issue_number: "integer" }) },
    { slug: "X_LOCK_ISSUE", required: withScope({ issue_number: "integer" }) },
    { slug: "X_ADD_LABELS_TO_AN_ISSUE", required: withScope({ issue_number: "integer" }) },
    { slug: "X_PIN_ISSUE", required: withScope({ issue_number: "integer" }) },
  ]);
  assert.equal(edgesInto(g, "X_CREATE_AN_ISSUE_COMMENT", "issue_number")[0], "X_LIST_REPOSITORY_ISSUES");
  assert.equal(g.edges.filter((e) => e.label === "owner" || e.label === "repo").length, 0);
  assert.equal(g.edges.filter((e) => e.label === "issue_number").length, 5);
});

test("one tool with a pathological schema is skipped, the rest of the graph is still produced", () => {
  const evil: any = tool({ slug: "X_EVIL", required: { thing_id: "integer" } });
  Object.defineProperty(evil, "inputParameters", { get() { throw new Error("boom"); } });
  const tools = parseCatalog([tool({ slug: "X_LIST_THINGS", out: listOf("things", { id: "integer" }) }), tool({ slug: "X_GET_THING", required: { thing_id: "integer" } })]).tools;
  const g = buildGraph(tools);
  assert.equal(g.edges.length, 1);
  assert.doesNotThrow(() => parseCatalog([evil, tool({ slug: "X_OK" })]));
});

test("circularity holds for bare-noun ids too: a tool that takes `customer` (an ID) cannot supply it", () => {
  const g = graphOf([
    { slug: "X_LIST_CUSTOMERS", out: listOf("customers", { id: "string" }) },
    { slug: "X_UPDATE_CUSTOMER", required: { customer: "string" }, description: { customer: "The ID of the customer." }, out: single({ id: "string" }) },
    { slug: "X_RETRIEVE_CUSTOMER", required: { customer: "string" }, description: { customer: "The ID of the customer." }, out: single({ id: "string" }) },
    { slug: "X_DELETE_CUSTOMER", required: { customer: "string" }, description: { customer: "The ID of the customer." } },
  ]);
  assert.deepEqual(edgesInto(g, "X_DELETE_CUSTOMER", "customer"), ["X_LIST_CUSTOMERS"]);
  assert.deepEqual(edgesInto(g, "X_RETRIEVE_CUSTOMER", "customer"), ["X_LIST_CUSTOMERS"]);
});

test("`issueIdOrKey` asks for the id, and a bare `id` on a path-style tool names the tool's own subject", () => {
  const g = graphOf([
    { slug: "X_SEARCH_ISSUES", out: listOf("issues", { id: "string", key: "string" }) },
    { slug: "X_GET_ISSUE", required: { issueIdOrKey: "string" }, description: { issueIdOrKey: "ID or key of the issue" } },
    { slug: "X_LIST_FILTERS", out: listOf("filters", { id: "string" }) },
    { slug: "X_GET_FILTER", required: { id: "string" } },
    { slug: "X_DELETE_FILTER", required: { id: "string" } },
  ]);
  assert.deepEqual(edgesInto(g, "X_GET_ISSUE", "issueIdOrKey"), ["X_SEARCH_ISSUES"]);
  assert.deepEqual(edgesInto(g, "X_DELETE_FILTER", "id"), ["X_LIST_FILTERS"]); // GET_FILTER needs the id itself, so it cannot supply it
  assert.deepEqual(edgesInto(g, "X_GET_FILTER", "id"), ["X_LIST_FILTERS"]);
});

// ---- selection: the cap, the cutoff and the tie-breaks the README documents ---------------------

const producersOf = (slugs: string[], options: Partial<InferOptions> = {}) =>
  edgesInto(graphOf([...slugs.map((slug) => ({ slug, out: listOf("things", { id: "integer" }) })), { slug: "X_GET_THING", required: { thing_id: "integer" } }], options), "X_GET_THING", "thing_id");

test("at most 4 producers are kept per input, and ties go to the shortest slug, then alphabetically", () => {
  const seven = ["X_LIST_THINGS", "X_FIND_THINGS", "X_QUERY_THINGS", "X_BROWSE_THINGS", "X_SEARCH_THINGS", "X_LIST_ALL_THINGS", "X_SEARCH_ALL_THINGS"];
  assert.deepEqual(producersOf(seven), ["X_FIND_THINGS", "X_LIST_THINGS", "X_QUERY_THINGS", "X_BROWSE_THINGS"]);
  assert.equal(producersOf(seven, { maxProducersPerParam: 2 }).length, 2);
  assert.equal(producersOf(seven, { maxProducersPerParam: 7 }).length, 7);
});

test("the relative cutoff drops weaker producers: a get at 0.75 survives a 0.55 cutoff, not a 0.95 one", () => {
  const defs: ToolDef[] = [
    { slug: "X_LIST_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_GET_LATEST_THING", out: single({ id: "integer" }) },
    { slug: "X_GET_THING", required: { thing_id: "integer" } },
  ];
  assert.deepEqual(edgesInto(graphOf(defs), "X_GET_THING", "thing_id").sort(), ["X_GET_LATEST_THING", "X_LIST_THINGS"]);
  assert.deepEqual(edgesInto(graphOf(defs, { relativeCutoff: 0.95 }), "X_GET_THING", "thing_id"), ["X_LIST_THINGS"]);
  assert.deepEqual(edgesInto(graphOf(defs, { minScore: 0.9 }), "X_GET_THING", "thing_id"), ["X_LIST_THINGS"]);
});

test("the edge set does not depend on the order tools appear in the catalog", () => {
  const defs: ToolDef[] = [
    { slug: "X_LIST_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_FIND_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_QUERY_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_BROWSE_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_SEARCH_THINGS", out: listOf("things", { id: "integer" }) },
    { slug: "X_GET_THING", required: { thing_id: "integer" } },
  ];
  const key = (d: ToolDef[]) => graphOf(d).edges.map((e) => `${e.from}>${e.to}>${e.label}`).sort().join("|");
  const base = key(defs);
  assert.equal(key([...defs].reverse()), base);
  for (const seed of [1, 2, 3]) assert.equal(key([...defs].sort((a, b) => ((a.slug.charCodeAt(seed + 2) * 31 + seed) % 7) - ((b.slug.charCodeAt(seed + 2) * 31 + seed) % 7))), base);
});

test("GitHub: the edge set is the same for the reversed catalog", () => {
  const { tools } = loadCatalogFile("github_catalog.json");
  const key = (ts: typeof tools) => buildGraph(ts).edges.map((e) => `${e.from}>${e.to}>${e.label}`).sort().join("\n");
  assert.equal(key([...tools].reverse()), key(tools));
});

test("an unrecognised verb on a single-object response can still supply an id, but behind a lister", () => {
  const only = graphOf([{ slug: "X_SUBSCRIBE_CALENDAR", out: single({ id: "string" }) }, { slug: "X_GET_CALENDAR", required: { calendar_id: "string" } }]);
  assert.deepEqual(edgesInto(only, "X_GET_CALENDAR", "calendar_id"), ["X_SUBSCRIBE_CALENDAR"]);
  const both = graphOf([{ slug: "X_SUBSCRIBE_CALENDAR", out: single({ id: "string" }) }, { slug: "X_LIST_CALENDARS", out: listOf("calendars", { id: "string" }) }, { slug: "X_GET_CALENDAR", required: { calendar_id: "string" } }]);
  assert.equal(edgesInto(both, "X_GET_CALENDAR", "calendar_id")[0], "X_LIST_CALENDARS");
});
