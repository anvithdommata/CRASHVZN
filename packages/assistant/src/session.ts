import type { SceneController } from "./controller";
import { matchFastPath } from "./fastpath";
import { startMcpServer, type RunningMcpServer } from "./mcp/server";
import { buildSystemPrompt, type SystemPromptContext } from "./prompt/system-prompt";
import { AnthropicApiAdapter } from "./providers/anthropic-api";
import { ClaudeCliAdapter } from "./providers/claude-cli";
import { CodexCliAdapter } from "./providers/codex-cli";
import { GeminiApiAdapter } from "./providers/gemini-api";
import { geminiApiKeyFromEnv } from "./providers/health";
import { GeminiCliAdapter } from "./providers/gemini-cli";
import { GrokCliAdapter } from "./providers/grok-cli";
import { OpenAiApiAdapter } from "./providers/openai-api";
import { OpenCodeCliAdapter } from "./providers/opencode-cli";
import type { AssistantEvent, Effort, ProviderAdapter, ProviderKind } from "./providers/types";
import { callTool } from "./tools/registry";

export interface AssistantSessionOptions {
  controller: SceneController;
  provider: ProviderKind;
  model?: string;
  /** Reasoning effort (Claude CLI, Codex, Anthropic API). Omit for the provider's default. */
  effort?: Effort;
  /** Required when provider is "anthropic-api". Kept in memory only. */
  apiKey?: string;
  /** For "gemini-api"; defaults to GEMINI_API_KEY / GOOGLE_API_KEY from the environment. */
  geminiApiKey?: string;
  /** For "openai-api"; defaults to OPENAI_API_KEY from the environment. Kept in memory only. */
  openaiApiKey?: string;
  /** Extra env for CLI adapters (e.g. XAI_API_KEY for Grok). */
  env?: NodeJS.ProcessEnv;
  prompt?: SystemPromptContext;
  /** Default true. Set false to send everything to the LLM (useful for testing the prompt). */
  fastPath?: boolean;
  /** Notified on every tool call, from the fast path, the MCP server, or the API adapter. */
  onToolCall?: (name: string, args: unknown, ok: boolean) => void;
}

/** Events for the chat panel. `source` tells the UI whether the LLM was involved. */
export type SessionEvent = AssistantEvent & { source: "fast-path" | ProviderKind };

/**
 * One chat session: the MCP server, the chosen provider, and the fast path.
 * This is what the Electron main process creates and the chat/voice panel talks to.
 *
 * ```ts
 * const session = await AssistantSession.create({ controller, provider: "claude" });
 * for await (const ev of session.send("zoom in on the red toyota")) ui.render(ev);
 * ```
 */
export class AssistantSession {
  private constructor(
    private opts: AssistantSessionOptions,
    private mcp: RunningMcpServer,
    private adapter: ProviderAdapter,
  ) {}

  static async create(opts: AssistantSessionOptions): Promise<AssistantSession> {
    const mcp = await startMcpServer({ controller: opts.controller, onToolCall: opts.onToolCall });
    const adapter = makeAdapter(opts, mcp);
    const session = new AssistantSession(opts, mcp, adapter);
    // Pre-warm long-lived CLIs so the first voice command doesn't pay spawn cost.
    await adapter.start();
    return session;
  }

  get provider(): ProviderKind {
    return this.adapter.kind;
  }

  async *send(text: string): AsyncIterable<SessionEvent> {
    if (this.opts.fastPath !== false) {
      const fast = matchFastPath(text);
      if (fast) {
        const id = `fast-${Date.now()}`;
        const started = performance.now();
        yield { source: "fast-path", type: "tool_call", id, name: fast.tool, input: fast.args };
        const res = await callTool(this.opts.controller, fast.tool, fast.args);
        this.opts.onToolCall?.(fast.tool, fast.args, res.ok);
        yield { source: "fast-path", type: "tool_result", id, name: fast.tool, ok: res.ok, output: res.ok ? JSON.stringify(res.result) : res.error };
        yield { source: "fast-path", type: "text", delta: res.ok ? fast.reply : `Sorry, that didn't work: ${res.error}` };
        yield { source: "fast-path", type: "done", durationMs: Math.round(performance.now() - started) };
        return;
      }
    }
    const source = this.adapter.kind;
    for await (const ev of this.adapter.send(text)) yield { ...ev, source };
  }

  interrupt(): Promise<void> {
    return this.adapter.interrupt();
  }

  /** Swap providers mid-session (conversation history does not carry over). */
  async switchProvider(
    provider: ProviderKind,
    extra: Pick<AssistantSessionOptions, "model" | "effort" | "apiKey" | "geminiApiKey" | "openaiApiKey" | "env"> = {},
  ): Promise<void> {
    await this.adapter.stop();
    this.opts = { ...this.opts, provider, ...extra };
    this.adapter = makeAdapter(this.opts, this.mcp);
    await this.adapter.start();
  }

  async close(): Promise<void> {
    await this.adapter.stop();
    await this.mcp.close();
  }
}

function makeAdapter(opts: AssistantSessionOptions, mcp: RunningMcpServer): ProviderAdapter {
  const systemPrompt = buildSystemPrompt(opts.prompt);
  const base = { mcp: { url: mcp.url, token: mcp.token }, systemPrompt, model: opts.model, effort: opts.effort, env: opts.env };
  switch (opts.provider) {
    case "claude":
      return new ClaudeCliAdapter(base);
    case "codex":
      return new CodexCliAdapter(base);
    case "gemini":
      return new GeminiCliAdapter(base);
    case "opencode":
      return new OpenCodeCliAdapter(base);
    case "grok":
      return new GrokCliAdapter(base);
    case "cursor":
      throw new Error("Chat with Cursor isn't supported yet. Pick another provider.");
    case "openai-api": {
      const apiKey = opts.openaiApiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("An OpenAI API key is required for the OpenAI API fallback.");
      return new OpenAiApiAdapter({ apiKey, systemPrompt, controller: opts.controller, model: opts.model, effort: opts.effort });
    }
    case "gemini-api": {
      const apiKey = opts.geminiApiKey ?? geminiApiKeyFromEnv();
      if (!apiKey) throw new Error("A Gemini API key is required for the Gemini API fallback.");
      return new GeminiApiAdapter({ apiKey, systemPrompt, controller: opts.controller, model: opts.model ?? process.env.GEMINI_API_MODEL });
    }
    case "anthropic-api": {
      if (!opts.apiKey) throw new Error("An Anthropic API key is required for the API fallback.");
      return new AnthropicApiAdapter({
        apiKey: opts.apiKey,
        systemPrompt,
        controller: opts.controller,
        model: opts.model,
        effort: opts.effort,
      });
    }
  }
}
