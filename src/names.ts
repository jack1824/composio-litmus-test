/**
 * Name analysis. Dependencies between tools show up in names: a parameter `issue_number`
 * asks for the `number` of an `issue`; a tool `GITHUB_LIST_REPOSITORY_ISSUES` returns a list
 * of issues. This module turns both kinds of name into (entity, field) pairs that can be
 * compared. It knows nothing about any particular toolkit.
 */

/** The kind of value an identifier-like name refers to. */
export type FieldClass = "id" | "number" | "name" | "slug" | "login" | "sha" | "key";

const FIELD_WORDS: Record<string, FieldClass> = {
  id: "id", ids: "id", uuid: "id", guid: "id", gid: "id", sid: "id", uid: "id", pk: "id", oid: "id", urn: "id", identifier: "id",
  ts: "id", // Slack-style message timestamps identify a message
  number: "number", num: "number",
  name: "name",
  slug: "slug",
  login: "login", username: "login", handle: "login",
  sha: "sha", hash: "sha",
  key: "key",
};

/** Words that are not part of an entity name when they lead a field, e.g. `node_id`, `full_name`. */
const ATTRIBUTE_PREFIXES = new Set(["node", "full", "display", "file", "short"]);

const PREPOSITIONS = new Set([
  "for", "in", "on", "of", "to", "from", "by", "with", "without", "at", "as", "under",
  "within", "across", "via", "into", "about", "between", "against", "per", "after", "before",
]);
const FILLER = new Set(["a", "an", "the", "all", "any", "some", "and", "or"]);
/** Participles in slugs (`assigned`, `owned`, `starred`) describe how items were picked, not what they are. */
const isParticiple = (w: string) => w.length > 4 && w.endsWith("ed");
/** Words that qualify a tool without saying what it is about. */
const NOISE = new Set(["authenticated", "current", "specific", "given", "particular", "single", "latest", "recent"]);
const ALIASES: Record<string, string> = { repo: "repository", repos: "repository", org: "organization", orgs: "organization", env: "environment" };
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

export function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Crude singularization. It only has to be consistent: both sides of a comparison get the same treatment. */
export function stem(word: string): string {
  const w = own(ALIASES, word) ?? word;
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("tuses")) return w.slice(0, -2); // statuses -> status
  if (/(ss|us|is)$/.test(w)) return w;
  if (w.length > 4 && /(sses|shes|ches|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** Prefixes that glue onto a noun without changing what it is: webhook / hook, prerelease / release. */
const COMPOUND_PREFIXES = ["web", "pre"];

/**
 * Equal after stemming, or one is the other with one of those prefixes. It is a whitelist on purpose: a general
 * "ends with" rule matched `base` inside `database`, `view` inside `review` and `count` inside `account`.
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && COMPOUND_PREFIXES.some((prefix) => long === prefix + short);
}

const stemAll = (words: string[]) => words.map(stem);

export interface NameShape {
  /** What the value identifies, as stemmed words: `issue_number` -> ["issue"]. May be empty. */
  entity: string[];
  /** Which field of the entity: `issue_number` -> "number". Null when the name carries no field word. */
  cls: FieldClass | null;
}

/**
 * Split an identifier-like name into entity and field.
 *   issue_number -> { entity: [issue], cls: number }
 *   username     -> { entity: [],      cls: login }
 *   branch       -> { entity: [branch], cls: null }   (a bare noun; callers treat it as a name)
 */
export function parseName(name: string): NameShape {
  let all = tokens(name);
  // `issueIdOrKey` accepts either; ask for the first (the id) rather than reading the alternative as the field.
  const orAt = all.indexOf("or");
  if (orAt > 1 && own(FIELD_WORDS, all[orAt - 1]) && own(FIELD_WORDS, all[orAt + 1] ?? "")) all = all.slice(0, orAt);
  const words = all.filter((w) => !FILLER.has(w));
  if (words.length === 0) return { entity: [], cls: null };
  const last = words[words.length - 1];
  const cls = own(FIELD_WORDS, last) ?? null;
  if (!cls) return { entity: stemAll(words), cls: null };
  return { entity: stemAll(words.slice(0, -1)), cls };
}

/** Leaf fields like `node_id` or `full_name` look identifier-like but do not identify an entity. */
export function isAttributeField(shape: NameShape): boolean {
  return shape.entity.some((w) => ATTRIBUTE_PREFIXES.has(w));
}

export type Role = "list" | "get" | "create" | "delete" | "other";
const ROLE_OF_VERB: Record<string, Role> = {
  list: "list", search: "list", find: "list", query: "list", browse: "list", enumerate: "list",
  get: "get", retrieve: "get", fetch: "get", read: "get", describe: "get", lookup: "get", show: "get", view: "get", load: "get",
  create: "create", add: "create", register: "create", fork: "create", copy: "create", upload: "create",
  generate: "create", start: "create", open: "create", post: "create", send: "create", make: "create",
  submit: "create", insert: "create", clone: "create", duplicate: "create", schedule: "create", import: "create",
  new: "create", launch: "create", compose: "create", place: "create", book: "create", publish: "create", save: "create",
  delete: "delete", remove: "delete", destroy: "delete", revoke: "delete", clear: "delete", cancel: "delete",
};
const isKnownVerb = (word: string) => Object.hasOwn(ROLE_OF_VERB, word);
/** Verbs after which the object's name is chosen by the caller, not looked up. */
export const CREATING_ROLES: ReadonlySet<Role> = new Set(["create"]);

export interface SlugShape {
  verb: string;
  role: Role;
  /** What the tool is about: LIST_REPOSITORY_ISSUES -> [repository, issue]. */
  head: string[];
  /** What it is scoped to: LIST_REPOSITORIES_FOR_A_USER -> [user]. */
  scope: string[];
}

/**
 * Most slugs share a toolkit prefix (`GITHUB_`, `GOOGLE_CALENDAR_`); find it so it is not mistaken for part of a
 * name. The first word has to be shared by most of the catalog (60%); each later word by nearly all slugs that share
 * the earlier ones (80%). A verb is never a prefix, except for the first word of a large catalog (a toolkit that
 * really is called Close).
 */
export function commonPrefix(slugs: string[]): string[] {
  if (slugs.length < 2) return [];
  const prefix: string[] = [];
  let pool = slugs.map(tokens);
  for (let pos = 0; pos < 3; pos++) {
    const counts = new Map<string, number>();
    for (const t of pool) if (t[pos]) counts.set(t[pos], (counts.get(t[pos]) ?? 0) + 1);
    const [word, n] = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] ?? ["", 0];
    const share = pos === 0 ? n / slugs.length : n / pool.length;
    if (!word || share < (pos === 0 ? 0.6 : 0.8)) break;
    if (isKnownVerb(word) && (pos > 0 || slugs.length < 10)) break; // CREATE_A / CREATE_B share a verb, not a toolkit name
    prefix.push(word);
    pool = pool.filter((t) => t[pos] === word);
  }
  return prefix;
}

const isPlural = (w: string) => w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w);

/**
 * Read a tool slug as VERB + subject + optional scope after a preposition.
 * The grammar is only approximate (slugs are English-ish), so callers must treat the result as evidence, not truth.
 * If the first word is not a known verb, a known verb within the first few words is used instead: it is either
 * left-over prefix (GOOGLE_CALENDAR_LIST_EVENTS with the prefix cut after GOOGLE) or a verb-last name (ISSUES_LIST).
 */
export function parseSlug(slug: string, prefix: string[]): SlugShape {
  let words = tokens(slug);
  if (prefix.length && words.slice(0, prefix.length).join() === prefix.join()) words = words.slice(prefix.length);
  // The brand repeated inside the slug (NOTION_SEARCH_NOTION_PAGE) is not part of what the tool is about.
  const withoutBrand = prefix.length ? words.filter((w) => w !== prefix[0]) : words;
  if (withoutBrand.length >= 2) words = withoutBrand;

  let verbAt = 0;
  if (!isKnownVerb(words[0] ?? "")) {
    const found = words.slice(0, 4).findIndex(isKnownVerb);
    if (found > 0) verbAt = found;
  }
  const verb = words[verbAt] ?? "";
  let rest = verbAt > 0 && verbAt === words.length - 1 ? words.slice(0, verbAt) : words.slice(verbAt + 1);
  if (rest[0] === "or") rest = rest.slice(2); // CREATE_OR_UPDATE_X: the second verb is not part of the subject

  const cut = rest.findIndex((w) => PREPOSITIONS.has(w));
  const keep = (ws: string[]) => ws.filter((w) => !FILLER.has(w) && !NOISE.has(w) && !PREPOSITIONS.has(w) && !isParticiple(w));
  const rawHead = keep(cut === -1 ? rest : rest.slice(0, cut));
  let head = stemAll(rawHead);
  const scope = cut === -1 ? [] : stemAll(keep(rest.slice(cut + 1)));
  if (head.length === 0 && scope.length > 0) head = scope;

  let role = own(ROLE_OF_VERB, verb) ?? "other";
  // GET_ALL_USERS / GET_PULL_REQUESTS return many items whatever the verb says.
  if (role === "get" && (words.includes("all") || (rawHead.length > 0 && isPlural(rawHead[rawHead.length - 1])))) role = "list";
  return { verb, role, head, scope };
}
