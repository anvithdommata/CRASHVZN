import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { SceneController } from "../controller";
import { callTool, TOOLS } from "../tools/registry";

export const MCP_SERVER_NAME = "crashvzn";

export interface RunningMcpServer {
  /** e.g. http://127.0.0.1:53121/mcp */
  url: string;
  /** Per-session bearer token. Pass it to the CLI; never log it. */
  token: string;
  close(): Promise<void>;
}

export interface McpServerOptions {
  controller: SceneController;
  /** 0 (default) = pick a free port. */
  port?: number;
  /** Called after each tool call, e.g. to show "camera_orbit ✓" in the chat UI. */
  onToolCall?: (name: string, args: unknown, ok: boolean) => void;
}

function buildMcpServer(opts: McpServerOptions): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: { readOnlyHint: def.readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args: unknown) => {
        const res = await callTool(opts.controller, def.name, args);
        opts.onToolCall?.(def.name, args, res.ok);
        return res.ok
          ? { content: [{ type: "text" as const, text: JSON.stringify(res.result) }] }
          : { content: [{ type: "text" as const, text: res.error }], isError: true };
      },
    );
  }
  return server;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Starts the MCP server on 127.0.0.1 (streamable HTTP, stateless) with a fresh
 * bearer token. Meant to run inside the Electron main process.
 */
export async function startMcpServer(opts: McpServerOptions): Promise<RunningMcpServer> {
  const token = randomBytes(24).toString("base64url");

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    if (!tokenMatches(req.headers.authorization, token)) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST") {
      // Stateless mode: no server-initiated SSE stream, no sessions to delete.
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    // Stateless: one server + transport per request, so concurrent CLIs never share state.
    const server = buildMcpServer(opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, await readJson(req));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null }),
        );
      }
    }
  };

  const http: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  const { port } = http.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
