import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiKeyKind, ProviderHealth, ProviderKind } from "./types";
import { resolveCli, runCli } from "./resolve-cli";

/**
 * Detects which providers are installed and signed in, the way T3 Code does
 * (pingdotgg/t3code: apps/server/src/provider/ClaudeProvider.ts, CodexProvider.ts, and
 * packages/provider-grok|provider-opencode|provider-cursor/src/server/status.ts):
 * run `<cli> --version`, then the CLI's own auth-status command, and read only its
 * output. We never open, read or copy the user's credential files.
 */

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0] ?? "";
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export async function checkClaude(): Promise<ProviderHealth> {
  const cli = resolveCli("claude");
  if (!cli) return { kind: "claude", installed: false, auth: "unknown", usable: false, hint: "Install Claude Code: https://claude.com/claude-code" };
  const v = await runCli(cli, ["--version"]);
  const version = firstLine(v.stdout).replace(/\s*\(Claude Code\)\s*$/, "");
  // `claude auth status` prints JSON: { loggedIn, authMethod, subscriptionType, ... }
  const s = await runCli(cli, ["auth", "status"]);
  try {
    const j = JSON.parse(s.stdout);
    if (j.loggedIn) {
      // "claude.ai" = Claude subscription (Pro/Max/Team); anything else is Console/API billing.
      const detail =
        j.authMethod === "claude.ai"
          ? `Claude ${cap(String(j.subscriptionType ?? j.planTier ?? "subscription"))}`
          : [j.authMethod, j.apiProvider && j.apiProvider !== "firstParty" ? `(${j.apiProvider})` : ""].filter(Boolean).join(" ");
      return { kind: "claude", installed: true, version, auth: "authenticated", authDetail: detail || undefined, usable: true };
    }
    return { kind: "claude", installed: true, version, auth: "unauthenticated", usable: false, hint: "Sign in: `claude auth login`." };
  } catch {
    return { kind: "claude", installed: true, version, auth: "unknown", usable: true, hint: "Couldn't read `claude auth status`; it may still work." };
  }
}

export async function checkCodex(): Promise<ProviderHealth> {
  const cli = resolveCli("codex");
  if (!cli) return { kind: "codex", installed: false, auth: "unknown", usable: false, hint: "Install Codex CLI: npm i -g @openai/codex" };
  const v = await runCli(cli, ["--version"]);
  const version = firstLine(v.stdout).replace(/^codex-cli\s*/, "");
  // `codex login status` exits 0 with "Logged in using ChatGPT" / "Logged in using an API key".
  const s = await runCli(cli, ["login", "status"]);
  const out = (s.stdout + s.stderr).trim();
  if (s.code === 0 && /logged in/i.test(out)) {
    return { kind: "codex", installed: true, version, auth: "authenticated", authDetail: firstLine(out).replace(/^logged in using\s*/i, "") || undefined, usable: true };
  }
  return { kind: "codex", installed: true, version, auth: "unauthenticated", usable: false, hint: "Sign in: `codex login`." };
}

export async function checkGemini(): Promise<ProviderHealth> {
  const cli = resolveCli("gemini");
  if (!cli) return { kind: "gemini", installed: false, auth: "unknown", usable: false, hint: "Install Gemini CLI: npm i -g @google/gemini-cli" };
  const v = await runCli(cli, ["--version"]);
  const version = firstLine(v.stdout);
  // Gemini CLI has no auth-status command. Signed-in Google accounts leave
  // ~/.gemini/oauth_creds.json; we only check that it exists, never read it. An API key
  // doesn't count here: the CLI path is for the user's Google login (the key is "gemini-api").
  if (existsSync(join(homedir(), ".gemini", "oauth_creds.json"))) {
    return { kind: "gemini", installed: true, version, auth: "authenticated", authDetail: "Google account", usable: true };
  }
  return { kind: "gemini", installed: true, version, auth: "unauthenticated", usable: false, hint: "Run `gemini` in a terminal and choose Sign in with Google." };
}

/**
 * OpenCode keeps its own logins per model provider (`opencode auth login`).
 * `opencode auth list --format json` lists connected integrations by name and method
 * only (no secrets). T3 Code treats a working OpenCode catalog as authenticated; we
 * count at least one connected integration.
 */
export async function checkOpenCode(): Promise<ProviderHealth> {
  const cli = resolveCli("opencode");
  if (!cli) return { kind: "opencode", installed: false, auth: "unknown", usable: false, hint: "Install OpenCode: npm i -g @opencode/cli" };
  const v = await runCli(cli, ["--version"]);
  const version = firstLine(v.stdout).replace(/^opencode\s*v?/i, "");
  const s = await runCli(cli, ["auth", "list", "--format", "json"], 20_000);
  try {
    const list = JSON.parse(s.stdout) as { name?: string; connections?: { method?: string }[] }[];
    const connected = list.filter((i) => (i.connections ?? []).length > 0);
    if (connected.length) {
      const detail = connected
        .map((i) => `${i.name}${i.connections!.some((c) => c.method === "oauth") ? "" : " (key)"}`)
        .join(", ");
      return { kind: "opencode", installed: true, version, auth: "authenticated", authDetail: detail, usable: true };
    }
    return { kind: "opencode", installed: true, version, auth: "unauthenticated", usable: false, hint: "Connect a model provider: `opencode auth login`." };
  } catch {
    // OpenCode also offers free models with no login, so it may still work.
    return { kind: "opencode", installed: true, version, auth: "unknown", usable: true, hint: "Couldn't read `opencode auth list`; it may still work." };
  }
}

/**
 * Grok Build CLI. Status as in T3 Code (packages/provider-grok/src/server/status.ts):
 * `grok models` always exits 0; "You are logged in" / "not logged in" in its output is the
 * login state, and XAI_API_KEY counts as signed in. UNVERIFIED: grok isn't installed here.
 */
export async function checkGrok(apiKey = Boolean(process.env.XAI_API_KEY)): Promise<ProviderHealth> {
  const cli = resolveCli("grok");
  if (!cli) return { kind: "grok", installed: false, auth: "unknown", usable: false, hint: "Install Grok Build CLI: https://x.ai/cli" };
  const v = await runCli(cli, ["--version"]);
  const version = firstLine(v.stdout);
  if (apiKey) return { kind: "grok", installed: true, version, auth: "authenticated", authDetail: "xAI API key", usable: true };
  let out = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    // An expired token prints the logged-out line once, then refreshes; T3 probes twice.
    const s = await runCli(cli, ["models"], 20_000);
    out = s.stdout + s.stderr;
    if (!/not authenticated|not logged in/i.test(out)) break;
  }
  if (/you are logged in/i.test(out)) return { kind: "grok", installed: true, version, auth: "authenticated", authDetail: "Grok account", usable: true };
  if (/not authenticated|not logged in/i.test(out)) return { kind: "grok", installed: true, version, auth: "unauthenticated", usable: false, hint: "Sign in: `grok login`." };
  return { kind: "grok", installed: true, version, auth: "unknown", usable: true, hint: "Couldn't read `grok models`; it may still work." };
}

/**
 * Cursor Agent CLI (`cursor-agent`; its login command is `cursor-agent login`, T3's docs
 * call it `agent login`). Status from `cursor-agent status`. Shown on the Providers page
 * so users can sign in, but there's no chat adapter: T3 Code drives Cursor through the
 * `@cursor/sdk` package, not the CLI. UNVERIFIED: cursor-agent isn't installed here.
 */
export async function checkCursor(): Promise<ProviderHealth> {
  const cli = resolveCli("cursor-agent") ?? resolveCli("agent");
  if (!cli) return { kind: "cursor", installed: false, auth: "unknown", usable: false, hint: "Install Cursor CLI: https://cursor.com/cli" };
  const v = await runCli(cli, ["--version"]);
  const version = firstLine(v.stdout);
  const s = await runCli(cli, ["status"], 20_000);
  const out = (s.stdout + s.stderr).replace(/\x1b\[[0-9;]*m/g, "");
  const chatHint = "Chat with Cursor isn't supported yet (status and sign-in only).";
  if (/not logged in|not authenticated/i.test(out)) return { kind: "cursor", installed: true, version, auth: "unauthenticated", usable: false, hint: "Sign in: `cursor-agent login`." };
  if (/logged in/i.test(out)) return { kind: "cursor", installed: true, version, auth: "authenticated", authDetail: "Cursor account", usable: false, hint: chatHint };
  return { kind: "cursor", installed: true, version, auth: "unknown", usable: false, hint: chatHint };
}

/** Which API keys are configured. The Electron app passes what it has stored; otherwise env. */
export type ApiKeyPresence = Partial<Record<ApiKeyKind, boolean>>;

export function geminiApiKeyFromEnv(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

function apiKeyHealth(kind: ApiKeyKind, has: boolean): ProviderHealth {
  return {
    kind,
    installed: true,
    auth: has ? "authenticated" : "unauthenticated",
    authDetail: has ? "API key" : undefined,
    usable: has,
    hint: has ? undefined : "Add an API key on the Providers page.",
  };
}

export async function checkAnthropicApi(has = Boolean(process.env.ANTHROPIC_API_KEY)): Promise<ProviderHealth> {
  return apiKeyHealth("anthropic-api", has);
}

export async function checkOpenAiApi(has = Boolean(process.env.OPENAI_API_KEY)): Promise<ProviderHealth> {
  return apiKeyHealth("openai-api", has);
}

export async function checkGeminiApi(has = Boolean(geminiApiKeyFromEnv())): Promise<ProviderHealth> {
  return apiKeyHealth("gemini-api", has);
}

export const CHECKS: Record<ProviderKind, (keys?: ApiKeyPresence & { xai?: boolean }) => Promise<ProviderHealth>> = {
  claude: () => checkClaude(),
  codex: () => checkCodex(),
  opencode: () => checkOpenCode(),
  gemini: () => checkGemini(),
  grok: (k) => checkGrok(k?.xai),
  cursor: () => checkCursor(),
  "anthropic-api": (k) => checkAnthropicApi(k?.["anthropic-api"]),
  "openai-api": (k) => checkOpenAiApi(k?.["openai-api"]),
  "gemini-api": (k) => checkGeminiApi(k?.["gemini-api"]),
};

/** One provider's health; never throws (a broken CLI reports "unknown"). */
export async function checkProvider(kind: ProviderKind, keys?: ApiKeyPresence & { xai?: boolean }): Promise<ProviderHealth> {
  try {
    return await CHECKS[kind](keys);
  } catch (error) {
    return { kind, installed: false, auth: "unknown", usable: false, hint: `Status check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function checkAllProviders(keys?: ApiKeyPresence & { xai?: boolean }): Promise<ProviderHealth[]> {
  return Promise.all((Object.keys(CHECKS) as ProviderKind[]).map((kind) => checkProvider(kind, keys)));
}

/**
 * Preference order when the user hasn't picked one. Subscription logins first
 * (Claude Code is the main provider); API keys only as a last resort.
 */
export const DEFAULT_PROVIDER_ORDER: ProviderKind[] = ["claude", "codex", "opencode", "gemini", "grok", "gemini-api", "anthropic-api", "openai-api"];

export function pickDefaultProvider(health: ProviderHealth[], order = DEFAULT_PROVIDER_ORDER): ProviderKind | null {
  for (const kind of order) if (health.find((h) => h.kind === kind)?.usable) return kind;
  return null;
}
