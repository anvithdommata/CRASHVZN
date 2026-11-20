/**
 * Provider adapter contract (requirements §5.6). One implementation per
 * backend: claude CLI, codex CLI, gemini CLI, and the API-key fallback.
 */

/**
 * CLI kinds run on the user's own subscription login (preferred).
 * `*-api` kinds are API-key fallbacks, used only when no CLI login works.
 * "cursor" is detected and can be signed in to, but has no chat adapter yet
 * (see providers/catalog.ts).
 */
export type ProviderKind =
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "grok"
  | "cursor"
  | "gemini-api"
  | "anthropic-api"
  | "openai-api";

/** Kinds that authenticate with an API key we store (never a CLI login). */
export type ApiKeyKind = "anthropic-api" | "openai-api" | "gemini-api";

export type AssistantEvent =
  /** Streamed assistant text. Concatenate deltas within a turn. */
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name?: string; ok: boolean; output: string }
  /** Turn finished. */
  | { type: "done"; sessionId?: string; durationMs?: number; costUsd?: number }
  | { type: "error"; message: string };

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /** Spawn/connect. Idempotent. */
  start(): Promise<void>;
  /** Send one user message; yields events until `done` or `error`. One turn at a time. */
  send(message: string): AsyncIterable<AssistantEvent>;
  /** Abort the current turn, if any, keeping the session. */
  interrupt(): Promise<void>;
  /** Kill processes and delete temp files. */
  stop(): Promise<void>;
}

/** What every adapter needs to reach our MCP server. */
export interface McpEndpoint {
  url: string;
  token: string;
}

export interface AdapterOptions {
  mcp: McpEndpoint;
  systemPrompt: string;
  /** Model override; omit to use the CLI's default. */
  model?: string;
  /** Reasoning effort, where the provider supports it. */
  effort?: Effort;
  /** Extra env for the child process. */
  env?: NodeJS.ProcessEnv;
}

export type Effort = "low" | "medium" | "high";

export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

/** Like T3 Code's provider health: is it installed, is it signed in. */
export interface ProviderHealth {
  kind: ProviderKind;
  installed: boolean;
  version?: string;
  auth: AuthStatus;
  /** e.g. "Claude Pro", "ChatGPT", "API key". */
  authDetail?: string;
  /** Plain-language next step when it's not usable, e.g. "Run `claude auth login`". */
  hint?: string;
  usable: boolean;
}
