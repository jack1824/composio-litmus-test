/**
 * Dependency inference. For every required input of every tool (a "need"), find the tools
 * whose responses expose a matching value (a "fact") and keep the best few as producers.
 *
 *   score = entity x field x factWeight x context x role x ease x deprecated   (each in [0, 1])
 *
 *   entity    does the fact describe the same kind of thing the input asks for?
 *             `issue_number` asks for an issue; a response container `issues` provides issues.
 *   field     is it the right field of that thing (number vs id vs slug vs name)?
 *   factWeight is this the tool's own subject (1.0), a foreign key it happens to return (0.5),
 *             or a secondary object nested in its response (0.4)? Check-run responses mention a
 *             pull request; that does not make them a way to find pull request numbers.
 *   context   when the consumer's name qualifies the entity (UPDATE_AN_ISSUE_COMMENT wants a
 *             comment *of an issue*), the producer must carry the same qualifier.
 *   role      listing/searching beats creating beats fetching; deleting supplies nothing.
 *   ease      prefer producers that need fewer ids themselves.
 *
 * Hard exclusions: a tool never supplies a value it needs itself (GET_AN_ISSUE needs
 * issue_number), "ambient" inputs shared by most tools (owner/repo) are left for the caller
 * to provide, enums are user choices, and a tool that creates X does not look up X's name.
 */
import type { Tool, InputParam, OutputField } from "./catalog.js";
import {
  type FieldClass, type SlugShape, type Role,
  parseName, parseSlug, commonPrefix, isAttributeField, sameWord, tokens, stem, CREATING_ROLES,
} from "./names.js";

export interface InferOptions {
  /** An input required by at least this share of tools (and `ambientMinCount` tools) is ambient context. */
  ambientShare: number;
  ambientMinCount: number;
  /** A frequent input required by at least this share of tools is ambient even when it stands alone. */
  ambientEverywhere: number;
  minScore: number;
  /** Keep only producers scoring at least this fraction of the best producer for the same input. */
  relativeCutoff: number;
  maxProducersPerParam: number;
  /**
   * Look for producers of people's handles (`username`, `user_login`). Off by default: a handle is
   * normally something the user states ("add octocat"), and searching for it would wire a few
   * user-listing tools to every tool that takes one, which drowns the real dependencies.
   */
  inferHandles: boolean;
}

export const DEFAULT_OPTIONS: InferOptions = {
  ambientShare: 0.15,
  ambientMinCount: 5,
  ambientEverywhere: 0.4,
  minScore: 0.45,
  relativeCutoff: 0.55,
  maxProducersPerParam: 4,
  inferHandles: false,
};

export interface Candidate {
  producer: string;
  consumer: string;
  param: string;
  score: number;
  deprecated: boolean;
  /** Human-readable factor breakdown, for debugging and audits. */
  why: string;
}

/** Something a tool needs from elsewhere. */
interface Need {
  param: InputParam;
  entity: string[];
  cls: FieldClass;
  /** True when the name carried an explicit field word (issue_NUMBER); bare nouns are weaker evidence. */
  strong: boolean;
}

/** Something a tool's response gives back. */
interface Fact {
  tool: Tool;
  slug: SlugShape;
  /** The slug's role, except that an unrecognised verb on a tool returning a single collection reads as a list. */
  role: Role;
  entity: string[];
  cls: FieldClass;
  weight: number;
  path: string;
}

const SCALAR_INPUT_TYPES = new Set(["string", "integer", "number", "unknown"]);
/** Response wrapper keys that say nothing about what the items are. */
const GENERIC_CONTAINERS = new Set([
  "data", "items", "results", "result", "response", "details", "detail", "list", "values",
  "nodes", "edges", "records", "record", "entries", "entry", "objects", "object", "payload", "output",
]);
/**
 * A bare-noun input (`branch`, `customer`) carries no field word, so its description decides what is wanted:
 * "The name of the branch" -> name, "The ID of the customer" -> id. No such word means it is not an identifier.
 */
const FIELD_HINT = /\b(name|ids?|identifier|key|slug|number|login|handle|sha)\b/i;
function fieldFromDescription(description: string): FieldClass | undefined {
  // Only the literal "ID" means an opaque id. "identifier" is ambiguous (GitHub's `org` is "the unique identifier" yet
  // takes the login), so it is treated like a name; an id-only match would offer a numeric id where a login belongs.
  const asClass = (word: string): FieldClass => (word === "id" || word === "ids" ? "id" : word === "identifier" ? "name" : word === "handle" ? "login" : (word as FieldClass));
  const hits = [...description.matchAll(new RegExp(FIELD_HINT, "gi"))].map((m) => asClass(m[1].toLowerCase()));
  if (hits.length === 0) return undefined;
  // "The unique identifier or name of the organization": when a name is among the options, ask for it. A name is
  // what lists expose next to the id, and an id-only match would offer a numeric id where a login is expected.
  return hits.includes("name") ? "name" : hits[0];
}
/**
 * Looking up what exists beats creating something new just to get an id; creation survives only when
 * nothing can be looked up (an audit found `CREATE_A_GIST -> LIST_GIST_COMMITS` misleading: the user
 * wants the commits of an existing gist).
 */
const ROLE_WEIGHT: Record<Role, number> = { list: 1, get: 0.75, other: 0.55, create: 0.5, delete: 0 };
/** Name-like fields people choose or recall, as opposed to opaque ids that must be looked up. */
const NAME_CLASSES: ReadonlySet<FieldClass> = new Set(["name", "slug", "key"]);
/**
 * Generic container nouns. Naming one says which namespace a tool works in (an organization's packages vs
 * a user's), which matters when the consumer names one, but it does not make an item a different *kind*.
 */
const SCOPE_NOUNS = new Set(["organization", "enterprise", "workspace", "repository", "account", "project"]);
/** A description saying the value must be new ("must be unique") marks a name the caller is choosing. */
const CHOSEN_NAME_HINT = /\bmust be unique\b|\bunique (name|within)\b/i;

// Field compatibility: how acceptable a response field of class `have` is for an input wanting `want`.
const FIELD_COMPAT: Partial<Record<FieldClass, Partial<Record<FieldClass, number>>>> = {
  id: { number: 0.3, key: 0.5 },
  number: { id: 0.3 },
  name: { slug: 0.7, key: 0.5 },
  slug: { name: 0.6 },
  key: { id: 0.5, name: 0.5 },
};
const fieldScore = (want: FieldClass, have: FieldClass) => (want === have ? 1 : FIELD_COMPAT[want]?.[have] ?? 0);

/**
 * How well the entity named by an input (`a`) matches the entity a response field belongs to (`b`).
 *
 * `standalone` holds the phrases the catalog uses as a subject on their own (LIST_RELEASES -> "release").
 * An input [pull] against a response about [pull, request] is a match only if "pull" never stands alone:
 * it is one compound noun. [release] against [release, asset] is not: releases are their own thing, and
 * an asset is a different one. Same for [branch] vs [branch, policy].
 *
 * `producerWords` are the words of the producer's slug: a response container can drop a qualifier its
 * tool name carries (LIST_ORG_PACKAGE_VERSIONS returns `versions`, which still means package versions).
 */
export function entityScore(a: string[], b: string[], standalone?: ReadonlySet<string>, producerWords: string[] = []): number {
  if (a.length === 0 || b.length === 0) return 0;
  const inB = (w: string) => b.some((x) => sameWord(w, x));
  const inA = (w: string) => a.some((x) => sameWord(w, x));
  const sameHead = sameWord(a[a.length - 1], b[b.length - 1]);
  if (a.every(inB) && b.every(inA)) return 1;
  if (a.every(inB)) {
    if (sameHead) return 0.75; // input is less specific: [run] vs [workflow, run]
    const isLeadingWord = b.length === a.length + 1 && a.every((w, i) => sameWord(w, b[i]));
    return isLeadingWord && standalone !== undefined && !standalone.has(a.join(" ")) ? 0.85 : 0.5; // no catalog evidence: stay unconfirmed
  }
  if (b.every(inA)) {
    if (!sameHead) return 0; // response is less specific: [run] vs [check, run]
    const dropped = a.filter((w) => !inB(w));
    return dropped.every((w) => producerWords.some((p) => sameWord(w, p))) ? 0.9 : 0.5;
  }
  return 0;
}

/** One odd tool must not take down the whole graph: skip it, say so once, keep going. */
let reported = false;
function safely<T>(work: () => T, fallback: T, slug: string): T {
  try {
    return work();
  } catch (e) {
    if (!reported) console.error(`warning: skipped tool ${slug} while analysing it (${(e as Error).message}); further such tools are skipped silently`);
    reported = true;
    return fallback;
  }
}

/** Everything derived from the catalog alone, shared by inference and by the audit helper `classifyInputs`. */
function analysis(tools: Tool[], opt: InferOptions) {
  const prefix = commonPrefix(tools.map((t) => t.slug));
  const slugShapes = new Map(tools.map((t) => [t.slug, parseSlug(t.slug, prefix)]));
  const facts = tools.flatMap((t) => safely(() => factsOf(t, slugShapes.get(t.slug)!), [] as Fact[], t.slug));
  const standalone = new Set([...slugShapes.values()].map((sh) => sh.head.join(" ")).concat(facts.filter((f) => f.weight === 1).map((f) => f.entity.join(" "))));
  const byWord = new Map<string, Fact[]>();
  for (const f of facts) {
    for (const w of new Set(f.entity)) {
      const list = byWord.get(w);
      if (list) list.push(f);
      else byWord.set(w, [f]);
    }
  }
  const hasProducer = (name: string) => {
    const shape = parseName(name);
    if (shape.entity.length === 0) return false;
    const cls = shape.cls ?? "name";
    return facts.some((f) => f.weight === 1 && ROLE_WEIGHT[f.role] >= 0.5 && fieldScore(cls, f.cls) >= 0.6 && entityScore(shape.entity, f.entity, standalone) >= 0.9);
  };
  const ambient = ambientInputs(tools, opt, hasProducer);
  const ambientWords = new Set([...ambient].flatMap((name) => (parseName(name).entity.length ? parseName(name).entity : tokens(name).map(stem))));
  const isNamespace = (w: string) => ambientWords.has(w) || SCOPE_NOUNS.has(w) || w === "user";
  return { slugShapes, facts, standalone, byWord, ambient, ambientWords, isNamespace };
}

export function inferCandidates(tools: Tool[], options: Partial<InferOptions> = {}): Candidate[] {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const { slugShapes, facts, standalone, byWord, ambient, ambientWords, isNamespace } = analysis(tools, opt);

  const needsByTool = new Map(tools.map((t) => [t.slug, safely(() => needsOf(t, slugShapes.get(t.slug)!, ambient, opt), [], t.slug)]));
  const requiredShapes = new Map(tools.map((t) => [t.slug, safely(() => requiredNeeds(t, slugShapes.get(t.slug)!), [], t.slug)]));
  const easeOf = (t: Tool) => 1 / (1 + 0.15 * needsByTool.get(t.slug)!.filter((n) => n.strong).length);
  const loginFacts = opt.inferHandles ? facts.filter((f) => f.cls === "login") : [];

  const out: Candidate[] = [];
  for (const consumer of tools) {
    const cSlug = slugShapes.get(consumer.slug)!;
    for (const need of needsByTool.get(consumer.slug)!) {
      const pool = need.entity.length === 0 ? loginFacts : candidateFacts(need, byWord);
      const scored = new Map<string, Candidate>();
      for (const fact of pool) {
        const producer = fact.tool;
        if (producer.slug === consumer.slug) continue;
        if (requiredShapes.get(producer.slug)!.some((r) => needsSameValue(need, r, standalone))) continue; // would need what it supplies

        const entity = need.entity.length === 0 ? (fact.entity.includes("user") ? 1 : 0.5) : entityScore(need.entity, fact.entity, standalone, [...fact.slug.head, ...fact.slug.scope]);
        const field = fieldScore(need.cls, fact.cls);
        const role = ROLE_WEIGHT[fact.role];
        if (entity === 0 || field === 0 || role === 0) continue;
        if (!need.strong && (entity < 0.9 || fact.weight < 1)) continue; // `content`, `branch`: no field word, so require an exact match
        // A compound noun ([pull] -> [pull, request]) is all entity: none of its words is a qualifier.
        const entityWords = entity === 0.85 ? fact.entity : need.entity;
        const context = contextScore(qualifiersOfConsumer(cSlug, need.entity, isNamespace), qualifiersOfProducer(fact.slug, entityWords), ambientWords);
        const score = entity * field * fact.weight * context * role * easeOf(producer);
        if (score < opt.minScore) continue;
        const prev = scored.get(producer.slug);
        if (!prev || prev.score < score) {
          scored.set(producer.slug, {
            producer: producer.slug, consumer: consumer.slug, param: need.param.name, score, deprecated: producer.deprecated,
            why: `entity=${entity.toFixed(2)} field=${field} fact=${fact.weight} ctx=${context.toFixed(2)} role=${role} via ${fact.path}`,
          });
        }
      }
      out.push(...select([...scored.values()], opt));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Needs (consumer side)
// ---------------------------------------------------------------------------

export type NeedStatus = "considered" | "ambient" | "excluded";

/**
 * Every required input of every tool and how the matcher treated it: `considered` (searched for
 * producers), `ambient` (shared context such as owner/repo) or `excluded` (enum, array, free text,
 * a name a create-tool is choosing, a bare handle...). Used to audit what the rules leave out.
 */
export function classifyInputs(tools: Tool[], options: Partial<InferOptions> = {}): { consumer: string; param: string; status: NeedStatus }[] {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const { slugShapes, ambient } = analysis(tools, opt);
  const out: { consumer: string; param: string; status: NeedStatus }[] = [];
  for (const tool of tools) {
    const considered = new Set(needsOf(tool, slugShapes.get(tool.slug)!, ambient, opt).map((n) => n.param.name));
    for (const input of tool.inputs) {
      if (!input.required) continue;
      out.push({ consumer: tool.slug, param: input.name, status: ambient.has(input.name) ? "ambient" : considered.has(input.name) ? "considered" : "excluded" });
    }
  }
  return out;
}

/**
 * Inputs that scope the whole session rather than name something per call (owner, repo). Frequent inputs
 * (15% of the catalog) qualify if they are required by most of it (40%) or almost always together with another
 * frequent input (owner + repo form one namespace key), AND either name a container noun (repository,
 * organization, workspace...) or have no producer anywhere in the catalog. An input that other tools exist to
 * look up (a Slack `channel`, an `issue_number`) stays a dependency however often it is required; this also keeps
 * a trimmed catalog from losing its core dependency just because the share of tools requiring it went up.
 */
function ambientInputs(tools: Tool[], opt: InferOptions, hasProducer: (name: string) => boolean): Set<string> {
  const required = tools.map((t) => new Set(t.inputs.filter((i) => i.required).map((i) => i.name)));
  const counts = new Map<string, number>();
  for (const names of required) for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const frequent = [...counts].filter(([, n]) => n >= opt.ambientMinCount && n / tools.length >= opt.ambientShare).map(([name]) => name);
  return new Set(
    frequent.filter((name) => {
      const everywhere = counts.get(name)! / tools.length >= opt.ambientEverywhere;
      const using = required.filter((names) => names.has(name));
      const paired = frequent.some((other) => other !== name && using.filter((names) => names.has(other)).length / using.length >= 0.8);
      if (!everywhere && !paired) return false;
      const entity = parseName(name).entity;
      return SCOPE_NOUNS.has(entity[entity.length - 1] ?? "") || !hasProducer(name);
    }),
  );
}

function needsOf(tool: Tool, slug: SlugShape, ambient: Set<string>, opt: InferOptions): Need[] {
  const needs: Need[] = [];
  for (const param of tool.inputs) {
    if (!param.required || param.isEnum || !SCALAR_INPUT_TYPES.has(param.type) || ambient.has(param.name)) continue;
    const shape = parseName(param.name);
    // A bare `id` on a path-style tool (GET_FILTER(id), RETRIEVE_PRODUCT(id)) identifies the tool's own subject.
    if (shape.entity.length === 0 && (shape.cls === "id" || shape.cls === "number") && slug.head.length > 0) shape.entity = [slug.head[slug.head.length - 1]];
    const cls = shape.cls ?? "name"; // a bare noun such as `branch` asks for that thing's name
    if (cls === "login" && !opt.inferHandles) continue; // people's handles are the user's to give
    if (shape.entity.length === 0 && cls !== "login") continue; // bare `id` / `name`: no idea what of
    const headNoun = [...slug.head].reverse().find((w) => !GENERIC_CONTAINERS.has(w)); // CREATE_A_TAG_OBJECT creates a tag
    const namesItsOwnSubject = shape.entity.length > 0 && headNoun !== undefined && sameWord(shape.entity[shape.entity.length - 1], headNoun);
    const creating = CREATING_ROLES.has(slug.role);
    if (creating && NAME_CLASSES.has(cls) && (namesItsOwnSubject || CHOSEN_NAME_HINT.test(param.description))) continue; // the caller names the new thing
    const strong = shape.cls !== null;
    const wanted = strong ? cls : fieldFromDescription(param.description);
    if (!wanted) continue; // `content`, `code`: payloads, not identifiers
    needs.push({ param, entity: shape.entity, cls: wanted, strong });
  }
  return needs;
}

/**
 * The inputs, ambient or not, that identify what a tool operates on, in (entity, class) form, so we
 * can detect producers that need what they supply. Fetch-by-id style tools count optional inputs too:
 * a getter that accepts an id cannot be how that id is discovered.
 */
function requiredNeeds(tool: Tool, slug: SlugShape): { entity: string[]; cls: FieldClass }[] {
  return tool.inputs
    .filter((i) => i.required || slug.role === "get" || slug.role === "other")
    .map((i) => {
      const s = parseName(i.name);
      if (s.entity.length === 0 && (s.cls === "id" || s.cls === "number") && slug.head.length > 0) s.entity = [slug.head[slug.head.length - 1]];
      // A bare noun is the class its description names (the same rule needsOf applies), so `customer` ("The ID of the
      // customer") is recognised as the very value a lister of customer ids supplies.
      return { entity: s.entity, cls: s.cls ?? fieldFromDescription(i.description) ?? ("name" as FieldClass) };
    });
}

function needsSameValue(need: Need, other: { entity: string[]; cls: FieldClass }, standalone: ReadonlySet<string>): boolean {
  if (need.entity.length === 0) return other.entity.length === 0 && other.cls === need.cls;
  // A tool that takes a repository name cannot be how you learn a (template) repository's name,
  // whatever qualifier the input carries: same kind of thing, same human-readable field.
  if (NAME_CLASSES.has(need.cls) && other.cls === need.cls && other.entity.length > 0 && sameWord(need.entity[need.entity.length - 1], other.entity[other.entity.length - 1])) return true;
  return entityScore(need.entity, other.entity, standalone) >= 0.85 && fieldScore(need.cls, other.cls) >= 0.6;
}

// ---------------------------------------------------------------------------
// Facts (producer side)
// ---------------------------------------------------------------------------

function factsOf(tool: Tool, slug: SlugShape): Fact[] {
  const facts: Fact[] = [];
  const idLike = tool.outputs.filter((o) => o.inArray && o.containers.length <= 1 && parseName(o.name).cls);
  const collections = new Set(idLike.filter((o) => o.containers.length === 1 && !GENERIC_CONTAINERS.has(o.containers[0].toLowerCase())).map((o) => o.containers[0]));
  const allCollections = new Set(idLike.map((o) => o.containers.join(".")));
  const role: Role = slug.role === "other" && allCollections.size === 1 ? "list" : slug.role;
  const soleCollection = role === "list" && collections.size === 1 ? [...collections][0] : undefined;
  for (const out of tool.outputs) {
    const shape = parseName(out.name);
    if (!shape.cls || isAttributeField(shape)) continue;
    const containers = out.containers.filter((c) => !GENERIC_CONTAINERS.has(c.toLowerCase()));
    if (containers.length > 1) continue; // buried in a nested object: not what the tool is about

    let entity: string[];
    let weight: number;
    if (containers.length === 0) {
      entity = slug.head; // a field at the top of the response describes the tool's own subject
      weight = 1;
    } else {
      entity = tokens(containers[0]).map(stem);
      weight = describesSubject(entity, slug.head) ? 1 : 0.4;
    }
    if (shape.entity.length > 0) {
      // `order_id` inside orders[] (or at the top of CREATE_AN_ORDER) is the item's own id spelled long-hand, not a
      // foreign key; only an id naming some OTHER entity (workflow_id inside workflow_runs[]) is one.
      if (entity.length > 0 && entityScore(shape.entity, entity) >= 0.9) {
        // own id: keep the entity and weight computed above
      } else {
        entity = shape.entity;
        weight = Math.min(weight, 0.5);
      }
    }
    if (entity.length === 0) continue;
    facts.push({ tool, slug, role, entity, cls: shape.cls, weight, path: fieldPath(out) });
    // Slack's users.list returns `members`; the items are still the users the tool lists.
    if (containers[0] === soleCollection && shape.entity.length === 0 && weight < 1 && slug.head.length > 0) {
      facts.push({ tool, slug, role, entity: slug.head, cls: shape.cls, weight: 0.9, path: fieldPath(out) });
    }
  }
  return facts;
}

const describesSubject = (entity: string[], head: string[]) =>
  head.length > 0 && (sameWord(entity[entity.length - 1], head[head.length - 1]) || entity.every((w) => head.some((h) => sameWord(w, h))));

const fieldPath = (o: OutputField) => [...o.containers, o.name].join(".") + (o.inArray ? "[]" : "");

function candidateFacts(need: Need, byWord: Map<string, Fact[]>): Fact[] {
  const found = new Set<Fact>();
  for (const [word, list] of byWord) if (need.entity.some((w) => sameWord(w, word))) list.forEach((f) => found.add(f));
  return [...found];
}

// ---------------------------------------------------------------------------
// Context (does the producer carry the qualifier the consumer asks for?)
// ---------------------------------------------------------------------------

/**
 * Words that qualify the wanted entity in the consumer's slug: for `comment`, UPDATE_AN_ISSUE_COMMENT gives [issue].
 * Words after a preposition qualify it only when they name a namespace (FOR_A_REPOSITORY, FOR_A_USER); the rest
 * describe the action (APPROVE_WORKFLOW_RUN_FOR_FORK_PULL_REQUEST), not which workflow run is meant.
 */
function qualifiersOfConsumer(slug: SlugShape, entity: string[], isNamespace: (w: string) => boolean): string[] {
  if (entity.length === 0) return []; // entity-less needs (`username`) have nothing to qualify
  const last = entity[entity.length - 1];
  const before = (words: string[]) => {
    const at = words.findIndex((w) => sameWord(w, last));
    return at === -1 ? null : words.slice(0, Math.max(0, at - (entity.length - 1)));
  };
  const inHead = before(slug.head);
  if (inHead) return [...inHead, ...slug.scope.filter(isNamespace)];
  return before(slug.scope) ?? [];
}

/** What the producer's slug says about itself apart from the entity being asked for: its own words, and what it is scoped to. */
function qualifiersOfProducer(slug: SlugShape, entity: string[]): { head: string[]; scope: string[] } {
  const rest = (words: string[]) => words.filter((w) => !entity.some((e) => sameWord(e, w)));
  return { head: rest(slug.head), scope: rest(slug.scope) };
}

function contextScore(wanted: string[], offered: { head: string[]; scope: string[] }, ambientWords: Set<string>): number {
  const isScope = (w: string) => ambientWords.has(w) || SCOPE_NOUNS.has(w);
  const extra = (words: string[]) => words.filter((w) => !isScope(w));
  if (wanted.length === 0) {
    // The consumer is generic, so a producer for a more specific kind (a *pages* deployment: extra words in its own
    // name) is a subtype, not a stand-in. What it is merely scoped to (FOR_A_CLASSROOM) says nothing about its kind.
    return 1 / (1 + extra(offered.head).length);
  }
  const all = [...offered.head, ...offered.scope];
  // A producer that names no scope at all fits a consumer asking for a namespace (organization vs repository) poorly,
  // but says nothing against other scope words (the "user" in ADD_TEAM_MEMBERSHIP_FOR_USER is the action's target).
  if (all.length === 0) return wanted.some(isScope) ? 0.5 : 0.8;
  const covered = wanted.filter((w) => all.some((o) => sameWord(w, o))).length;
  const coverage = covered / wanted.length;
  // Qualifiers the consumer did not ask for mean a different kind of thing (a reaction on an issue *comment*).
  const extras = extra(all.filter((o) => !wanted.some((w) => sameWord(w, o)))).length;
  return Math.max(0.2, coverage * coverage) / (1 + extras);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function select(candidates: Candidate[], opt: InferOptions): Candidate[] {
  // Deprecated producers only count when nothing current can supply the value (a deprecated cluster still hangs together).
  const current = candidates.filter((c) => !c.deprecated);
  const pool = current.length > 0 ? current : candidates;
  if (pool.length === 0) return [];
  // Ties go to the shorter, more generic slug, then alphabetically, so the output is stable.
  pool.sort((a, b) => b.score - a.score || a.producer.length - b.producer.length || (a.producer < b.producer ? -1 : a.producer > b.producer ? 1 : 0));
  const best = pool[0].score;
  return pool.filter((c) => c.score >= opt.relativeCutoff * best).slice(0, opt.maxProducersPerParam);
}
