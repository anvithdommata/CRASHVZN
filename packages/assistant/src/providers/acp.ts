import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_SERVER_NAME } from "../mcp/server";
import { TurnSlot } from "./queue";
import { onJsonLines, spawnCli, type ResolvedCli } from "./resolve-cli";
import type { AdapterOptions, AssistantEvent, ProviderAdapter, ProviderKind } from "./types";

/**
 * Agent Client Protocol (https://agentclientprotocol.com) client: one long-lived
 * `<agent> acp` process speaking JSON-RPC 2.0 over stdio, one session per adapter.
 * T3 Code drives OpenCode, Grok and Kiro the same way (packages/provider-acp*).
 *
 * Our MCP server is handed to the agent per session in `session/new`. We advertise no
 * client file-system or terminal capabilities, and every `session/request_permission`
 * the agent sends is rejected unless `allowTool` says it's one of our MCP tools. Each
 * concrete adapter also locks the agent's own built-in tools down in its config.
 */
export interface AcpLaunch {
  cli: ResolvedCli;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface AcpHooks {
  label: string;
  /** Writes any config into the session's temp dir and returns how to start the agent. */
  launch(dir: string): Promise<AcpLaunch>;
  /** Prepend the system prompt to the first message (agents with no system-prompt setting). */
  inlineSystemPrompt?: boolean;
  /** Our tool name for a tool call, or null if it isn't one of ours. */
  toolName(call: AcpToolCall): string | null;
  /** Answer to session/request_permission. Default: allow only calls toolName() recognises. */
  allowTool?(call: AcpToolCall): boolean;
}

/** The parts of an ACP ToolCall / ToolCallUpdate we use. */
export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: any;
  rawOutput?: any;
  content?: any[];
  [key: string]: unknown;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
type AcpProcess = { child: ChildProcess; dir: string };

export class AcpAdapter implements ProviderAdapter {
  /**
   * The agent process: not running; booting (spawned once `proc` is set, still negotiating the
   * session); or ready with an ACP session.
   */
  private state:
    | { kind: "stopped" }
    | { kind: "booting"; ready: Promise<void>; proc: AcpProcess | null }
    | { kind: "ready"; proc: AcpProcess; sessionId: string } = { kind: "stopped" };
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private turn = new TurnSlot<AssistantEvent>();
  private calls = new Map<string, { name: string | null; announced: boolean }>();
  private turns = 0;

  get sessionId(): string | null {
    return this.state.kind === "ready" ? this.state.sessionId : null;
  }

  /** The spawned process while booting or ready. */
  private get proc(): AcpProcess | null {
    return this.state.kind === "stopped" ? null : this.state.proc;
  }

  constructor(
    readonly kind: ProviderKind,
    private opts: AdapterOptions,
    private hooks: AcpHooks,
  ) {}

  start(): Promise<void> {
    if (this.state.kind === "ready") return Promise.resolve();
    if (this.state.kind === "booting") return this.state.ready;
    const booting: { kind: "booting"; ready: Promise<void>; proc: AcpProcess | null } = { kind: "booting", ready: Promise.resolve(), proc: null };
    booting.ready = this.boot(booting).catch(async (error) => {
      if (this.state === booting) await this.shutdown();
      throw error;
    });
    this.state = booting;
    return booting.ready;
  }

  private async boot(booting: { kind: "booting"; proc: AcpProcess | null }) {
    const dir = await mkdtemp(join(tmpdir(), `crashvzn-${this.kind}-`));
    const { cli, args, env } = await this.hooks.launch(dir);
    const child = spawnCli(cli, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    const proc: AcpProcess = { child, dir };
    booting.proc = proc;
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    child.stdin!.on("error", () => {});
    onJsonLines(child, (msg) => this.onMessage(msg));
    const died = (why: string) => {
      if (this.proc === proc) this.state = { kind: "stopped" };
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
      this.turn.end({ type: "error", message: why });
    };
    child.on("error", (err) => died(`Couldn't start ${this.hooks.label}: ${err.message}`));
    child.on("exit", (code) => died(`${this.hooks.label} exited (code ${code}). ${stderr.trim().split("\n").slice(-3).join(" ")}`.trim()));

    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "crashvzn", version: "0.1.0" },
    }, 60_000);
    const session = await this.request("session/new", {
      cwd: dir,
      mcpServers: [
        { type: "http", name: MCP_SERVER_NAME, url: this.opts.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${this.opts.mcp.token}` }] },
      ],
    }, 120_000);
    const sessionId = String(session.sessionId);
    if (this.opts.model) {
      const options: any[] = session.configOptions ?? [];
      const model = options.find((o) => o.id === "model" || o.category === "model");
      try {
        if (model) await this.request("session/set_config_option", { sessionId, configId: model.id, value: this.opts.model });
        else await this.request("session/set_model", { sessionId, modelId: this.opts.model });
      } catch (error) {
        throw new Error(`${this.hooks.label} doesn't offer the model "${this.opts.model}" (${error instanceof Error ? error.message : String(error)}).`);
      }
    }
    // Ready only if nothing stopped or replaced this boot meanwhile.
    if (this.state === booting) this.state = { kind: "ready", proc, sessionId };
  }

  async *send(message: string): AsyncIterable<AssistantEvent> {
    await this.start();
    const q = this.turn.begin();
    const started = Date.now();
    const text = this.turns++ === 0 && this.hooks.inlineSystemPrompt ? `<instructions>\n${this.opts.systemPrompt}\n</instructions>\n\n${message}` : message;
    this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, 600_000).then(
      (result) => {
        if (q.isClosed) return;
        if (result?.stopReason === "refusal") q.push({ type: "error", message: "The model declined this request." });
        else q.push({ type: "done", sessionId: this.sessionId ?? undefined, durationMs: Date.now() - started });
        q.close();
      },
      (error: Error) => {
        if (q.isClosed) return;
        q.push({ type: "error", message: error.message });
        q.close();
      },
    );
    yield* q;
  }

  async interrupt(): Promise<void> {
    if (this.sessionId && this.turn.active) this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
  }

  async stop(): Promise<void> {
    this.turn.end({ type: "error", message: "Stopped." });
    if (this.state.kind === "booting") await this.state.ready.catch(() => {});
    await this.shutdown();
  }

  /** Kills the process (if any), deletes its temp dir and returns to stopped. */
  private async shutdown(): Promise<void> {
    const proc = this.proc;
    this.state = { kind: "stopped" };
    if (!proc) return;
    proc.child.kill();
    await rm(proc.dir, { recursive: true, force: true }).catch(() => {});
  }

  private write(obj: unknown) {
    this.proc?.child.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (!this.proc) return Promise.reject(new Error(`${this.hooks.label} isn't running.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.hooks.label} didn't answer ${method} in time.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }


  private onMessage(msg: any) {
    // Response to one of our requests.
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? "ACP error") + (msg.error.data ? ` ${JSON.stringify(msg.error.data).slice(0, 300)}` : "")));
      else p.resolve(msg.result);
      return;
    }
    // Requests from the agent: permissions are vetted, everything else is refused.
    if (msg.id !== undefined && msg.method) {
      if (msg.method === "session/request_permission") {
        const call: AcpToolCall = msg.params?.toolCall ?? {};
        const allow = this.hooks.allowTool ? this.hooks.allowTool(call) : this.hooks.toolName(call) !== null;
        const options: { optionId: string; kind: string }[] = msg.params?.options ?? [];
        const pick = options.find((o) => o.kind === (allow ? "allow_once" : "reject_once")) ?? options.find((o) => o.kind.startsWith(allow ? "allow" : "reject"));
        this.write({ jsonrpc: "2.0", id: msg.id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
      } else {
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `${msg.method} isn't available in this app.` } });
      }
      return;
    }
    if (msg.method !== "session/update") return;
    const q = this.turn.active;
    const u = msg.params?.update;
    if (!q || !u) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text" && u.content.text) q.push({ type: "text", delta: String(u.content.text) });
        break;
      case "tool_call":
      case "tool_call_update": {
        const id = String(u.toolCallId);
        const seen = this.calls.get(id) ?? { name: null, announced: false };
        this.calls.set(id, seen);
        // Input often arrives in a later update than the first tool_call.
        if (!seen.announced && (u.rawInput && Object.keys(u.rawInput).length)) {
          seen.name = this.hooks.toolName(u);
          seen.announced = true;
          q.push({ type: "tool_call", id, name: seen.name ?? String(u.title ?? u.kind ?? "tool"), input: u.rawInput });
        }
        if (u.status === "completed" || u.status === "failed") {
          if (!seen.announced) {
            seen.announced = true;
            q.push({ type: "tool_call", id, name: seen.name ?? String(u.title ?? "tool"), input: u.rawInput ?? {} });
          }
          const output = (u.content ?? [])
            .map((c: any) => (c?.content?.type === "text" ? c.content.text : c?.type === "text" ? c.text : ""))
            .join("") || (u.rawOutput ? JSON.stringify(u.rawOutput) : "");
          q.push({ type: "tool_result", id, name: seen.name ?? undefined, ok: u.status === "completed", output: String(output).slice(0, 4000) });
        }
        break;
      }
    }
  }
}
