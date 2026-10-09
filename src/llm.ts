/**
 * Optional LLM verification of low-confidence edges. Off unless DEP_GRAPH_LLM is set.
 *
 * The deterministic matcher already produces the whole graph. This pass only ever REMOVES edges it is
 * unsure about: the model sees compact cards (consumer input, proposed producer) and answers keep or drop.
 * It cannot add an edge or invent a slug, and every failure path (no key, network error, malformed or
 * partial answer) keeps the deterministic edges, so a flaky model can never make the graph worse than
 * the matcher alone. Token use is bounded by `maxEdges` and reported when it finishes.
 */
import type { Tool } from "./catalog.js";
import type { Candidate } from "./infer.js";

export interface VerifyOptions {
  model: string;
  /** Candidates scoring at least this are trusted and never sent. */
  trustAbove: number;
  batchSize: number;
  /** Hard cap on edges sent, lowest scores first. */
  maxEdges: number;
  /** Count and estimate only: make no request. */
  dryRun: boolean;
}

export const DEFAULT_VERIFY: VerifyOptions = { model: "openai/gpt-4o", trustAbove: 0.75, batchSize: 25, maxEdges: 400, dryRun: false };

/** The slice of the OpenAI client we use, so tests can pass a fake. */
export interface ChatClient {
  chat: {
    completions: {
      create(args: any): Promise<{ choices: { message: { content: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>;
    };
  };
}

export interface VerifyReport {
  considered: number;
  sent: number;
  batches: number;
  dropped: number;
  failedBatches: number;
  estimatedPromptTokens: number;
  promptTokens: number;
  completionTokens: number;
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.replace(/\s+/g, " "));

const SYSTEM = `You review proposed dependencies between API tools for an AI agent. The agent wants to call a CONSUMER tool but lacks the value of one input. A proposed edge says it can get that value by first calling a PRODUCER tool.
Answer keep=true only if, after the agent supplies the producer's own inputs, the producer returns a value that can be passed directly as that input: same kind of thing, same scope (repository vs organization vs user), and the producer does not itself need that value.
Answer keep=false for: wrong kind of entity; wrong scope; the producer only mentions the value inside some other object; the producer needs the value itself; the input is really free text or a name the user chooses; or the producer creates a new thing when the user plainly means an existing one.
Reply with JSON only: {"judgments":[{"id":<number>,"keep":<true|false>,"reason":"<short>"}]} with one entry per id.`;

function card(id: number, c: Candidate, by: Map<string, Tool>) {
  const consumer = by.get(c.consumer)!;
  const producer = by.get(c.producer)!;
  return {
    id,
    consumer: { slug: consumer.slug, description: cut(consumer.description, 200), input: c.param, inputDescription: cut(consumer.inputs.find((i) => i.name === c.param)?.description ?? "", 200) },
    producer: {
      slug: producer.slug,
      description: cut(producer.description, 200),
      requires: producer.inputs.filter((i) => i.required).map((i) => i.name),
      returns: c.why.split(" via ")[1] ?? "",
    },
  };
}

export async function verifyCandidates(
  tools: Tool[],
  candidates: Candidate[],
  client: ChatClient | undefined,
  options: Partial<VerifyOptions> = {},
): Promise<{ candidates: Candidate[]; report: VerifyReport }> {
  const opt = { ...DEFAULT_VERIFY, ...options };
  const by = new Map(tools.map((t) => [t.slug, t]));
  const doubtful = candidates.filter((c) => c.score < opt.trustAbove).sort((a, b) => a.score - b.score).slice(0, opt.maxEdges);
  const batches: Candidate[][] = [];
  for (let i = 0; i < doubtful.length; i += opt.batchSize) batches.push(doubtful.slice(i, i + opt.batchSize));

  const prompts = batches.map((batch) => JSON.stringify(batch.map((c, i) => card(i + 1, c, by))));
  const report: VerifyReport = {
    considered: candidates.length, sent: doubtful.length, batches: batches.length, dropped: 0, failedBatches: 0,
    estimatedPromptTokens: Math.round(prompts.reduce((n, p) => n + (p.length + SYSTEM.length) / 4, 0)), promptTokens: 0, completionTokens: 0,
  };
  if (opt.dryRun || !client || doubtful.length === 0) return { candidates, report };

  const drop = new Set<Candidate>();
  for (let b = 0; b < batches.length; b++) {
    try {
      const res = await client.chat.completions.create({
        model: opt.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompts[b] }],
      });
      report.promptTokens += res.usage?.prompt_tokens ?? 0;
      report.completionTokens += res.usage?.completion_tokens ?? 0;
      const parsed = JSON.parse(res.choices[0]?.message?.content ?? "");
      const judgments: { id: number; keep: boolean }[] = Array.isArray(parsed?.judgments) ? parsed.judgments : [];
      // Collect this batch's drops first: they count only if the whole reply was readable, so a malformed entry
      // keeps every edge of the batch instead of applying the entries before it.
      const batchDrops: Candidate[] = [];
      for (const j of judgments) {
        const target = batches[b][j.id - 1];
        if (target && j.keep === false) batchDrops.push(target); // only an explicit "false" for a known id removes an edge
      }
      batchDrops.forEach((c) => drop.add(c));
    } catch (e) {
      report.failedBatches++;
      console.error(`llm: batch ${b + 1}/${batches.length} failed, keeping its edges (${(e as Error).message})`);
    }
  }
  report.dropped = drop.size;
  return { candidates: candidates.filter((c) => !drop.has(c)), report };
}
