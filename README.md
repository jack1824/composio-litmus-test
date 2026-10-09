# Tool dependency graph generator

Reads a toolkit's tool catalog and writes `dependency_graph.json`: which tools must run before which
others, because one supplies an input the other needs. Nothing is hardcoded to GitHub; every node id
and every edge comes from the catalog it is handed.

```
npm install --legacy-peer-deps                              # as declared in generator.json
node --import tsx src/generate.ts path/to/catalog.json      # writes ./dependency_graph.json
```

| deliverable from the brief | where |
|---|---|
| generator that reads a catalog and writes `dependency_graph.json` | `src/generate.ts` (+ `catalog.ts`, `names.ts`, `infer.ts`, `graph.ts`) |
| build / run declared | `generator.json` |
| visualization with nodes and edges | `visualization.html` (self-contained, open in a browser; rebuild with `npm run visualize`) |
| the catalog used | `github_catalog.json` |

`dependency_graph.json` itself is gitignored (the grader generates it), which is why the visualization
embeds the graph instead of loading the file.

## What it produces

```json
{ "nodes": [{ "id": "GITHUB_CREATE_AN_ISSUE", "service": "issues" }],
  "edges": [{ "from": "GITHUB_LIST_REPOSITORY_ISSUES", "to": "GITHUB_CREATE_AN_ISSUE_COMMENT", "label": "issue_number" }] }
```

An edge is `producer -> consumer`; `label` is the consumer input the producer supplies. On the provided
GitHub catalog: 893 nodes, 1,012 edges, 511 connected tools (the rest need only what the user provides).
`service` reuses the catalog's own area tags (`issues`, `pulls`, `gists`, ...).

## How it works

Dependencies are not stated in a catalog, but names carry them: an input `issue_number` asks for the
`number` of an `issue`, and `GITHUB_LIST_REPOSITORY_ISSUES` returns `issues[].number`. The generator is
deterministic (independent of locale and of the order tools appear in), runs in about 0.5 s and needs no API key.

| module | job |
|---|---|
| `src/catalog.ts` | Load any catalog shape (array, `{tools}`, camelCase or snake_case, OpenAI function style); resolve `$ref`/`anyOf`/`allOf`; flatten each response schema into scalar "facts" like `issues[].number`. Malformed entries are skipped and reported; a tool whose schema cannot be read is kept as a node with a warning. |
| `src/names.ts` | Tokenize and stem names; parse `issue_number` into (entity `issue`, field `number`); read a slug as verb + subject + scope, with the toolkit prefix found by consensus (`GOOGLE_CALENDAR_`), the verb searched for if it is not the first word, and verb-last slugs handled. |
| `src/infer.ts` | For each required input, score every fact that could supply it; keep the best few. |
| `src/graph.ts` | Assemble nodes and edges. |

`score = entity × field × fact weight × context × role × ease`, each in [0, 1]:

- **entity**: does the response describe the same kind of thing the input asks for?
- **field**: the right field (number vs id vs slug vs name)? Bare inputs such as `customer` take the field
  from their description ("The ID of the customer" -> id).
- **fact weight**: the tool's own subject, including its own id spelled long-hand (`messages[].messageId`),
  is 1.0; a foreign key it returns (`workflow_id` inside `workflow_runs[]`) 0.5; a secondary object nested in
  its response 0.4. A check-run response mentions a pull request; that does not make it a way to find pull
  request numbers.
- **context**: `UPDATE_AN_ISSUE_COMMENT` wants a comment *of an issue*, so a gist-comment lister is
  rejected; an organization webhook list does not supply a repository webhook id.
- **role**: list/search 1.0, get 0.75, unrecognised verb 0.55, **create 0.5**, delete 0. Looking up what
  exists beats creating something just to get an id. A tool returning exactly one collection reads as a
  lister whatever its verb says; `GET_ALL_*` and plural subjects are lists.
- **ease**: prefer producers that need fewer ids themselves.

Up to 4 producers per input are kept, within 55% of the best score, so alternatives survive
("there could be other ways to get an `issue_number`") without flooding the graph. Deprecated producers
are used only when nothing current can supply the value.

Hard exclusions:

- a tool never supplies a value it needs itself (`GET_AN_ISSUE` needs `issue_number`; a getter that
  merely accepts the id optionally counts too, and so does a bare-noun id such as Stripe's `customer`);
- enums, arrays, objects and booleans are the user's; so is free text;
- a create tool does not look up the name it is choosing (`CREATE_BRANCH.branch`, or a name whose
  description says it "must be unique");
- people's handles (`username`, `user_login`) are the user's unless `inferHandles` is switched on;
- **ambient** inputs get no edges. A frequent input (15% of the catalog) is ambient if required by most of
  it (40%) or almost always together with another frequent input (`owner` + `repo`), **and** it either names
  a container noun (repository, organization, workspace...) or nothing in the catalog produces it. An input
  that other tools exist to look up (a Slack `channel`, an `issue_number`) stays a dependency however often
  it is required; this also keeps a trimmed catalog from losing its core dependency.

## Decisions and tradeoffs

- **No edges for `owner`/`repo`.** Half the catalog requires them; wiring them adds hundreds of edges into
  a few hubs and buries the real dependencies, and they are what the user tells the agent.
- **No edges for handles.** The first graph had ~300 `username` edges (23% of everything) fanning out of a
  few user-listing tools. Found by rendering the graph and looking at it.
- **Compound nouns come from the catalog, not a word list.** `pull_number` should match `pull_requests`,
  but `release_id` must not match `release assets`. A bare word may extend to a longer phrase only if it
  never stands alone as a subject elsewhere in the catalog (`pull` never does; `release` does).
- **Word matching is conservative.** Singular/plural is a crude stemmer; the only prefix compounds allowed
  are `web-` and `pre-` (`hook`/`webhook`). A general "ends with" rule matched `base` inside `database`.
- **Names the user states** (branches, team slugs, secret names) still get edges to their list tool. The
  blind judges split on these: valid as optional discovery, but a user normally supplies them. Kept
  because "there could be other ways" is part of the brief; this is the biggest source of
  "valid but unnecessary" edges.

## Evaluation

`npm test` runs 105 tests. `npm run eval [-- gold.json]` runs the real generator (output to a temp file) and
scores it against hand-labeled ground truth in `eval/`; it exits non-zero on recall below 90%, a rejected
producer, a negative leak or a structural violation. Each case lists accepted producers (any one is a hit),
rejected look-alikes (wrong entity, wrong scope, circular), and separately the inputs that must get no edge.

| set | cases | built | measures |
|---|---|---|---|
| `github.gold.json` | 30 | before the matcher existed | tuning |
| `github.holdout.json` | 32 | after tuning, labeled before looking at its results | generalization |
| blind audits (`eval/audit/`) | 100 edges + 60 inputs per round | random sample judged without our scores | precision / recall |
| hostile review | 4 reviewers | independent attack on code, tests, claims, other toolkits | what I could not see myself |

**The numbers, including the ones that do not flatter.**

- Tuning set: 30/30 recall when first committed; **29/30 now**, 100% judged precision, 0 negative leaks. The
  one miss (`ACCEPT_REPOSITORY_INVITATION` gets the repository's invitation list instead of the invitee's) is
  a tradeoff I accepted after the blind audit showed the rule that made it work produced wrong edges elsewhere.
- Held-out set, **first look**: 29/32 recall (90.6%), 57/59 judged precision, 1 negative leak. I then fixed
  three diagnosed failures and it now scores 32/32, but it was used to tune those rules, so only the
  first-look numbers estimate generalization.
- "Judged precision" counts only edges in an accepted or rejected list (20 and 29 emitted edges are in
  neither). That is why the blind audit exists.
- **Blind audit** (fresh judge agents given the catalog and cards without scores; a neutral and a skeptical
  judge per edge; recall judges never saw our edges):

| | round 1 (before fixes) | round 2 (fresh sample, after fixes) |
|---|---|---|
| precision, neutral judge | 90% | ~92% |
| precision, skeptical judge | 73% | 83% |
| edges both judges accept | 73/100 | 83/100 |
| judge agreement | 83/100 | 91/100 |
| inputs judged "comes from a tool" where we emit a matching producer | 16 of 28 | 18 of 26 |

The rounds use different samples, so the difference is an estimate, not a controlled experiment. **Neither
round audited the final graph**: later changes (below) are covered by the gold sets, the golden snapshot and
the tests, not by a third blind round.

- **Hostile review** (four independent reviewers, each reproducing what it reported). It found that everything
  above was measured on GitHub only. On seven realistic non-GitHub catalogs the reviewer wrote (Slack, Jira,
  Stripe, Linear, Notion, Google Calendar, Gmail; 19 to 44 tools each) only 47 of 166 obvious dependencies
  (28%) were wired: multi-word prefixes, a closed verb list, a frequency-based "ambient" rule and an
  over-strict foreign-key weight were hard cliffs. After the fixes the same measure is **126/166 (76%)**
  (Google Calendar 8% -> 100%, Stripe 32% -> 72%, Linear 31% -> 96%, Jira 41% -> 50%), with GitHub gold and
  holdout unchanged. Caveats: the catalogs are AI-written approximations of the real ones, and the measure only
  counts that an edge exists into the input, not that it is right (I read the Stripe, Calendar and Slack edges
  and they are right apart from one circularity bug it exposed and I fixed).
  The same reviewer mutated the source 479 times; 301 mutations survived the old suite (cap, tie-break, weights,
  pair rule). The new suite adds a golden snapshot, direct tests of the cap, cutoff and tie-breaks, and
  order-independence tests; I re-ran 12 of the surviving mutations against it and all 12 are now caught (I did
  not re-run all 301).

**What the tests prove and what they do not.** They prove the rules behave as described, that failure modes
found during development stay fixed, that structural invariants hold on the real graph (no self or duplicate
edges, labels are real required inputs, producers expose output, no edge into an enum), that the GitHub edge
set cannot change without a reviewed snapshot update, and that nothing is hardcoded (changing the input changes
the output; synthetic Slack-like, Notion-like, multi-word-prefix and unprefixed catalogs work). They do not prove
the edges are right: the labels and the matcher share an author, the audit judges and reviewers share a model
family with that author, GitHub is the only real catalog, and the visualization was smoke-tested by running
its script against stubbed browser APIs, not by eye in every browser.

## LLM verifier (opt-in, off by default)

`DEP_GRAPH_LLM=verify` sends only edges scoring below 0.75 to the model and drops those it answers
`keep=false`. It can only remove edges, never invents a slug, and any failure keeps the deterministic
edges (a batch's drops count only if its whole reply is readable). `DEP_GRAPH_LLM=dry-run` prints the batch
count and token estimate without a request. For each reviewed edge a request contains the consumer and
producer slugs, their descriptions (first 200 characters), the input's name and description, the producer's
required input names and the matching response-field path, and goes to whatever host `OPENAI_BASE_URL` names.
(`.env` names the credentials `OPEN_AI_API_KEY` / `base_url`; the SDK reads `OPENAI_API_KEY` /
`OPENAI_BASE_URL`, so they must be mapped.)

I ran it once on the GitHub catalog (before the generalization fixes, on a 1,005-edge graph): 6 requests,
19,973 prompt + 3,050 completion tokens, 136 edges reviewed, 22 dropped. Judged blind: 16 of the 22 drops were
invalid under both judges (the whole classic-vs-V2 project cluster, org-vs-user package versions, a child
issue's id offered for the parent's); 6 were valid edges lost, mostly GraphQL node-id edges. Of 30 sampled
doubtful edges it kept, 30 were valid. Net: about +1.6 points of graph precision for roughly 23k tokens per
catalog. That is a modest gain for a recurring token cost, so it ships off. Evidence: `eval/audit/verifier.json`.

## Limitations and known wrong cases

- **Semantics that names cannot carry.** Actions vs Dependabot vs Codespaces secrets; classic vs V2
  projects; an invitee's invitation list vs a repository's. The verifier catches some.
- **Relationships not visible in names or schemas.** The brief's own example: to merge a pull request you
  only have a *branch name* for, `LIST_PULL_REQUESTS` filters by `head`; no field name says a branch can
  find a pull request number. Also ids named by role rather than entity (`assignee_id` -> a user,
  `parent_id`, `leadAccountId`) have no link to their target. That needs descriptions or a language model.
- **The action's target read as a qualifier.** `LINEAR_ADD_ISSUE_LABEL(label_id)` is read as "a label *of an
  issue*", which penalizes the plain label lister.
- Array inputs (`labels`, `selected_repository_ids`), `*_sha` inputs with an unusual prefix (`head_sha`),
  and responses wrapped in several named objects (GraphQL `data.team.cycles.nodes[]`) are not matched.
- **English-ish naming is assumed**: verbs like list/get/create (46 are known; others get a reduced
  weight), field words like id/number/name/slug/gid/ts, the generic wrappers (`data`, `items`, `results`...)
  and container nouns (`organization`, `repository`, `workspace`, ...) are word lists.
- Verb-last slugs work only when no leading word is mistaken for part of the prefix; catalogs where fewer
  than 60% of slugs share a leading word get no prefix (the verb search then does the work).
- Only an array or an object with a `tools`/`items`/`data`/`results` array is accepted as a catalog.
- Performance is fine at toolkit scale (893 tools: 0.5 s); cost grows roughly quadratically when many tools
  share entity words, and memory becomes noticeable beyond ~10k tools.
- Ties among equally good producers (14 tools list repositories) are broken by shorter slug, then
  alphabetically, within the cap of 4.
- One mutual dependency remains in the GitHub graph (`LIST_COMMITS_ON_A_PULL_REQUEST` and
  `LIST_PULL_REQUESTS_ASSOCIATED_WITH_A_COMMIT`, each supplying the other's input).
- When a catalog has no area tags, `service` falls back to the tool's subject words, which is a noisy grouping.

## How this was built

Built with Claude as an engineering copilot, in small steps, with the ground truth written before the
matcher and a held-out set labeled before its results were seen. The blind audit judges and the four hostile
reviewers were also model agents (not the assessment's OpenAI budget). The git history records the order,
including the mistakes caught on the way: a regression from an over-eager penalty, a circularity check that
silently disabled every package lister, vacuous tests that were replaced, and, from the hostile review, a
generator that looked good on GitHub but wired barely a quarter of the obvious dependencies of other toolkits.

```
src/        generate.ts (entrypoint)  catalog.ts  names.ts  infer.ts  graph.ts  llm.ts  render.ts  visualize.ts
test/       unit and integration tests              eval/    gold sets, harness, golden snapshot, audit tools and evidence
viz/        visualization template                  visualization.html   committed picture
```

Commands: `npm test` · `npm run eval` · `npm run eval -- eval/github.holdout.json` · `npm run selfcheck` ·
`npm run visualize` · `npm run snapshot` (after an intended change to the GitHub edge set) ·
`node --import tsx eval/audit_sample.ts <dir> [seed]`.

---

## Original assessment brief (unchanged)

# build a tool dependency graph generator (60-120 mins)

we care about the quality and structure of the dependency relationships you discover

some actions need precursor actions before being able to execute them

a concrete example

1. the tool `GITHUB_CREATE_AN_ISSUE_COMMENT` which needs an `issue_number`
2. which can be got by `GITHUB_LIST_REPOSITORY_ISSUES` as an example, there could be other ways to get an `issue_number` too

a second more dense exmaple
the merge tool `GITHUB_MERGE_A_PULL_REQUEST` needs a `pull_number`, if you only have a branch name you first list the pull requests with `GITHUB_LIST_PULL_REQUESTS` to find the matching one and then you can merge it

when we agentically execute actions inside composio, we need to know either what info to get from the user or what other action we should take before we execute the action.

you are supposed to build a program that generates this dependency graph — a generator that reads a toolkit's tool catalog and outputs the graph, instead of hand-writing it

to keep this limited in scope, we give you [Github](https://docs.composio.dev/toolkits/github) as an example toolkit to build and test against — but your generator should generalize: it reads a toolkit's catalog and produces the graph, so it works for any toolkit, not just this one

the final submission should be a visualized dependency graph where i can see connection (this is not super important just should exist for me to see if graph with edges and nodes)

## deliverable

commit a **generator** at the repo root — a program that produces a `dependency_graph.json` from a toolkit's catalog. we run it: your generator is called with the path to a toolkit's catalog as a command-line argument (e.g. `node src/generate.ts path/to/catalog.json`), and it writes `dependency_graph.json` at the repo root (declare build/run in `generator.json`). it must read the catalog it's given, not hardcode a fixed graph. the graph shape our checks read:

```json
{
  "nodes": [{ "id": "GITHUB_CREATE_AN_ISSUE", "service": "issues" }],
  "edges": [{ "from": "GITHUB_LIST_REPOSITORY_ISSUES", "to": "GITHUB_CREATE_AN_ISSUE_COMMENT", "label": "issue_number" }]
}
```

- each edge is `producer -> consumer`; `label` is the id/field the producer supplies (e.g. `issue_number`, `pull_number`).
- use Composio's tool slugs for node ids (e.g. `GITHUB_CREATE_AN_ISSUE`), taken from the catalog you were given.
- also commit a visualization (nodes + edges you can see) and the tool catalog you use.

## get started

1. the GitHub tool catalog is already provided at `github_catalog.json` — no api key needed.
2. write your generator in `src/generate.ts` to read a toolkit's catalog and produce the graph. run `npm run selfcheck` to try it on `github_catalog.json` as you iterate.
3. use node/tsx or python (`bun` isn't guaranteed when we run your generator).

for language models, use the **AI API credentials** (a Base URL and API key) shown on your Litmus assessment page. they work with the OpenAI SDK: point the client's `baseURL`/`base_url` at that url and pass the key, and call an allowed model such as `openai/gpt-4o`. your usage counts against the assessment's token budget.

you can implement this with whatever language you want, feel free to use language models and coding tools

## submit

once you are done, run `litmus submit` from your assessment folder. make sure your generator (see **deliverable** above) is committed.

## activity tracking

your work is tracked automatically while you work (file changes, git history, and AI-tool prompts) and included when you `litmus submit`. there is nothing to run, just commit often.

NOTE:  Feel free to use LLM, you will be judged by the quality of output, eval...
