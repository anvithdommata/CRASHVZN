import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MCP_SERVER_NAME } from "../mcp/server";
import { AcpAdapter, type AcpToolCall } from "./acp";
import { resolveCli, runCli } from "./resolve-cli";
import type { AdapterOptions } from "./types";

/**
 * OpenCode built-in permission actions (https://opencode.ai/docs/permissions) and its own
 * `opencode_*` tools. Rules match action names exactly: OpenCode 2.1.4 ignores globs in
 * the action field, so every action is listed by name.
 */
const DENIED_ACTIONS = [
  "read", "edit", "write", "patch", "glob", "grep", "list", "shell", "bash", "subagent", "task", "skill",
  "question", "webfetch", "websearch", "external_directory", "experimental_image_generate", "todowrite", "todoread",
  "opencode_read_mcp_resource", "opencode_models", "opencode_worktree_create", "opencode_worktree_list",
  "opencode_session_move", "opencode_session_rename",
];

/** Names of the user's own MCP servers, from `opencode mcp list` ("✓ name  connected"). */
async function userMcpServers(cli: NonNullable<ReturnType<typeof resolveCli>>, env: NodeJS.ProcessEnv): Promise<string[]> {
  const res = await runCli(cli, ["mcp", "list"], 30_000, env);
  const names = new Set<string>();
  for (const line of (res.stdout + "\n" + res.stderr).split(/\r?\n/)) {
    const m = /^\s*\S+\s+([A-Za-z0-9._-]+)\s{2,}\S/.exec(line.replace(/\x1b\[[0-9;]*m/g, ""));
    if (m && m[1] !== MCP_SERVER_NAME) names.add(m[1]!);
  }
  return [...names];
}

/** `tools.crashvzn.scene_describe(...)` / `tools.crashvzn["scene_describe"]` in a code-mode block. */
function ourToolsInCode(code: string): string[] {
  const re = new RegExp(`tools\\.${MCP_SERVER_NAME}(?:\\.(\\w+)|\\[\\s*["'](\\w+)["']\\s*\\])`, "g");
  return [...new Set([...code.matchAll(re)].map((m) => m[1] ?? m[2]!))];
}

/**
 * OpenCode adapter over ACP (`opencode acp`), verified with OpenCode 2.1.4.
 *
 * Lock-down, in a private config file (OPENCODE_CONFIG; project config, Claude Code
 * compatibility files and auto-update are switched off by env var):
 *   - every built-in action above is denied, so there's no file, shell, web or subagent tool;
 *   - the user's own MCP servers (names from `opencode mcp list`) are disabled for this run;
 *   - our server comes in through ACP session/new;
 *   - the system prompt is a primary agent, made the default agent.
 * The user's OpenCode logins (`opencode auth login`) are used as they are.
 *
 * Known gap: OpenCode 2.1.4 exposes MCP tools only through its "code mode" `execute`
 * tool (sandboxed JS: `await tools.crashvzn.scene_describe()`), and denying
 * `execute` hides MCP tools altogether. That sandbox has `fetch`, so a model could make
 * a plain web request from it. It has no file or process access.
 */
export class OpenCodeCliAdapter extends AcpAdapter {
  constructor(opts: AdapterOptions) {
    super("opencode", opts, {
      label: "OpenCode",
      toolName: (call: AcpToolCall) => {
        const code = typeof call.rawInput?.code === "string" ? call.rawInput.code : "";
        const ours = ourToolsInCode(code);
        if (ours.length) return ours.join(" + ");
        const title = String(call.title ?? "");
        return title.startsWith(`${MCP_SERVER_NAME}_`) ? title.slice(MCP_SERVER_NAME.length + 1) : null;
      },
      // Code mode is the only route to our tools; anything else that asks is refused.
      allowTool: (call) => call.title === "execute" || String(call.title ?? "").startsWith(`${MCP_SERVER_NAME}_`),
      launch: async (dir) => {
        const cli = resolveCli("opencode");
        if (!cli) throw new Error("OpenCode isn't installed (no `opencode` on PATH).");
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ...opts.env,
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
          OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
        };
        const others = await userMcpServers(cli, env).catch(() => []);
        const config = {
          $schema: "https://opencode.ai/config.json",
          default_agent: "crashvzn",
          agents: {
            crashvzn: {
              mode: "primary",
              description: "CRASHVZN in-app assistant",
              system: `${opts.systemPrompt}\n\nYour tools are the \`${MCP_SERVER_NAME}\` MCP tools, called from the execute tool as \`await tools.${MCP_SERVER_NAME}.<tool>(args)\`. If they aren't listed yet, search the \`${MCP_SERVER_NAME}\` namespace again. Never use fetch or any other network access.`,
            },
          },
          mcp: { servers: Object.fromEntries(others.map((name) => [name, { disabled: true }])) },
          permissions: DENIED_ACTIONS.map((action) => ({ action, resource: "*", effect: "deny" })),
        };
        const file = join(dir, "opencode.json");
        await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
        return { cli, args: ["acp"], env: { ...env, OPENCODE_CONFIG: file } };
      },
    });
  }
}
