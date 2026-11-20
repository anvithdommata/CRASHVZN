import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveCli, runCli, spawnCli } from "../../../packages/assistant/src/providers/resolve-cli";
import { prepareFrameSheets, strictSchema, type VisionPart } from "./vision-frames";

export const CLAUDE_VISION_DEFAULT_MODEL = "claude-opus-5-5";
export const CLAUDE_VISION_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const EFFORT = "high";

/**
 * Video processing through Claude Code on the user's Claude subscription login
 * (`claude auth login`), the same contract as codex-vision.ts.
 *
 * One non-interactive `claude -p` per request:
 *   --output-format json --json-schema   structured output, parsed from `structured_output`
 *   --tools Read --allowedTools Read     the only tool: reading the frame sheets
 *   --permission-mode dontAsk            anything else is denied, never prompted
 *   --add-dir <temp dir>, cwd = temp dir the sheets live there and nowhere else
 *   --strict-mcp-config, --setting-sources "", --disable-slash-commands
 *                                        no user MCP servers, settings, hooks, CLAUDE.md, skills
 *   --system-prompt-file                 the reconstruction skill replaces the coding prompt
 *   --no-session-persistence             nothing saved to ~/.claude/projects
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from the child's env so it bills
 * the subscription login, never an API key.
 */
export async function claudeVisionPreflight(model = CLAUDE_VISION_DEFAULT_MODEL): Promise<{ ok: true; available: string[] } | { ok: false; error: string }> {
  const cli = resolveCli("claude");
  if (!cli) return { ok: false, error: "Install Claude Code and sign in with `claude auth login`." };
  const status = await runCli(cli, ["auth", "status"], 15_000, childEnv());
  try {
    const j = JSON.parse(status.stdout);
    if (j.loggedIn && j.authMethod === "claude.ai") return { ok: true, available: [model] };
    if (j.loggedIn) return { ok: false, error: "Claude Code is signed in with an API/Console account. Video processing uses your Claude subscription: run `claude auth login`." };
  } catch {}
  return { ok: false, error: "Sign in to Claude Code with your Claude subscription using `claude auth login`." };
}

function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

/** Runs one structured-output request. Exported separately so it can be tested with any image. */
export async function runClaudeStructured(opts: {
  dir: string;
  images: string[];
  prompt: string;
  schema: unknown;
  systemPrompt: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  onStatus?: (detail: string) => void;
}) {
  const cli = resolveCli("claude");
  if (!cli) throw new Error("Claude Code isn't installed. Install it and run `claude auth login`.");
  const model = opts.model || CLAUDE_VISION_DEFAULT_MODEL;
  const systemFile = join(opts.dir, "system-prompt.md");
  await writeFile(systemFile, opts.systemPrompt);
  const list = opts.images.map((path, i) => `Image ${i + 1} is the file ${basename(path)}.`).join("\n");
  const prompt = `${opts.prompt}\n\n${list}\nRead every image file listed above with the Read tool before answering. Answer only with the structured output.`;
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(strictSchema(opts.schema)),
    "--tools", "Read",
    "--allowedTools", "Read",
    "--permission-mode", "dontAsk",
    "--add-dir", opts.dir,
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt-file", systemFile,
    "--model", model,
    "--effort", opts.effort ?? EFFORT,
  ];
  const result = await new Promise<any>((resolve, reject) => {
    const child = spawnCli(cli, args, { cwd: opts.dir, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs ?? 600_000);
    const heartbeat = setInterval(() => opts.onStatus?.(`${model} is still processing the frame sheets (${opts.effort ?? EFFORT} effort)…`), 20_000);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const cleanup = () => { clearTimeout(timer); clearInterval(heartbeat); };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      cleanup();
      if (timedOut) return reject(new Error("Claude Code vision timed out after 10 minutes. Try a shorter clip."));
      let parsed: any;
      try {
        parsed = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "");
      } catch {
        return reject(new Error(`Claude Code exited (${code}) without a JSON result: ${(stderr || stdout).slice(-1500)}`));
      }
      if (parsed.is_error || parsed.subtype !== "success") return reject(new Error(`Claude Code failed: ${String(parsed.result ?? parsed.subtype ?? "unknown error").slice(0, 1500)}`));
      resolve(parsed);
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(prompt);
  });
  let json: unknown = result.structured_output;
  if (json === undefined && typeof result.result === "string") {
    try {
      json = JSON.parse(result.result);
    } catch {}
  }
  if (json === undefined || json === null) throw new Error("Claude Code returned no structured output.");
  return { json, usage: { model, auth: "claude-subscription", usage: { ...result.usage, num_turns: result.num_turns, duration_ms: result.duration_ms } } };
}

export async function claudeGenerateVision(parts: VisionPart[], schema: unknown, systemPrompt: string, onStatus?: (detail: string) => void, model = CLAUDE_VISION_DEFAULT_MODEL) {
  const dir = await mkdtemp(join(tmpdir(), "crashvzn-claude-vision-"));
  try {
    const { images, prompt } = await prepareFrameSheets(parts, dir, model, onStatus);
    onStatus?.(`${model} is reading ${images.length} frame sheets through your Claude subscription (${EFFORT} effort)…`);
    return await runClaudeStructured({ dir, images, prompt: prompt.join("\n\n"), schema, systemPrompt, model, onStatus });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
