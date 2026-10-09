/**
 * Catalog loading. Turns whatever shape a toolkit catalog arrives in into a small,
 * uniform `Tool` model: slug, inputs, and a flat list of the scalar fields the tool's
 * response exposes. Everything downstream (matching, graph building) works on this model
 * only, so catalog quirks are handled here and nowhere else.
 */
import { readFileSync } from "fs";

type Json = any;

export interface InputParam {
  name: string;
  /** JSON-schema type of the parameter ("string", "integer", "array", ...), or "unknown". */
  type: string;
  description: string;
  required: boolean;
  /** True when the caller must pick from a fixed set of values (never produced by a tool). */
  isEnum: boolean;
}

/** A scalar value a tool's response exposes, with where it sits in the response. */
export interface OutputField {
  /** Leaf property name, e.g. "number". */
  name: string;
  /** Property names from the response root down to the leaf's parent, e.g. ["issues"]. */
  containers: string[];
  /** Whether the field sits under an array, i.e. the tool returns many of these. */
  inArray: boolean;
  type: string;
  description: string;
}

export interface Tool {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  inputs: InputParam[];
  outputs: OutputField[];
}

export interface LoadResult {
  tools: Tool[];
  /** Entries that could not become a tool, kept so callers can report them. */
  skipped: { index: number; reason: string }[];
  /** Tools that were kept as nodes but whose schemas could not be read, so they have no inputs or outputs. */
  warnings: string[];
}

const MAX_DEPTH = 8; // response schemas are nested but finite; this also bounds recursion
const MAX_FIELDS = 3000; // hard cap per tool so one pathological schema cannot blow up memory
const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

export function loadCatalogFile(path: string): LoadResult {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, "")); // editors on Windows prepend a BOM
  } catch (e) {
    throw new Error(`cannot read catalog at ${path}: ${(e as Error).message}`);
  }
  return parseCatalog(data);
}

export function parseCatalog(data: unknown): LoadResult {
  const list = extractToolList(data);
  const tools: Tool[] = [];
  const skipped: LoadResult["skipped"] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      skipped.push({ index, reason: "entry is not an object" });
      return;
    }
    const slug = slugOf(raw);
    if (!slug) {
      skipped.push({ index, reason: "entry has no slug" });
      return;
    }
    if (seen.has(slug)) {
      skipped.push({ index, reason: `duplicate slug ${slug}` });
      return;
    }
    seen.add(slug);
    try {
      tools.push(normalizeTool(raw, slug));
    } catch (e) {
      // One unreadable schema must not cost the whole catalog: keep the tool as a node without inputs or outputs.
      warnings.push(`${slug}: schema unreadable (${(e as Error).message})`);
      tools.push({ slug, name: slug, description: "", tags: [], deprecated: false, inputs: [], outputs: [] });
    }
  });
  return { tools, skipped, warnings };
}

function extractToolList(data: unknown): Json[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of ["tools", "items", "data", "results"]) {
      const value = (data as Json)[key];
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const inner of ["tools", "items"]) {
          if (Array.isArray(value[inner])) return value[inner];
        }
      }
    }
  }
  throw new Error("unrecognized catalog shape: expected an array of tools or an object with a `tools` array");
}

/** Same precedence the provided selfcheck uses, so our node ids always match its provenance check. */
function slugOf(raw: Json): string {
  return String(raw.slug ?? raw.name ?? raw.function?.name ?? "").trim();
}

function normalizeTool(raw: Json, slug: string): Tool {
  const fn = raw.function ?? {};
  const inputSchema = raw.inputParameters ?? raw.input_parameters ?? raw.inputSchema ?? raw.input_schema ?? raw.parameters ?? fn.parameters;
  const outputSchema = raw.outputParameters ?? raw.output_parameters ?? raw.outputSchema ?? raw.output_schema;
  return {
    slug,
    name: typeof raw.name === "string" ? raw.name : slug,
    description: String(raw.description ?? fn.description ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t: unknown): t is string => typeof t === "string") : [],
    deprecated: raw.isDeprecated === true || raw.is_deprecated === true || raw.deprecated === true,
    inputs: collectInputs(inputSchema),
    outputs: collectOutputs(outputSchema),
  };
}

// ---------------------------------------------------------------------------
// JSON-schema helpers
// ---------------------------------------------------------------------------

/** Resolve a local `#/a/b/c` JSON pointer against the schema document. */
function resolveRef(ref: string, root: Json): Json | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let cur = root;
  for (const part of ref.slice(2).split("/")) {
    cur = cur?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Reduce a schema node to the concrete schemas it can stand for: follows `$ref`, takes the
 * non-null branches of `anyOf`/`oneOf`, and merges `allOf`. `seen` holds the refs already on
 * the current path, which stops recursive types (a comment whose parent is a comment).
 */
function expand(schema: Json, root: Json, seen: ReadonlySet<string>): { schema: Json; seen: ReadonlySet<string> }[] {
  if (!schema || typeof schema !== "object") return [];
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return [];
    return expand(resolveRef(schema.$ref, root), root, new Set(seen).add(schema.$ref));
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(alternatives)) {
    const branches = alternatives.flatMap((a: Json) => expand(a, root, seen));
    // `properties` next to `anyOf: [{required: [a]}, {required: [b]}]` ("at least one of") belong to the schema itself.
    if (schema.properties) return [{ schema: { ...schema, anyOf: undefined, oneOf: undefined }, seen }, ...branches];
    return branches;
  }
  if (Array.isArray(schema.allOf)) return [{ schema: mergeAllOf(schema, root, seen), seen }];
  if (schema.type === "null") return [];
  return [{ schema, seen }];
}

function mergeAllOf(schema: Json, root: Json, seen: ReadonlySet<string>): Json {
  const merged: Json = { type: "object", properties: { ...(schema.properties ?? {}) }, required: [...(schema.required ?? [])] };
  for (const member of schema.allOf) {
    for (const { schema: part } of expand(member, root, seen)) {
      Object.assign(merged.properties, part.properties ?? {});
      merged.required.push(...(part.required ?? []));
    }
  }
  return merged;
}

function typeOf(schema: Json): string {
  const t = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== "null") : schema.type;
  if (typeof t === "string") return t;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  if (Array.isArray(schema.enum)) return "string";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function collectInputs(schema: Json): InputParam[] {
  if (!schema || typeof schema !== "object") return [];
  const variants = expand(schema, schema, new Set());
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((n): n is string => typeof n === "string") : []);
  const required = new Set<string>([...list(schema.required), ...variants.flatMap((v) => list(v.schema.required))]);
  const params = new Map<string, InputParam>();
  for (const { schema: variant } of variants) {
    for (const [name, node] of Object.entries<Json>(variant.properties ?? {})) {
      if (params.has(name)) continue;
      const resolved = expand(node, schema, new Set())[0]?.schema ?? node ?? {};
      const type = typeOf(resolved);
      params.set(name, {
        name,
        type,
        description: String(node?.description ?? resolved.description ?? ""),
        required: required.has(name),
        isEnum: (Array.isArray(resolved.enum) && resolved.enum.length > 0) || (type === "array" && Array.isArray(resolved.items?.enum)),
      });
    }
  }
  return [...params.values()];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * Flatten a response schema into its scalar leaves. Composio wraps every response as
 * `{ data, error, successful }`; only `data` describes the tool's payload, so that is where
 * we start. Schemas without the wrapper are walked from the root, minus the status fields.
 */
function collectOutputs(schema: Json): OutputField[] {
  if (!schema || typeof schema !== "object") return [];
  const entry = schema.properties?.data
    ? schema.properties.data
    : { ...schema, properties: omit(schema.properties ?? {}, ["error", "successful"]) };
  const out: OutputField[] = [];
  walk(entry, [], false, schema, new Set(), 0, out);
  return dedupe(out);
}

function walk(node: Json, path: string[], inArray: boolean, root: Json, seen: ReadonlySet<string>, depth: number, out: OutputField[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FIELDS) return;
  for (const { schema, seen: seenHere } of expand(node, root, seen)) {
    const type = typeOf(schema);
    if (type === "array") {
      walk(schema.items, path, true, root, seenHere, depth + 1, out);
    } else if (type === "object") {
      for (const [key, child] of Object.entries<Json>(schema.properties ?? {})) {
        walk(child, [...path, key], inArray, root, seenHere, depth + 1, out);
      }
    } else if (SCALAR_TYPES.has(type) && path.length > 0) {
      out.push({
        name: path[path.length - 1],
        containers: path.slice(0, -1),
        inArray,
        type,
        description: String(node?.description ?? schema.description ?? ""),
      });
    }
  }
}

function dedupe(fields: OutputField[]): OutputField[] {
  const seen = new Set<string>();
  return fields.filter((f) => {
    const key = [...f.containers, f.name].join(".") + "|" + f.type;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

function omit(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}
