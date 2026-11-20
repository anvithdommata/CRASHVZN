import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onJsonLines, resolveCli, runCli, spawnCli } from "../../../packages/assistant/src/providers/resolve-cli";
import { prepareFrameSheets, strictSchema, type VisionPart } from "./vision-frames";

// Kept exported from here for existing callers (tests/codex-vision.test.ts).
export { footageDuration, samplePlan, strictSchema, type VisionPart } from "./vision-frames";

export const VISION_MODEL = "gpt-6.1-terra";

/**
 * Video processing through the Codex CLI on the user's ChatGPT login (no API key).
 * The preflight accepts only a ChatGPT login: `codex login status` must say "Logged in using ChatGPT".
 */
export async function visionPreflight(): Promise<{ ok: true; available: string[] } | { ok: false; error: string }> {
  const cli = resolveCli("codex");
  if (!cli) return { ok: false, error: "Install Codex CLI and sign in with `codex login`." };
  const status = await runCli(cli, ["login", "status"]);
  if (status.code !== 0 || !/logged in using ChatGPT/i.test(status.stdout + status.stderr)) {
    return { ok: false, error: "Sign in with your ChatGPT subscription using `codex login`. Reconstruction requires ChatGPT auth." };
  }
  return { ok: true, available: [VISION_MODEL] };
}

/**
 * One structured request: renders `parts` into frame sheets (vision-frames.ts), then runs
 * `codex exec` read-only with every tool disabled, the skill as developer instructions and
 * `--output-schema` set to `schema`. API-key environment variables are removed so the run bills
 * the ChatGPT login. Times out after 10 minutes. Returns the parsed JSON answer and token usage.
 */
export async function generateVision(parts: VisionPart[], schema: unknown, systemPrompt: string, onStatus?: (detail: string) => void) {
  const cli = resolveCli("codex");
  if (!cli) throw new Error("Codex CLI isn't installed. Install it and run `codex login`.");
  const dir = await mkdtemp(join(tmpdir(), "crashvzn-vision-"));
  try {
    const { images, prompt } = await prepareFrameSheets(parts, dir, VISION_MODEL, onStatus);
    const schemaPath = join(dir, "schema.json");
    const outputPath = join(dir, "answer.json");
    await writeFile(schemaPath, JSON.stringify(strictSchema(schema)));
    const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "-s", "read-only",
      "-m", VISION_MODEL, "-c", 'model_reasoning_effort="xhigh"', "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
      "-c", `developer_instructions=${JSON.stringify(systemPrompt)}`,
      ...["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "image_generation", "multi_agent", "in_app_browser"].flatMap((feature) => ["--disable", feature]),
      "--output-schema", schemaPath, "-o", outputPath, ...images.flatMap((path) => ["-i", path]), "-"];
    // Keep the CLI's stored ChatGPT login; never inherit an API-key billing path.
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_ACCESS_TOKEN;
    delete env.CODEX_API_KEY;
    onStatus?.(`${VISION_MODEL} is reading ${images.length} frame sheets through your ChatGPT login (xhigh effort)…`);
    let usage: unknown;
    await new Promise<void>((resolve, reject) => {
      const child = spawnCli(cli, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      let failure = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 600_000);
      const heartbeat = setInterval(() => onStatus?.(`${VISION_MODEL} is still processing the frame sheets (xhigh effort)…`), 20_000);
      child.stderr!.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      onJsonLines(child, (event) => {
        if (event.type === "turn.completed") usage = event.usage;
        if (event.type === "turn.failed" || event.type === "error") failure = event.error?.message ?? event.message ?? "Codex failed.";
      });
      const cleanup = () => { clearTimeout(timer); clearInterval(heartbeat); };
      child.on("error", (error) => { cleanup(); reject(error); });
      child.on("close", (code) => {
        cleanup();
        if (timedOut) reject(new Error("Codex vision timed out after 10 minutes. Try a shorter clip."));
        else if (code !== 0 || failure) reject(new Error(failure || `Codex exited (${code}): ${stderr.slice(-1500)}`));
        else resolve();
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt.join("\n\n"));
    });
    return { json: JSON.parse(await readFile(outputPath, "utf8")) as unknown, usage: { model: VISION_MODEL, auth: "chatgpt", usage } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
