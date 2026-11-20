import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearCliCache, resolveCli } from "../src/providers/resolve-cli";
import { PROVIDER_CATALOG } from "../src/providers/catalog";
import { CHECKS, DEFAULT_PROVIDER_ORDER } from "../src/providers/health";

// What npm writes for a JS CLI (Codex) and for a package that ships a native binary (OpenCode 2).
const JS_SHIM = [
  "@ECHO off",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  ")",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n");
const EXE_SHIM = ["@ECHO off", "CALL :find_dp0", '"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*'].join("\r\n");

describe.runIf(process.platform === "win32")("npm .cmd shims (Windows)", () => {
  const oldPath = process.env.PATH;
  let dir = "";
  afterEach(() => {
    process.env.PATH = oldPath;
    clearCliCache();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs JS shims through node and native shims as the .exe", () => {
    dir = mkdtempSync(join(tmpdir(), "shim-"));
    mkdirSync(join(dir, "node_modules", "@openai", "codex", "bin"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "@opencode", "cli", "bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
    writeFileSync(join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe"), "");
    writeFileSync(join(dir, "codex.cmd"), JS_SHIM);
    writeFileSync(join(dir, "opencode.cmd"), EXE_SHIM);
    process.env.PATH = dir;
    clearCliCache();
    const codex = resolveCli("codex")!;
    expect(codex.command).toBe("node");
    expect(codex.prefixArgs[0]).toMatch(/codex\.js$/);
    const opencode = resolveCli("opencode")!;
    expect(opencode.command).toMatch(/opencode\.exe$/);
    expect(opencode.prefixArgs).toEqual([]);
  });
});

describe("provider catalog", () => {
  it("has a status check for every provider and only picks chat-capable defaults", () => {
    for (const p of PROVIDER_CATALOG) expect(CHECKS[p.kind]).toBeTypeOf("function");
    for (const kind of DEFAULT_PROVIDER_ORDER) expect(PROVIDER_CATALOG.find((p) => p.kind === kind)?.chat).toBe(true);
  });
});
