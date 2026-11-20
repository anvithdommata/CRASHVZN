import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SERVER_NAME } from "../mcp/server";
import { TOOLS } from "../tools/registry";
import { EventQueue } from "./queue";
import { onJsonLines, resolveCli, spawnCli } from "./resolve-cli";
import type { AdapterOptions, AssistantEvent, ProviderAdapter } from "./types";

/**
 * Gemini CLI adapter: one `gemini -p ... --output-format stream-json` per turn,
 * run from a temp project dir whose `.gemini/settings.json` registers our MCP
 * server and allows only its tools. The system prompt is delivered through
 * GEMINI_SYSTEM_MD, which replaces Gemini CLI's built-in prompt.
 *
 * UNVERIFIED: Gemini CLI isn't installed on the dev machine this was written
 * on. Settings keys and stream-json event names follow the Gemini CLI docs;
 * run `npm run chat -- --provider gemini` once it's installed and fix up.
 */
export class GeminiCliAdapter implements ProviderAdapter {
  readonly kind = "gemini" as const;
  /** No workspace yet, preparing one, a workspace with no turn running, or a `gemini -p` process running a turn. */
  private state:
    | { kind: "stopped" }
    | { kind: "preparing"; ready: Promise<void> }
    | { kind: "idle"; dir: string }
    | { kind: "turn"; dir: string; child: ChildProcess } = { kind: "stopped" };
  /** Completed turns; after the first, each turn resumes the latest Gemini session. */
  private turns = 0;

  constructor(private opts: AdapterOptions) {}

  async start(): Promise<void> {
    if (this.state.kind === "idle" || this.state.kind === "turn") return;
    if (this.state.kind === "preparing") return this.state.ready;
    const ready = this.prepare().then(
      (dir) => {
        this.state = { kind: "idle", dir };
      },
      (error) => {
        this.state = { kind: "stopped" };
        throw error;
      },
    );
    this.state = { kind: "preparing", ready };
    return ready;
  }

  /** A temp project dir whose .gemini/settings.json allows only our MCP tools. */
  private async prepare(): Promise<string> {
    if (!resolveCli("gemini")) throw new Error("Gemini CLI isn't installed (no `gemini` on PATH).");
    const dir = await mkdtemp(join(tmpdir(), "crashvzn-gemini-"));
    await mkdir(join(dir, ".gemini"));
    const settings = {
      mcpServers: {
        [MCP_SERVER_NAME]: {
          httpUrl: this.opts.mcp.url,
          headers: { Authorization: `Bearer ${this.opts.mcp.token}` },
          trust: true,
          includeTools: TOOLS.map((t) => t.name),
        },
      },
      tools: { core: [] as string[] }, // no built-in shell/file/web tools
      mcp: { allowed: [MCP_SERVER_NAME] },
      telemetry: { enabled: false },
    };
    await writeFile(join(dir, ".gemini", "settings.json"), JSON.stringify(settings, null, 2), { mode: 0o600 });
    await writeFile(join(dir, "system.md"), this.opts.systemPrompt);
    return dir;
  }

  async *send(message: string): AsyncIterable<AssistantEvent> {
    await this.start();
    if (this.state.kind === "turn") throw new Error("A turn is already running; wait for it or interrupt().");
    if (this.state.kind !== "idle") throw new Error("Gemini adapter was stopped.");
    const { dir } = this.state;
    const cli = resolveCli("gemini")!;
    const q = new EventQueue<AssistantEvent>();
    const args = ["-p", message, "--output-format", "stream-json", "--approval-mode", "yolo"];
    if (this.turns > 0) args.push("--resume", "latest");
    if (this.opts.model) args.push("-m", this.opts.model);

    // Use the user's Google login, not an API key that happens to be in the environment.
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.env, GEMINI_SYSTEM_MD: join(dir, "system.md") };
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;
    const child = spawnCli(cli, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], env });
    this.state = { kind: "turn", dir, child };
    let stderr = "";
    let ended = false;
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));

    onJsonLines(child, (ev) => {
      switch (ev.type) {
        case "message":
          if (ev.role === "assistant" && ev.content) q.push({ type: "text", delta: String(ev.content) });
          break;
        case "tool_use":
          q.push({ type: "tool_call", id: ev.tool_id, name: String(ev.tool_name).replace(/^.*__/, ""), input: ev.parameters });
          break;
        case "tool_result":
          q.push({ type: "tool_result", id: ev.tool_id, ok: ev.status !== "error", output: String(ev.output ?? ev.error?.message ?? "") });
          break;
        case "error":
          q.push({ type: "error", message: String(ev.message ?? "Gemini reported an error.") });
          ended = true;
          break;
        case "result":
          if (ev.status === "error") q.push({ type: "error", message: String(ev.error?.message ?? "Gemini reported an error.") });
          else q.push({ type: "done", durationMs: ev.stats?.duration_ms });
          ended = true;
          break;
      }
    });

    child.on("error", (err) => {
      q.push({ type: "error", message: `Couldn't start Gemini CLI: ${err.message}` });
      q.close();
    });
    child.on("close", (code) => {
      if (this.state.kind === "turn" && this.state.child === child) this.state = { kind: "idle", dir };
      this.turns++;
      if (!ended) {
        q.push(code === 0 ? { type: "done" } : { type: "error", message: `Gemini CLI exited (code ${code}). ${stderr.trim().split("\n").slice(-3).join(" ")}`.trim() });
      }
      q.close();
    });

    yield* q;
  }

  async interrupt(): Promise<void> {
    if (this.state.kind === "turn") this.state.child.kill();
  }

  async stop(): Promise<void> {
    if (this.state.kind === "preparing") await this.state.ready.catch(() => {});
    const state = this.state;
    this.state = { kind: "stopped" };
    if (state.kind === "turn") state.child.kill();
    if (state.kind === "idle" || state.kind === "turn") await rm(state.dir, { recursive: true, force: true }).catch(() => {});
  }
}
