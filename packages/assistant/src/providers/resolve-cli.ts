import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * Finds a CLI on PATH and returns something we can spawn *without a shell*.
 *
 * On Windows, npm installs CLIs as `.cmd` shims, and Node refuses to spawn
 * those without `shell: true` — which would mangle our multi-line prompt
 * arguments. So for npm shims we read the shim, find the JS entry point, and
 * run it with node directly.
 */
export interface ResolvedCli {
  command: string;
  /** Args to prepend (e.g. the JS entry for npm shims). */
  prefixArgs: string[];
  /** The file we found on PATH, for display. */
  path: string;
}

const cache = new Map<string, ResolvedCli | null>();

export function resolveCli(name: string): ResolvedCli | null {
  if (cache.has(name)) return cache.get(name)!;
  const found = findOnPath(name);
  cache.set(name, found);
  return found;
}

/** Forget cached lookups, so a CLI installed while the app runs is found on Re-check. */
export function clearCliCache(): void {
  cache.clear();
}

function findOnPath(name: string): ResolvedCli | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const isWin = process.platform === "win32";
  const exts = isWin ? [".exe", ".cmd", ".bat", ""] : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (!existsSync(p)) continue;
      if (isWin && (ext === ".cmd" || ext === ".bat")) {
        const shim = readNpmShim(p);
        if (shim) return shim;
        continue; // a non-npm .cmd we can't run safely without a shell
      }
      if (isWin && ext === "") continue; // extensionless files on Windows are sh scripts for Git Bash
      return { command: p, prefixArgs: [], path: p };
    }
  }
  return null;
}

/** Parses an npm `.cmd` shim: `"%_prog%" "%dp0%\node_modules\pkg\bin\cli.js" %*` */
function readNpmShim(cmdPath: string): ResolvedCli | null {
  let text: string;
  try {
    text = readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(cmdPath);
  // Some npm packages ship a native binary and the shim runs it directly (OpenCode 2:
  // `"%dp0%\node_modules\@opencode\cli\bin\opencode.exe" %*`). Spawn that .exe as is.
  // Skip the `"%dp0%\node.exe"` interpreter check that JS shims start with.
  const exe = text.match(/"%dp0%\\?\\((?!node\.exe")[^"]+\.exe)"/i);
  if (exe && !/"%dp0%\\[^"]+\.(?:js|cjs|mjs)"/i.test(text)) {
    const bin = join(dir, exe[1]!);
    return existsSync(bin) ? { command: bin, prefixArgs: [], path: cmdPath } : null;
  }
  const m = text.match(/"%dp0%\\([^"]+\.(?:js|cjs|mjs))"/i);
  if (!m) return null;
  const script = join(dir, m[1]!);
  if (!existsSync(script)) return null;
  const localNode = join(dir, "node.exe");
  return { command: existsSync(localNode) ? localNode : "node", prefixArgs: [script], path: cmdPath };
}

export function spawnCli(cli: ResolvedCli, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cli.command, [...cli.prefixArgs, ...args], { windowsHide: true, ...opts, shell: false });
}

/** Run a CLI to completion and collect output. Used for version/auth checks. */
export function runCli(
  cli: ResolvedCli,
  args: string[],
  timeoutMs = 10_000,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(cli, args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Splits a child's stdout into lines and parses each as JSON; non-JSON lines go to onText. */
export function onJsonLines(child: ChildProcess, onJson: (obj: any) => void, onText?: (line: string) => void): void {
  let buf = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        onJson(JSON.parse(line));
      } catch {
        onText?.(line);
      }
    }
  });
}
