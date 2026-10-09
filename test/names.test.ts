import { test } from "node:test";
import assert from "node:assert/strict";
import { tokens, stem, sameWord, parseName, parseSlug, commonPrefix, isAttributeField } from "../src/names.js";

test("tokens splits snake_case, camelCase, SCREAMING_SNAKE and kebab-case", () => {
  assert.deepEqual(tokens("issue_number"), ["issue", "number"]);
  assert.deepEqual(tokens("projectId"), ["project", "id"]);
  assert.deepEqual(tokens("pullRequestId"), ["pull", "request", "id"]);
  assert.deepEqual(tokens("GITHUB_LIST_REPOSITORY_ISSUES"), ["github", "list", "repository", "issues"]);
  assert.deepEqual(tokens("check-run.id"), ["check", "run", "id"]);
  assert.deepEqual(tokens("HTMLParser"), ["html", "parser"]);
});

test("stem makes singular and plural comparable without mangling common words", () => {
  assert.equal(stem("issues"), stem("issue"));
  assert.equal(stem("repositories"), stem("repository"));
  assert.equal(stem("branches"), stem("branch"));
  assert.equal(stem("status"), "status");
  assert.equal(stem("access"), "access");
  assert.equal(stem("repo"), stem("repositories"));
  assert.equal(stem("org"), stem("organization"));
});

test("sameWord matches compounds by suffix but not unrelated short words", () => {
  assert.ok(sameWord("hook", "webhook"));
  assert.ok(sameWord("issue", "issue"));
  assert.ok(!sameWord("run", "runner"));
  assert.ok(!sameWord("team", "tea"));
  assert.ok(!sameWord("pull", "request"));
});

test("parseName separates the entity from the field word", () => {
  assert.deepEqual(parseName("issue_number"), { entity: ["issue"], cls: "number" });
  assert.deepEqual(parseName("check_run_id"), { entity: ["check", "run"], cls: "id" });
  assert.deepEqual(parseName("team_slug"), { entity: ["team"], cls: "slug" });
  assert.deepEqual(parseName("secret_name"), { entity: ["secret"], cls: "name" });
  assert.deepEqual(parseName("username"), { entity: [], cls: "login" });
  assert.deepEqual(parseName("userId"), { entity: ["user"], cls: "id" });
  assert.deepEqual(parseName("id"), { entity: [], cls: "id" });
});

test("a bare noun has an entity but no field word", () => {
  assert.deepEqual(parseName("branch"), { entity: ["branch"], cls: null });
  assert.deepEqual(parseName(""), { entity: [], cls: null });
});

test("attribute-style fields are not entity identifiers", () => {
  assert.ok(isAttributeField(parseName("node_id")));
  assert.ok(isAttributeField(parseName("full_name")));
  assert.ok(!isAttributeField(parseName("workflow_id")));
});

test("commonPrefix finds the toolkit prefix only when nearly every slug shares it", () => {
  assert.deepEqual(commonPrefix(["GITHUB_A", "GITHUB_B", "GITHUB_C"]), ["github"]);
  assert.deepEqual(commonPrefix(["A_X", "B_Y", "C_Z"]), []);
  assert.deepEqual(commonPrefix(["ONLY_ONE"]), []);
});

test("parseSlug extracts verb, subject and scope", () => {
  const p = ["github"];
  assert.deepEqual(parseSlug("GITHUB_LIST_REPOSITORY_ISSUES", p), { verb: "list", role: "list", head: ["repository", "issue"], scope: [] });
  assert.deepEqual(parseSlug("GITHUB_LIST_REPOSITORIES_FOR_A_USER", p), { verb: "list", role: "list", head: ["repository"], scope: ["user"] });
  assert.deepEqual(parseSlug("GITHUB_GET_A_PULL_REQUEST", p), { verb: "get", role: "get", head: ["pull", "request"], scope: [] });
  assert.deepEqual(parseSlug("GITHUB_CREATE_REACTION_FOR_AN_ISSUE_COMMENT", p), { verb: "create", role: "create", head: ["reaction"], scope: ["issue", "comment"] });
});

test("parseSlug drops the second verb of CREATE_OR_UPDATE and ignores noise words", () => {
  const p = ["github"];
  assert.deepEqual(parseSlug("GITHUB_CREATE_OR_UPDATE_A_REPOSITORY_SECRET", p).head, ["repository", "secret"]);
  assert.deepEqual(parseSlug("GITHUB_LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER", p).scope, ["user"]);
  assert.deepEqual(parseSlug("GITHUB_GET_THE_LATEST_RELEASE", p).head, ["release"]);
});

test("unknown verbs are role 'other'", () => {
  assert.equal(parseSlug("GITHUB_ENABLE_A_WORKFLOW", ["github"]).role, "other");
});

test("a missed or partial prefix does not turn the brand into the verb", () => {
  assert.deepEqual(parseSlug("SLACK_LIST_CHANNELS", ["slack"]), { verb: "list", role: "list", head: ["channel"], scope: [] });
  assert.deepEqual(parseSlug("SLACK_LIST_CHANNELS", []), { verb: "list", role: "list", head: ["channel"], scope: [] });
  // prefix cut after the first word of a two-word brand
  const partial = parseSlug("GOOGLE_CALENDAR_LIST_EVENTS", ["google"]);
  assert.equal(partial.verb, "list");
  assert.deepEqual(partial.head, ["event"]);
});

test("verb-last slugs are read by their last word", () => {
  assert.deepEqual(parseSlug("REPOSITORY_ISSUES_LIST", []), { verb: "list", role: "list", head: ["repository", "issue"], scope: [] });
});

test("the brand repeated inside a slug is not part of the subject", () => {
  assert.deepEqual(parseSlug("NOTION_SEARCH_NOTION_PAGE", ["notion"]).head, ["page"]);
  assert.deepEqual(parseSlug("LINEAR_LIST_LINEAR_TEAMS", ["linear"]).head, ["team"]);
});

test("GET_ALL_* and plural subjects are lists whatever the verb says; a singular subject stays a get", () => {
  assert.equal(parseSlug("X_GET_ALL_USERS", ["x"]).role, "list");
  assert.equal(parseSlug("X_GET_PULL_REQUESTS", ["x"]).role, "list");
  assert.equal(parseSlug("X_GET_A_PULL_REQUEST", ["x"]).role, "get");
  assert.equal(parseSlug("X_FETCH_EMAILS", ["x"]).role, "list");
});

test("more verbs are known: enumerate, view, submit, schedule", () => {
  assert.equal(parseSlug("X_ENUMERATE_ORDERS", ["x"]).role, "list");
  assert.equal(parseSlug("X_VIEW_ORDER", ["x"]).role, "get");
  assert.equal(parseSlug("X_SCHEDULE_MEETING", ["x"]).role, "create");
});

test("commonPrefix finds multi-word brands and ignores a brand shared by too few slugs", () => {
  assert.deepEqual(commonPrefix(["GOOGLE_CALENDAR_LIST_EVENTS", "GOOGLE_CALENDAR_GET_EVENT", "GOOGLE_CALENDAR_CREATE_EVENT"]), ["google", "calendar"]);
  assert.deepEqual(commonPrefix(["A_LIST_X", "A_GET_X", "A_CREATE_X", "B_DELETE_Y", "C_UPDATE_Z"]), ["a"]); // 60% is enough
  assert.deepEqual(commonPrefix(["A_LIST_X", "B_GET_X", "C_CREATE_X", "D_DELETE_Y"]), []);
});

test("a word like `constructor` is just a word, not Object.prototype", () => {
  assert.equal(typeof stem("constructor"), "string");
  assert.deepEqual(parseName("constructor"), { entity: ["constructor"], cls: null });
  assert.equal(parseSlug("X_CONSTRUCTOR_THINGS", ["x"]).role, "other");
});

test("irregular but common plurals and id vocabularies", () => {
  assert.equal(stem("statuses"), stem("status"));
  assert.deepEqual(parseName("asana_gid"), { entity: ["asana"], cls: "id" });
  assert.deepEqual(parseName("message_ts"), { entity: ["message"], cls: "id" });
  assert.deepEqual(parseName("account_sid"), { entity: ["account"], cls: "id" });
});

test("compound prefixes are a whitelist: webhook yes, review/view and account/count no", () => {
  assert.ok(sameWord("hook", "webhook"));
  assert.ok(sameWord("release", "prerelease"));
  assert.ok(!sameWord("view", "review"));
  assert.ok(!sameWord("count", "account"));
  assert.ok(!sameWord("file", "profile"));
  assert.ok(!sameWord("port", "report"));
});

test("`IdOrKey` style names are the id", () => {
  assert.deepEqual(parseName("issueIdOrKey"), { entity: ["issue"], cls: "id" });
  assert.deepEqual(parseName("project_id_or_key"), { entity: ["project"], cls: "id" });
  assert.deepEqual(parseName("channel_name"), { entity: ["channel"], cls: "name" });
});
