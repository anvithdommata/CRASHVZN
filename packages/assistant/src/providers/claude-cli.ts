import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SERVER_NAME } from "../mcp/server";
import { TurnSlot } from "./queue";
import { onJsonLines, resolveCli, spawnCli } from "./resolve-cli";
import type { AdapterOptions, AssistantEvent, ProviderAdapter } from "./types";

const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * Claude Code adapter: one long-lived `claude -p` process speaking stream-json
 * on stdin/stdout, so the session (and its prompt cache) stays warm between
 * voice commands.
 *
 * Lock-down (verified with Claude Code 2.1.x):
 *   --tools ""                 no built-in tools (no Bash/Read/Edit/Web*)
 *   --strict-mcp-config        ignore the user's own MCP servers
 *   --allowedTools mcp__crashvzn   our tools run without permission prompts
 *   --permission-mode dontAsk  anything else is denied, never prompted
 *   --setting-sources ""       ignore user/project settings, hooks, CLAUDE.md
 *   --system-prompt-file       replace the coding-agent prompt with ours
 *   cwd = empty temp dir
 */
export class ClaudeCliAdapter implements ProviderAdapter {
  readonly kind = "claude" as const;
  /** The long-lived `claude -p` process: not started, starting, or running in its temp dir. */
  private state: { kind: "stopped" } | { kind: "starting"; ready: Promise<void> } | { kind: "running"; child: ChildProcess; dir: string } = {
    kind: "stopped",
  };
  private turn = new TurnSlot<AssistantEvent>();
  private toolNames = new Map<string, string>();
  sessionId: string | null = null;

  constructor(private opts: AdapterOptions) {}

  async start(): Promise<void> {
    if (this.state.kind === "running") return;
    if (this.state.kind === "starting") return this.state.ready;
    // Concurrent callers share one launch.
    const ready = this.launch().catch((error) => {
      this.state = { kind: "stopped" };
      throw error;
    });
    this.state = { kind: "starting", ready };
    return ready;
  }

  private async launch(): Promise<void> {
    const cli = resolveCli("claude");
    if (!cli) throw new Error("Claude Code isn't installed (no `claude` on PATH).");

    const dir = await mkdtemp(join(tmpdir(), "crashvzn-claude-"));
    const mcpConfig = join(dir, "mcp.json");
    const promptFile = join(dir, "system-prompt.md");
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: { type: "http", url: this.opts.mcp.url, headers: { Authorization: `Bearer ${this.opts.mcp.token}` } },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(promptFile, this.opts.systemPrompt);

    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      "--tools", "",
      "--allowedTools", `mcp__${MCP_SERVER_NAME}`,
      "--permission-mode", "dontAsk",
      "--setting-sources", "",
      "--system-prompt-file", promptFile,
      "--session-id", randomUUID(),
    ];
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.effort) args.push("--effort", this.opts.effort);

    // Claude Code prefers an API key over the user's claude.ai login when one is in
    // the environment. Strip it so the CLI path always bills the user's subscription.
    const env = { ...process.env, ...this.opts.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    const child = spawnCli(cli, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env });
    this.state = { kind: "running", child, dir };
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    onJsonLines(child, (msg) => this.onMessage(msg));
    child.on("error", (err) => this.turn.end({ type: "error", message: `Couldn't start Claude Code: ${err.message}` }));
    child.on("exit", (code) => {
      // Only the current process may reset the state (stop() may already have replaced it).
      if (this.state.kind === "running" && this.state.child === child) {
        this.state = { kind: "stopped" };
        void rm(dir, { recursive: true, force: true }).catch(() => {});
      }
      this.turn.end({ type: "error", message: `Claude Code exited (code ${code}). ${stderr.trim().split("\n").slice(-3).join(" ")}`.trim() });
    });
  }

  async *send(message: string): AsyncIterable<AssistantEvent> {
    await this.start();
    const q = this.turn.begin();
    this.write({ type: "user", message: { role: "user", content: [{ type: "text", text: message }] } });
    yield* q;
  }

  async interrupt(): Promise<void> {
    if (this.state.kind !== "running" || !this.turn.active) return;
    this.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
  }

  async stop(): Promise<void> {
    this.turn.end({ type: "error", message: "Stopped." });
    if (this.state.kind === "starting") await this.state.ready.catch(() => {});
    const state = this.state;
    this.state = { kind: "stopped" };
    if (state.kind !== "running") return;
    state.child.kill();
    await rm(state.dir, { recursive: true, force: true }).catch(() => {});
  }

  private write(obj: unknown) {
    if (this.state.kind === "running") this.state.child.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private onMessage(msg: any) {
    if (msg.session_id) this.sessionId = msg.session_id;
    const q = this.turn.active;
    if (!q) return;

    switch (msg.type) {
      case "stream_event": {
        const ev = msg.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && !msg.parent_tool_use_id) {
          q.push({ type: "text", delta: ev.delta.text });
        }
        break;
      }
      case "assistant": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_use") {
            const name = String(block.name).replace(TOOL_PREFIX, "");
            this.toolNames.set(block.id, name);
            q.push({ type: "tool_call", id: block.id, name, input: block.input });
          }
        }
        break;
      }
      case "user": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_result") {
            const output = Array.isArray(block.content)
              ? block.content.map((c: any) => (c.type === "text" ? c.text : "")).join("")
              : String(block.content ?? "");
            q.push({ type: "tool_result", id: block.tool_use_id, name: this.toolNames.get(block.tool_use_id), ok: !block.is_error, output });
          }
        }
        break;
      }
      case "result": {
        if (msg.is_error && msg.subtype !== "error_during_execution") {
          q.push({ type: "error", message: String(msg.result ?? msg.subtype ?? "Claude Code reported an error.") });
        } else {
          q.push({ type: "done", sessionId: msg.session_id, durationMs: msg.duration_ms, costUsd: msg.total_cost_usd });
        }
        q.close();
        break;
      }
    }
  }
}
