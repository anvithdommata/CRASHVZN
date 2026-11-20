import type { SceneController } from "../controller";
import { callTool, TOOLS, toolJsonSchema } from "../tools/registry";
import { EventQueue } from "./queue";
import type { AssistantEvent, Effort, ProviderAdapter } from "./types";

export interface OpenAiApiOptions {
  apiKey: string;
  systemPrompt: string;
  /** Tools run in-process against this controller (no MCP hop). */
  controller: SceneController;
  model?: string;
  effort?: Effort;
  /** Override for OpenAI-compatible endpoints. */
  baseUrl?: string;
}

const DEFAULT_MODEL = "gpt-5.5";
const MAX_TOOL_ROUNDS = 8;

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * API-key fallback for OpenAI (T3 Code lets Codex use an API key too). A plain Chat
 * Completions tool loop over the same tool registry the MCP server uses, so only our
 * tools exist. Plain REST, no SDK dependency. The key stays in the main process.
 *
 * UNVERIFIED end to end (no OpenAI API key on the dev machine); typechecked only.
 */
export class OpenAiApiAdapter implements ProviderAdapter {
  readonly kind = "openai-api" as const;
  private messages: Message[] = [];
  private abort: AbortController | null = null;
  private readonly tools = TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: toolJsonSchema(t) },
  }));

  constructor(private opts: OpenAiApiOptions) {}

  async start(): Promise<void> {}

  async *send(message: string): AsyncIterable<AssistantEvent> {
    if (this.abort) throw new Error("A turn is already running; wait for it or interrupt().");
    const q = new EventQueue<AssistantEvent>();
    this.abort = new AbortController();
    this.messages.push({ role: "user", content: message });
    void this.runTurn(q, this.abort.signal).finally(() => {
      this.abort = null;
      q.close();
    });
    yield* q;
  }

  private async complete(signal: AbortSignal): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
    const res = await fetch(`${this.opts.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify({
        model: this.opts.model || DEFAULT_MODEL,
        messages: [{ role: "system", content: this.opts.systemPrompt }, ...this.messages],
        tools: this.tools,
        tool_choice: "auto",
        reasoning_effort: this.opts.effort ?? "low",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401) throw new Error("OpenAI rejected the API key. Check it on the Providers page.");
      if (res.status === 429) throw new Error("Rate limited by the OpenAI API, or the key's quota is used up.");
      throw new Error(`OpenAI API error ${res.status}: ${body.slice(0, 300)}`);
    }
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("OpenAI returned no answer.");
    if (msg.refusal) throw new Error("The model declined this request.");
    return { content: msg.content ?? null, tool_calls: msg.tool_calls };
  }

  private async runTurn(q: EventQueue<AssistantEvent>, signal: AbortSignal) {
    const started = Date.now();
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const msg = await this.complete(signal);
        this.messages.push({ role: "assistant", content: msg.content, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
        if (msg.content) q.push({ type: "text", delta: msg.content });
        if (!msg.tool_calls?.length) {
          q.push({ type: "done", durationMs: Date.now() - started });
          return;
        }
        // Sequential: camera moves are order-dependent.
        for (const call of msg.tool_calls) {
          let args: unknown = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {}
          q.push({ type: "tool_call", id: call.id, name: call.function.name, input: args });
          const r = await callTool(this.opts.controller, call.function.name, args);
          const output = r.ok ? JSON.stringify(r.result) : r.error;
          q.push({ type: "tool_result", id: call.id, name: call.function.name, ok: r.ok, output });
          this.messages.push({ role: "tool", tool_call_id: call.id, content: output });
        }
      }
      q.push({ type: "error", message: "Stopped after too many tool calls in one turn." });
    } catch (err) {
      this.closeDanglingCalls();
      if (signal.aborted) q.push({ type: "done", durationMs: Date.now() - started });
      else q.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** After an abort mid-loop, answer pending tool calls so the next request is valid. */
  private closeDanglingCalls() {
    const answered = new Set(this.messages.flatMap((m) => (m.role === "tool" ? [m.tool_call_id] : [])));
    const last = [...this.messages].reverse().find((m) => m.role === "assistant") as Extract<Message, { role: "assistant" }> | undefined;
    for (const call of last?.tool_calls ?? []) {
      if (!answered.has(call.id)) this.messages.push({ role: "tool", tool_call_id: call.id, content: "Interrupted by the user." });
    }
  }

  async interrupt(): Promise<void> {
    this.abort?.abort();
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    this.messages = [];
  }
}
