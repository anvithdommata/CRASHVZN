import { MCP_SERVER_NAME } from "../mcp/server";
import { AcpAdapter, type AcpToolCall } from "./acp";
import { resolveCli } from "./resolve-cli";
import type { AdapterOptions } from "./types";

/** Our tool name from an ACP tool call title such as "crashvzn/scene_describe" or "mcp__crashvzn__scene_describe". */
function ourTool(call: AcpToolCall): string | null {
  const title = String(call.title ?? "");
  const m = new RegExp(`(?:^|\\b|_)${MCP_SERVER_NAME}(?:__|[./:_])(\\w+)`).exec(title);
  return m ? m[1]! : null;
}

/**
 * Grok Build CLI adapter over ACP: `grok --permission-mode default agent stdio`, the
 * launch T3 Code uses for its "Supervised" mode (packages/provider-grok/src/server/acpSupport.ts).
 * In that mode Grok asks before running tools; we approve only our MCP tools.
 * Our MCP server comes in through ACP session/new. Grok has no system-prompt flag we
 * know of, so the prompt goes in front of the first message.
 * A stored or environment XAI_API_KEY is passed through, as T3 does.
 *
 * UNVERIFIED: the Grok CLI isn't installed on the dev machine. Tool titles and whether
 * Grok asks permission for its read-only built-ins are unknown; check with
 * `npm run chat -- --provider grok` once it's installed.
 */
export class GrokCliAdapter extends AcpAdapter {
  constructor(opts: AdapterOptions) {
    super("grok", opts, {
      label: "Grok",
      inlineSystemPrompt: true,
      toolName: ourTool,
      allowTool: (call) => ourTool(call) !== null && (!call.kind || call.kind === "other"),
      launch: async () => {
        const cli = resolveCli("grok");
        if (!cli) throw new Error("Grok CLI isn't installed (no `grok` on PATH).");
        return { cli, args: ["--permission-mode", "default", "agent", "stdio"], env: { ...process.env, ...opts.env } };
      },
    });
  }
}
