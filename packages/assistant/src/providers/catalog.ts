import type { ApiKeyKind, ProviderKind } from "./types";

/**
 * What the Providers page shows for each chat provider, and how it signs in.
 *
 * Mirrors T3 Code's provider setup (pingdotgg/t3code, docs/user/install.md "Providers"
 * table and apps/server/src/provider/*): install the provider's own CLI, sign in with
 * that CLI's own login command, and detect status by asking the CLI (`--version`, then
 * its auth-status command). API-key providers take a key we store encrypted.
 */
export interface ProviderInfo {
  kind: ProviderKind;
  label: string;
  /** Short "how it authenticates" line, e.g. "Claude subscription login". */
  detail: string;
  auth: "cli" | "api-key";
  /** Executable name on PATH (CLI providers). */
  cli?: string;
  /**
   * Sign-in command (CLI args after the executable). `browser` means the command opens
   * a browser OAuth page by itself and needs no keyboard input, so the app can run it
   * hidden; otherwise it needs a terminal (provider pickers, first-run prompts).
   */
  login?: { args: string[]; browser: boolean };
  /** Shown when the CLI isn't on PATH. */
  install?: { command?: string; url: string };
  /** Env var the stored key is injected as, for API-key providers. */
  apiKeyEnv?: string;
  /** Whether there's a chat adapter. Cursor is status + sign-in only (see README). */
  chat: boolean;
  /**
   * How far the adapter has been exercised: "verified" = run end to end with our MCP
   * tools; "partial" = runs, some paths untested; "unverified" = written from docs/T3
   * source, CLI not installed on the dev machine.
   */
  tested: "verified" | "partial" | "unverified";
  /** Model choices for the picker. "" = the provider's own default. */
  models: { id: string; label: string }[];
  efforts: ("low" | "medium" | "high")[];
}

const EFFORTS: ProviderInfo["efforts"] = ["low", "medium", "high"];
const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
];

export const PROVIDER_CATALOG: ProviderInfo[] = [
  {
    kind: "claude",
    label: "Claude",
    detail: "Claude Code · Claude subscription login",
    auth: "cli",
    cli: "claude",
    login: { args: ["auth", "login"], browser: true },
    install: { command: "npm i -g @anthropic-ai/claude-code", url: "https://claude.com/claude-code" },
    chat: true,
    tested: "verified",
    models: CLAUDE_MODELS,
    efforts: EFFORTS,
  },
  {
    kind: "codex",
    label: "Codex",
    detail: "Codex CLI · ChatGPT login",
    auth: "cli",
    cli: "codex",
    login: { args: ["login"], browser: true },
    install: { command: "npm i -g @openai/codex", url: "https://developers.openai.com/codex/cli" },
    chat: true,
    tested: "partial",
    models: [{ id: "", label: "Default model" }],
    efforts: EFFORTS,
  },
  {
    kind: "opencode",
    label: "OpenCode",
    detail: "OpenCode · its own provider logins",
    auth: "cli",
    cli: "opencode",
    // Interactive: OpenCode asks which provider to connect first.
    login: { args: ["auth", "login"], browser: false },
    install: { command: "npm i -g @opencode/cli", url: "https://opencode.ai" },
    chat: true,
    tested: "verified",
    models: [{ id: "", label: "Default model" }],
    efforts: [],
  },
  {
    kind: "gemini",
    label: "Gemini",
    detail: "Gemini CLI · Google login",
    auth: "cli",
    cli: "gemini",
    // Gemini CLI has no login subcommand; its first run asks how to sign in.
    login: { args: [], browser: false },
    install: { command: "npm i -g @google/gemini-cli", url: "https://github.com/google-gemini/gemini-cli" },
    chat: true,
    tested: "unverified",
    models: [{ id: "", label: "Default model" }],
    efforts: [],
  },
  {
    kind: "grok",
    label: "Grok",
    detail: "Grok Build CLI · xAI login",
    auth: "cli",
    cli: "grok",
    login: { args: ["login"], browser: true },
    install: { url: "https://x.ai/cli" },
    chat: true,
    tested: "unverified",
    models: [{ id: "", label: "Default model" }],
    efforts: [],
  },
  {
    kind: "cursor",
    label: "Cursor",
    detail: "Cursor Agent CLI · Cursor login",
    auth: "cli",
    cli: "cursor-agent",
    login: { args: ["login"], browser: true },
    install: { url: "https://cursor.com/cli" },
    chat: false,
    tested: "unverified",
    models: [],
    efforts: [],
  },
  {
    kind: "anthropic-api",
    label: "Claude API",
    detail: "Anthropic API key",
    auth: "api-key",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    chat: true,
    tested: "partial",
    models: CLAUDE_MODELS,
    efforts: EFFORTS,
  },
  {
    kind: "openai-api",
    label: "OpenAI API",
    detail: "OpenAI API key",
    auth: "api-key",
    apiKeyEnv: "OPENAI_API_KEY",
    chat: true,
    tested: "unverified",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    ],
    efforts: EFFORTS,
  },
  {
    kind: "gemini-api",
    label: "Gemini API",
    detail: "Gemini API key",
    auth: "api-key",
    apiKeyEnv: "GEMINI_API_KEY",
    chat: true,
    tested: "unverified",
    models: [{ id: "", label: "Gemini 3.1 Flash Lite" }],
    efforts: [],
  },
];

/** T3 Code supports these too; we can't drive them yet (interfaces not determined). */
export const UNSUPPORTED_PROVIDERS = [
  { label: "Kiro", why: "ACP agent; its session/tool lock-down isn't documented enough to restrict it to our tools." },
  { label: "Pi", why: "Login happens inside its TUI (`pi` then /login); no documented non-interactive MCP mode." },
  { label: "Muse Code", why: "No public non-interactive or MCP interface found." },
  { label: "fx", why: "No public non-interactive or MCP interface found." },
  { label: "Antigravity", why: "T3 drives it through a managed runtime and Google sign-in we can't reuse." },
];

export const API_KEY_KINDS: ApiKeyKind[] = ["anthropic-api", "openai-api", "gemini-api"];

export function providerInfo(kind: string): ProviderInfo | undefined {
  return PROVIDER_CATALOG.find((p) => p.kind === kind);
}
