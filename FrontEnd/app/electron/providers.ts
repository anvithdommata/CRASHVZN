/**
 * Main-process side of the Providers page.
 *
 *  - App settings (userData/settings.json): the active video processor and the default chat provider.
 *  - API keys (userData/provider-keys.json), encrypted with Electron safeStorage (OS keychain /
 *    DPAPI / libsecret). Keys never leave the main process: the renderer only learns "set / not set",
 *    and keys are injected into the matching adapter when a chat session starts.
 *  - Status: `--version` + each CLI's own auth-status command (packages/assistant/src/providers/health.ts).
 *  - Sign-in the way T3 Code does it: run the CLI's own login command (`codex login`,
 *    `claude auth login`, ...), which opens the browser OAuth page, or open a visible terminal running
 *    that command for CLIs whose login is interactive (OpenCode's provider picker, Gemini's first run).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { app, safeStorage, shell, type BrowserWindow, type IpcMain } from "electron";
import {
  API_KEY_KINDS,
  PROVIDER_CATALOG,
  UNSUPPORTED_PROVIDERS,
  checkAllProviders,
  checkProvider,
  clearCliCache,
  providerInfo,
  resolveCli,
  spawnCli,
  type ApiKeyKind,
  type ProviderHealth,
  type ProviderKind,
} from "../../../packages/assistant/src/index";
import { DEFAULT_PROCESSOR, PROCESSORS, processorInfo, type ProcessorChoice } from "./vision";

export type ChatDefault = { provider?: string; model?: string; effort?: string };
export type AppSettings = { processor: ProcessorChoice; chat: ChatDefault };

type LoginEvent = { kind: string; state: "running" | "url" | "done" | "error" | "cancelled"; url?: string; message?: string };

const userFile = (name: string) => join(app.getPath("userData"), name);

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/** Commands we open in a terminal come only from the provider catalog, never from the renderer. */
function terminalCommand(kind: string, purpose: "login" | "install"): string {
  const info = providerInfo(kind);
  if (!info?.cli) throw new Error("That provider has no command-line sign-in.");
  if (purpose === "install") {
    if (!info.install?.command) throw new Error(`Install ${info.label} from ${info.install?.url ?? "its website"}.`);
    return info.install.command;
  }
  return [info.cli, ...(info.login?.args ?? [])].join(" ");
}

function onPath(name: string) {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, name)));
}

/** Opens a visible terminal window running `command` (Windows cmd, macOS Terminal, or a Linux terminal). */
function openTerminal(command: string, title: string) {
  if (process.platform === "win32") {
    // `start` opens a new console window; `cmd /k` keeps it open after the command so the user sees the result.
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `start "${title}" cmd.exe /k ${command}`], {
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }
  if (process.platform === "darwin") {
    const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const child = spawn("osascript", ["-e", `tell application "Terminal" to do script "${escaped}"`, "-e", 'tell application "Terminal" to activate'], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return;
  }
  const keepOpen = `${command}; echo; echo "Done. You can close this window."; exec "\${SHELL:-sh}"`;
  const candidates: [string, string[]][] = [
    ["x-terminal-emulator", ["-e", "sh", "-c", keepOpen]],
    ["gnome-terminal", ["--", "sh", "-c", keepOpen]],
    ["konsole", ["-e", "sh", "-c", keepOpen]],
    ["xfce4-terminal", ["-x", "sh", "-c", keepOpen]],
    ["kitty", ["sh", "-c", keepOpen]],
    ["alacritty", ["-e", "sh", "-c", keepOpen]],
    ["xterm", ["-e", "sh", "-c", keepOpen]],
  ];
  const found = candidates.find(([bin]) => onPath(bin));
  if (!found) throw new Error(`No terminal app found. Run \`${command}\` in a terminal yourself.`);
  const child = spawn(found[0], found[1], { detached: true, stdio: "ignore" });
  child.unref();
}

export function registerProviders({ ipcMain, getWindow }: { ipcMain: IpcMain; getWindow: () => BrowserWindow | null }) {
  const settingsPath = () => userFile("settings.json");
  const keysPath = () => userFile("provider-keys.json");

  const settings = (): AppSettings => {
    const raw = readJson<Partial<AppSettings>>(settingsPath(), {});
    return { processor: { ...DEFAULT_PROCESSOR, ...raw.processor }, chat: { ...raw.chat } };
  };
  const saveSettings = (patch: Partial<AppSettings>) => {
    const next = { ...settings(), ...patch };
    writeJson(settingsPath(), next);
    return next;
  };

  // ---- API keys: encrypted at rest, main process only ----
  const encryptedKeys = () => readJson<Partial<Record<ApiKeyKind, string>>>(keysPath(), {});
  const getKey = (kind: ApiKeyKind): string | undefined => {
    const stored = encryptedKeys()[kind];
    if (stored && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(stored, "base64"));
      } catch {
        // Encrypted on another machine/user; treat as missing.
      }
    }
    // Development fallback: packages/assistant/.env (loaded by main.cjs in dev only).
    if (kind === "anthropic-api") return process.env.ANTHROPIC_API_KEY || undefined;
    if (kind === "openai-api") return process.env.OPENAI_API_KEY || undefined;
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
  };
  const keyPresence = () => Object.fromEntries(API_KEY_KINDS.map((kind) => [kind, Boolean(getKey(kind))])) as Record<ApiKeyKind, boolean>;
  const storedKeys = () => Object.fromEntries(API_KEY_KINDS.map((kind) => [kind, Boolean(encryptedKeys()[kind])])) as Record<ApiKeyKind, boolean>;

  // ---- Health, cached; Re-check refreshes ----
  let health: ProviderHealth[] | null = null;
  let checking: Promise<ProviderHealth[]> | null = null;
  const allHealth = async (refresh = false) => {
    if (refresh) clearCliCache();
    if (health && !refresh) return health;
    checking ??= checkAllProviders({ ...keyPresence(), xai: Boolean(process.env.XAI_API_KEY) }).finally(() => {
      checking = null;
    });
    health = await checking;
    return health;
  };
  const recheck = async (kind: ProviderKind) => {
    clearCliCache();
    const one = await checkProvider(kind, { ...keyPresence(), xai: Boolean(process.env.XAI_API_KEY) });
    health = (health ?? (await allHealth())).map((h) => (h.kind === kind ? one : h));
    getWindow()?.webContents.send("providers:changed");
    return one;
  };

  /** Everything the Providers page shows. No key values, only whether one is set. */
  const status = async (refresh = false) => {
    const all = await allHealth(refresh);
    const s = settings();
    const keys = storedKeys();
    return {
      settings: s,
      processors: PROCESSORS.map((p) => {
        const h = all.find((item) => item.kind === p.cli);
        const signedIn = h?.auth === "authenticated";
        const eligible = signedIn && p.requires.test(h?.authDetail ?? "");
        return {
          provider: p.provider,
          label: p.label,
          detail: p.detail,
          cli: p.cli,
          models: p.models,
          defaultModel: p.defaultModel,
          effort: p.effort,
          health: h,
          usable: Boolean(eligible),
          hint: !h?.installed ? h?.hint : signedIn && !eligible ? `Signed in as ${h?.authDetail}; video processing needs ${p.requiresText}.` : h?.usable ? undefined : h?.hint,
        };
      }),
      chat: PROVIDER_CATALOG.map((info) => ({
        ...info,
        health: all.find((h) => h.kind === info.kind),
        keyStored: info.auth === "api-key" ? keys[info.kind as ApiKeyKind] : undefined,
      })),
      unsupported: UNSUPPORTED_PROVIDERS,
      encryption: safeStorage.isEncryptionAvailable(),
    };
  };

  // ---- Sign-in via the CLI's own login command ----
  const logins = new Map<string, ChildProcess>();
  const emitLogin = (event: LoginEvent) => getWindow()?.webContents.send("providers:login-event", event);
  const loginUrls = new Set<string>();

  const login = async (kind: string) => {
    const info = providerInfo(kind);
    if (!info?.cli || !info.login) throw new Error("That provider has no command-line sign-in.");
    if (!info.login.browser) {
      openTerminal(terminalCommand(kind, "login"), `Sign in to ${info.label}`);
      return { mode: "terminal" as const };
    }
    const cli = resolveCli(info.cli) ?? (info.cli === "cursor-agent" ? resolveCli("agent") : null);
    if (!cli) throw new Error(`${info.label} isn't installed.`);
    logins.get(kind)?.kill();
    const env = { ...process.env };
    // The CLI login is for the subscription account; an API key in the env would short-circuit it.
    if (kind === "claude") {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    const child = spawnCli(cli, info.login.args, { env, stdio: ["pipe", "pipe", "pipe"] });
    logins.set(kind, child);
    emitLogin({ kind, state: "running", message: `Running \`${terminalCommand(kind, "login")}\`. Finish signing in in your browser.` });
    let output = "";
    const scan = (chunk: Buffer | string) => {
      output = (output + chunk).slice(-8000);
      // The CLI opens the browser itself; we also surface the link in case it couldn't.
      for (const match of String(chunk).matchAll(/https:\/\/[^\s"'<>]+/g)) {
        const url = match[0].replace(/[).,]+$/, "");
        if (!loginUrls.has(url)) {
          loginUrls.add(url);
          emitLogin({ kind, state: "url", url });
        }
      }
    };
    child.stdout!.on("data", scan);
    child.stderr!.on("data", scan);
    child.stdin!.on("error", () => {});
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on("error", (error) => emitLogin({ kind, state: "error", message: error.message }));
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      if (logins.get(kind) === child) logins.delete(kind);
      const h = await recheck(kind as ProviderKind).catch(() => null);
      if (h?.auth === "authenticated") emitLogin({ kind, state: "done", message: `Signed in${h.authDetail ? ` (${h.authDetail})` : ""}.` });
      else if (signal) emitLogin({ kind, state: "cancelled", message: "Sign-in stopped." });
      else emitLogin({ kind, state: "error", message: `Sign-in didn't finish (exit ${code}). ${output.trim().split(/\r?\n/).slice(-2).join(" ")}`.trim() });
    });
    return { mode: "browser" as const };
  };

  ipcMain.handle("providers:status", (_event, refresh?: boolean) => status(Boolean(refresh)));
  ipcMain.handle("providers:check", (_event, kind: string) => {
    if (!PROVIDER_CATALOG.some((p) => p.kind === kind)) throw new Error("Unknown provider.");
    return recheck(kind as ProviderKind);
  });
  ipcMain.handle("providers:login", (_event, kind: string) => login(kind));
  ipcMain.handle("providers:cancel-login", (_event, kind: string) => {
    logins.get(kind)?.kill();
  });
  ipcMain.handle("providers:open-terminal", (_event, kind: string, purpose: "login" | "install" = "login") => {
    const info = providerInfo(kind);
    openTerminal(terminalCommand(kind, purpose === "install" ? "install" : "login"), `${purpose === "install" ? "Install" : "Sign in to"} ${info?.label ?? kind}`);
  });
  /** Only links that a login command printed, or the catalog's install pages, can be opened. */
  ipcMain.handle("providers:open-url", (_event, url: string) => {
    const allowed = loginUrls.has(url) || PROVIDER_CATALOG.some((p) => p.install?.url === url);
    if (!allowed || !/^https:\/\//.test(url)) throw new Error("That link can't be opened from here.");
    return shell.openExternal(url);
  });
  ipcMain.handle("providers:set-key", async (_event, kind: string, value: string) => {
    if (!API_KEY_KINDS.includes(kind as ApiKeyKind)) throw new Error("That provider doesn't take an API key.");
    const key = typeof value === "string" ? value.trim() : "";
    if (!key || key.length > 512 || /\s/.test(key)) throw new Error("Paste the whole API key (no spaces).");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This system has no secure storage, so the key can't be saved.");
    writeJson(keysPath(), { ...encryptedKeys(), [kind]: safeStorage.encryptString(key).toString("base64") });
    await recheck(kind as ProviderKind);
    return { stored: true };
  });
  ipcMain.handle("providers:clear-key", async (_event, kind: string) => {
    if (!API_KEY_KINDS.includes(kind as ApiKeyKind)) throw new Error("That provider doesn't take an API key.");
    const next = encryptedKeys();
    delete next[kind as ApiKeyKind];
    writeJson(keysPath(), next);
    await recheck(kind as ProviderKind);
    return { stored: false };
  });
  ipcMain.handle("providers:set-processor", (_event, choice: ProcessorChoice) => {
    const info = processorInfo(choice?.provider);
    if (info.provider !== choice?.provider) throw new Error("Video processing supports Codex (ChatGPT) and Claude Code only.");
    const model = choice.model && info.models.includes(choice.model) ? choice.model : undefined;
    return saveSettings({ processor: { provider: info.provider, ...(model ? { model } : {}) } });
  });

  return {
    getKey,
    allHealth,
    processor: () => settings().processor,
    chatDefault: () => settings().chat,
    saveChatDefault: (chat: ChatDefault) => saveSettings({ chat }),
    dispose: () => {
      for (const child of logins.values()) child.kill();
      logins.clear();
    },
  };
}

export type ProvidersHub = ReturnType<typeof registerProviders>;
