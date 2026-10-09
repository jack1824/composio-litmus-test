import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCatalog, loadCatalogFile } from "../src/catalog.js";

const wrapper = (defs: Record<string, unknown>, dataRef: string) => ({
  type: "object",
  properties: {
    data: { $ref: `#/$defs/${dataRef}` },
    error: { type: "string" },
    successful: { type: "boolean" },
  },
  $defs: defs,
});

test("accepts a bare array, { tools } and { items }", () => {
  const tool = { slug: "X_A" };
  assert.equal(parseCatalog([tool]).tools.length, 1);
  assert.equal(parseCatalog({ tools: [tool] }).tools.length, 1);
  assert.equal(parseCatalog({ items: [tool] }).tools.length, 1);
});

test("rejects a catalog it cannot find tools in", () => {
  assert.throws(() => parseCatalog({ foo: 1 }), /unrecognized catalog shape/);
  assert.throws(() => parseCatalog("nope"), /unrecognized catalog shape/);
});

test("skips and reports malformed entries instead of crashing", () => {
  const { tools, skipped } = parseCatalog([null, 42, {}, { slug: "X_A" }, { slug: "X_A" }]);
  assert.deepEqual(tools.map((t) => t.slug), ["X_A"]);
  assert.equal(skipped.length, 4);
  assert.match(skipped[3].reason, /duplicate slug/);
});

test("slug precedence matches the provided selfcheck (slug, then name, then function.name)", () => {
  const { tools } = parseCatalog([{ slug: "A", name: "n" }, { name: "B" }, { function: { name: "C" } }]);
  assert.deepEqual(tools.map((t) => t.slug), ["A", "B", "C"]);
});

test("reads required flags, types and enums from inputParameters", () => {
  const { tools } = parseCatalog([
    {
      slug: "X_A",
      inputParameters: {
        type: "object",
        required: ["issue_number"],
        properties: {
          issue_number: { type: "integer", description: "The issue" },
          state: { type: "string", enum: ["open", "closed"] },
          labels: { type: "array", items: { type: "string" } },
        },
      },
    },
  ]);
  const byName = Object.fromEntries(tools[0].inputs.map((i) => [i.name, i]));
  assert.equal(byName.issue_number.required, true);
  assert.equal(byName.issue_number.type, "integer");
  assert.equal(byName.state.required, false);
  assert.equal(byName.state.isEnum, true);
  assert.equal(byName.labels.type, "array");
});

test("understands snake_case and OpenAI function-style input schemas", () => {
  const schema = { type: "object", required: ["a"], properties: { a: { type: "string" } } };
  const snake = parseCatalog([{ slug: "X", input_parameters: schema }]).tools[0];
  const openai = parseCatalog([{ type: "function", function: { name: "Y", parameters: schema } }]).tools[0];
  assert.equal(snake.inputs[0].required, true);
  assert.equal(openai.slug, "Y");
  assert.equal(openai.inputs[0].required, true);
});

test("treats nullable (anyOf with null) parameters as their real type", () => {
  const { tools } = parseCatalog([
    { slug: "X", inputParameters: { type: "object", properties: { n: { anyOf: [{ type: "integer" }, { type: "null" }] } } } },
  ]);
  assert.equal(tools[0].inputs[0].type, "integer");
});

test("flattens a $ref'd response into leaf fields with their containers", () => {
  const { tools } = parseCatalog([
    {
      slug: "X_LIST_ISSUES",
      outputParameters: wrapper(
        {
          Resp: { type: "object", properties: { issues: { type: "array", items: { $ref: "#/$defs/Issue" } }, total_count: { type: "integer" } } },
          Issue: { type: "object", properties: { number: { type: "integer" }, id: { type: "integer" }, user: { $ref: "#/$defs/User" } } },
          User: { type: "object", properties: { login: { type: "string" } } },
        },
        "Resp",
      ),
    },
  ]);
  const fields = tools[0].outputs.map((o) => [...o.containers, o.name].join(".") + (o.inArray ? "[]" : ""));
  assert.deepEqual(fields.sort(), ["issues.id[]", "issues.number[]", "issues.user.login[]", "total_count"]);
});

test("does not include the status fields of the response wrapper", () => {
  const { tools } = parseCatalog([
    { slug: "X", outputParameters: wrapper({ R: { type: "object", properties: { id: { type: "integer" } } } }, "R") },
    { slug: "Y", outputParameters: { type: "object", properties: { id: { type: "integer" }, error: { type: "string" }, successful: { type: "boolean" } } } },
  ]);
  assert.deepEqual(tools[0].outputs.map((o) => o.name), ["id"]);
  assert.deepEqual(tools[1].outputs.map((o) => o.name), ["id"]);
});

test("terminates on recursive types", () => {
  const { tools } = parseCatalog([
    {
      slug: "X",
      outputParameters: wrapper(
        { Comment: { type: "object", properties: { id: { type: "integer" }, parent: { $ref: "#/$defs/Comment" } } } },
        "Comment",
      ),
    },
  ]);
  assert.deepEqual(tools[0].outputs.map((o) => o.name), ["id"]);
});

test("tools without schemas still load with empty inputs and outputs", () => {
  const { tools } = parseCatalog([{ slug: "X" }]);
  assert.deepEqual(tools[0].inputs, []);
  assert.deepEqual(tools[0].outputs, []);
});

test("provided GitHub catalog loads completely and exposes the README's example relationships", () => {
  const { tools, skipped } = loadCatalogFile("github_catalog.json");
  assert.equal(skipped.length, 0);
  assert.equal(tools.length, 893);
  const by = new Map(tools.map((t) => [t.slug, t]));

  const comment = by.get("GITHUB_CREATE_AN_ISSUE_COMMENT")!;
  const issueNumber = comment.inputs.find((i) => i.name === "issue_number")!;
  assert.equal(issueNumber.required, true);
  assert.equal(issueNumber.type, "integer");

  const listIssues = by.get("GITHUB_LIST_REPOSITORY_ISSUES")!;
  assert.ok(listIssues.outputs.some((o) => o.name === "number" && o.containers.join() === "issues" && o.inArray));

  const listPulls = by.get("GITHUB_LIST_PULL_REQUESTS")!;
  assert.ok(listPulls.outputs.some((o) => o.name === "number" && o.containers.join() === "pull_requests" && o.inArray));

  assert.ok(by.get("GITHUB_ABORT_REPOSITORY_MIGRATION")!.inputs.length > 0);
});

test("a `required` that is not an array marks nothing as required (a string must not spread into letters)", () => {
  const { tools } = parseCatalog([{ slug: "X", inputParameters: { type: "object", required: "thing_id", properties: { thing_id: { type: "integer" }, t: { type: "integer" } } } }]);
  assert.deepEqual(tools[0].inputs.map((i) => [i.name, i.required]), [["thing_id", false], ["t", false]]);
});

test("one tool whose schema throws is kept as a node with a warning, and the rest of the catalog still loads", () => {
  const evil: any = { slug: "X_EVIL" };
  Object.defineProperty(evil, "inputParameters", { get() { throw new Error("boom"); } });
  const { tools, warnings } = parseCatalog([evil, { slug: "X_OK" }]);
  assert.deepEqual(tools.map((t) => t.slug), ["X_EVIL", "X_OK"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /X_EVIL: schema unreadable/);
});

test("a schema with its own properties next to anyOf keeps them (the at-least-one-of idiom)", () => {
  const { tools } = parseCatalog([{ slug: "X", inputParameters: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, anyOf: [{ required: ["a"] }, { required: ["b"] }] } }]);
  assert.deepEqual(tools[0].inputs.map((i) => i.name).sort(), ["a", "b"]);
});
