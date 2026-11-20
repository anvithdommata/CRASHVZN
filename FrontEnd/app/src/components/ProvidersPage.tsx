import { useChatStore } from "@/assistant/chatStore";
import type { AssistantProviderHealth, ChatProviderStatus, ProcessorStatus, ProviderLoginEvent } from "@/electron.d";
import { useProvidersStore } from "@/store/useProvidersStore";
import {
  ArrowLeft,
  Check,
  CircleAlert,
  Download,
  ExternalLink,
  Film,
  KeyRound,
  Loader2,
  LogIn,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

const cleanIpcError = (error: unknown) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);

/**
 * Providers page: which model reads the footage (video processing) and which one drives the chat
 * assistant, with T3 Code-style status and sign-in for each. Opened from the gear on the home screen
 * and in the viewer.
 */
export function ProvidersPage() {
  const status = useProvidersStore((state) => state.status);
  const loading = useProvidersStore((state) => state.loading);
  const error = useProvidersStore((state) => state.error);
  const setOpen = useProvidersStore((state) => state.setOpen);
  const load = useProvidersStore((state) => state.load);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  return (
    <div className="absolute inset-0 z-[60] flex flex-col bg-canvas text-ink" role="dialog" aria-label="Providers">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="flex items-center gap-1.5 rounded-full py-1.5 pr-3 pl-2 text-sm font-medium text-ink-2 hover:bg-white/8"
          title="Back (Esc)"
        >
          <ArrowLeft size={18} />
          Back
        </button>
        <h1 className="text-[18px] font-normal text-ink">Providers</h1>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md bg-accent-soft px-3 py-1.5 text-xs font-medium text-accent disabled:opacity-60"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          Re-check all
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 pb-10">
        <div className="mx-auto max-w-[920px]">
          {error && (
            <div className="mt-4 flex items-start gap-2 rounded-xl bg-crash-soft px-3 py-2 text-sm text-crash">
              <CircleAlert size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {!status && !error && (
            <div className="flex items-center gap-2 py-10 text-sm text-ink-3">
              <Loader2 size={16} className="animate-spin" /> Checking which providers are installed and signed in…
            </div>
          )}
          {status && (
            <>
              <Section
                icon={<Film size={18} className="text-accent" />}
                title="Video processing"
                blurb="The model that reads uploaded footage and builds the reconstruction. It runs through the provider's own CLI on your subscription login; API keys aren't used here."
              >
                <div className="grid gap-3 md:grid-cols-2">
                  {status.processors.map((processor) => (
                    <ProcessorCard key={processor.provider} processor={processor} active={status.settings.processor.provider === processor.provider} model={status.settings.processor.model} />
                  ))}
                </div>
              </Section>

              <Section
                icon={<MessageSquare size={18} className="text-accent" />}
                title="Chat assistant"
                blurb="The model behind the assistant panel. Every provider can use only this app's own tools (camera, timeline, measurements), never your files, shell or the web. Signed-in CLIs bill your own subscription; API keys are stored encrypted on this computer and never shown again."
              >
                {!status.encryption && (
                  <p className="mb-3 rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">This system has no secure storage, so API keys can't be saved. CLI sign-ins still work.</p>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  {status.chat.map((provider) => (
                    <ChatCard key={provider.kind} provider={provider} />
                  ))}
                </div>
                {status.unsupported.length > 0 && (
                  <div className="mt-5 rounded-2xl border border-dashed border-line-strong px-4 py-3">
                    <div className="mb-1.5 text-xs font-medium tracking-wide text-ink-3 uppercase">Not supported yet</div>
                    <ul className="space-y-1 text-xs text-ink-2">
                      {status.unsupported.map((item) => (
                        <li key={item.label}>
                          <span className="font-medium text-ink-2">{item.label}</span>: {item.why}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ icon, title, blurb, children }: { icon: ReactNode; title: string; blurb: string; children: ReactNode }) {
  return (
    <section className="pt-6">
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <h2 className="text-[16px] font-medium text-ink">{title}</h2>
      </div>
      <p className="mb-4 max-w-[720px] text-sm text-ink-3">{blurb}</p>
      {children}
    </section>
  );
}

function Badge({ tone, children }: { tone: "ok" | "warn" | "off" | "info"; children: ReactNode }) {
  const tones = {
    ok: "bg-ok/10 text-ok",
    warn: "bg-warn/10 text-warn",
    off: "bg-white/6 text-ink-3",
    info: "bg-accent-soft text-accent",
  };
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function HealthBadges({ health, apiKey }: { health?: AssistantProviderHealth; apiKey?: boolean }) {
  if (!health) return <Badge tone="off">Checking…</Badge>;
  if (apiKey) return health.auth === "authenticated" ? <Badge tone="ok"><Check size={11} /> Key set</Badge> : <Badge tone="off">No key</Badge>;
  return (
    <>
      {health.installed ? <Badge tone="info">Installed{health.version ? ` · v${health.version.replace(/^v/, "")}` : ""}</Badge> : <Badge tone="off">Not installed</Badge>}
      {health.installed &&
        (health.auth === "authenticated" ? (
          <Badge tone="ok">
            <Check size={11} /> Signed in{health.authDetail ? ` · ${health.authDetail}` : ""}
          </Badge>
        ) : health.auth === "unauthenticated" ? (
          <Badge tone="warn">Not signed in</Badge>
        ) : (
          <Badge tone="off">Sign-in unknown</Badge>
        ))}
    </>
  );
}

const actionButton =
  "inline-flex items-center gap-1.5 rounded-md border border-line bg-white/4 px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-white/8 disabled:opacity-50";

/** Sign in / Open terminal / Re-check / install hint, shared by both sections (same CLIs). */
function CliActions({ kind, health, login, install }: { kind: string; health?: AssistantProviderHealth; login?: { browser: boolean }; install?: { command?: string; url: string } }) {
  const run = useProvidersStore((state) => state.run);
  const busy = useProvidersStore((state) => state.busy[kind]);
  const api = window.crashvzn?.providers;
  if (!api) return null;
  const installed = health?.installed ?? false;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {installed && login && health?.auth !== "authenticated" && (
        <button type="button" disabled={Boolean(busy)} className={`${actionButton} border-accent bg-accent-strong text-white hover:bg-accent`} onClick={() => void run(kind, "login", () => api.login(kind))}>
          {busy === "login" ? <Loader2 size={12} className="animate-spin" /> : <LogIn size={12} />}
          {login.browser ? "Sign in" : "Sign in in terminal"}
        </button>
      )}
      {installed && login && (
        <button type="button" className={actionButton} title="Open a terminal window running the sign-in command" onClick={() => void run(kind, "terminal", () => api.openTerminal(kind, "login"))}>
          <Terminal size={12} />
          {health?.auth === "authenticated" ? "Switch account in terminal" : "Open terminal to sign in"}
        </button>
      )}
      {!installed && install?.command && (
        <button type="button" className={actionButton} title={install.command} onClick={() => void run(kind, "install", () => api.openTerminal(kind, "install"))}>
          <Download size={12} /> Install in terminal
        </button>
      )}
      {!installed && install?.url && (
        <button type="button" className={actionButton} onClick={() => void run(kind, "docs", () => api.openUrl(install.url))}>
          <ExternalLink size={12} /> Install guide
        </button>
      )}
      <button type="button" disabled={Boolean(busy)} className={actionButton} onClick={() => void run(kind, "check", () => api.check(kind))}>
        <RefreshCw size={12} className={busy === "check" ? "animate-spin" : ""} /> Re-check
      </button>
    </div>
  );
}

function LoginProgress({ kind }: { kind: string }) {
  const event: ProviderLoginEvent | undefined = useProvidersStore((state) => state.logins[kind]);
  const api = window.crashvzn?.providers;
  if (!event || !api) return null;
  const running = event.state === "running" || event.state === "url";
  const tone = event.state === "done" ? "text-ok bg-ok/10" : event.state === "error" ? "text-crash bg-crash-soft" : "text-ink-2 bg-white/4";
  return (
    <div className={`mt-2 rounded-lg px-2.5 py-2 text-xs ${tone}`}>
      <div className="flex items-start gap-1.5">
        {running ? <Loader2 size={12} className="mt-0.5 shrink-0 animate-spin" /> : event.state === "done" ? <Check size={12} className="mt-0.5 shrink-0" /> : <CircleAlert size={12} className="mt-0.5 shrink-0" />}
        <span className="flex-1">{event.message}</span>
        {running && (
          <button type="button" className="shrink-0 underline" onClick={() => void api.cancelLogin(kind)}>
            Cancel
          </button>
        )}
      </div>
      {running && event.url && (
        <button type="button" className="mt-1.5 inline-flex items-center gap-1 font-medium text-accent underline" onClick={() => void api.openUrl(event.url!)}>
          <ExternalLink size={11} /> Browser didn't open? Open the sign-in page
        </button>
      )}
    </div>
  );
}

function Card({ selected, children }: { selected?: boolean; children: ReactNode }) {
  return <div className={`rounded-2xl border p-4 ${selected ? "border-accent ring-1 ring-accent" : "border-line"}`}>{children}</div>;
}

function ProcessorCard({ processor, active, model }: { processor: ProcessorStatus; active: boolean; model?: string }) {
  const run = useProvidersStore((state) => state.run);
  const api = window.crashvzn?.providers;
  const current = active && model && processor.models.includes(model) ? model : processor.defaultModel;
  const choose = (next: { model?: string }) => api && void run(processor.provider, "select", () => api.setProcessor({ provider: processor.provider, ...next }));
  return (
    <Card selected={active}>
      <div className="flex items-start gap-3">
        <input
          type="radio"
          name="video-processor"
          checked={active}
          onChange={() => choose({ model: current })}
          className="mt-1 accent-[var(--color-accent-strong)]"
          aria-label={`Use ${processor.label} for video processing`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">{processor.label}</span>
            {active && <Badge tone="info">In use</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-ink-3">{processor.detail}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <HealthBadges health={processor.health} />
          </div>
          {processor.hint && !processor.usable && <p className="mt-2 text-xs text-warn">{processor.hint}</p>}
          <div className="mt-3 flex items-center gap-2 text-xs text-ink-2">
            <span>Model</span>
            <select
              value={current}
              disabled={processor.models.length < 2}
              onChange={(event) => choose({ model: event.target.value })}
              className="rounded-md border border-line bg-sunken px-2 py-1 text-xs text-ink disabled:bg-white/4"
            >
              {processor.models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <span className="text-ink-3">{processor.effort} effort</span>
          </div>
          <div className="mt-3">
            <CliActions kind={processor.cli} health={processor.health} login={{ browser: true }} install={processor.health?.installed ? undefined : { url: processor.cli === "claude" ? "https://claude.com/claude-code" : "https://developers.openai.com/codex/cli", command: processor.cli === "claude" ? "npm i -g @anthropic-ai/claude-code" : "npm i -g @openai/codex" }} />
            <LoginProgress kind={processor.cli} />
          </div>
        </div>
      </div>
    </Card>
  );
}

const TESTED: Record<ChatProviderStatus["tested"], { tone: "ok" | "warn" | "off"; label: string }> = {
  verified: { tone: "ok", label: "Tested" },
  partial: { tone: "warn", label: "Partly tested" },
  unverified: { tone: "off", label: "Untested" },
};

function ChatCard({ provider }: { provider: ChatProviderStatus }) {
  const choice = useChatStore((state) => state.choice);
  const setChoice = useChatStore((state) => state.setChoice);
  const setChatStatus = useChatStore((state) => state.setStatus);
  const run = useProvidersStore((state) => state.run);
  const isDefault = choice?.provider === provider.kind;
  const usable = provider.health?.usable ?? false;
  const tested = TESTED[provider.tested];

  const makeDefault = () =>
    run(provider.kind, "default", async () => {
      const api = window.crashvzn?.assistant;
      if (!api) return;
      setChatStatus("starting");
      try {
        const next = await api.start({ provider: provider.kind, model: provider.models[0]?.id ?? "", effort: provider.efforts.length ? "low" : "" });
        setChoice(next);
        setChatStatus("ready");
      } catch (error) {
        setChatStatus("error", cleanIpcError(error));
        throw error;
      }
    });

  return (
    <Card selected={isDefault}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-ink">{provider.label}</span>
        {isDefault && <Badge tone="info">Default</Badge>}
        <span className="flex-1" />
        <span title={provider.tested === "unverified" ? "Written from the provider's docs and T3 Code's source; not run on the dev machine yet." : undefined}>
          <Badge tone={tested.tone}>{tested.label}</Badge>
        </span>
      </div>
      <p className="mt-0.5 text-xs text-ink-3">{provider.detail}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <HealthBadges health={provider.health} apiKey={provider.auth === "api-key"} />
        {!provider.chat && <Badge tone="off">Status and sign-in only</Badge>}
      </div>
      {provider.health?.hint && !usable && provider.auth === "cli" && <p className="mt-2 text-xs text-ink-3">{provider.health.hint}</p>}
      <div className="mt-3 space-y-2">
        {provider.auth === "api-key" ? (
          <ApiKeyField provider={provider} />
        ) : (
          <>
            <CliActions kind={provider.kind} health={provider.health} login={provider.login} install={provider.install} />
            <LoginProgress kind={provider.kind} />
          </>
        )}
        {provider.chat && (
          <button
            type="button"
            disabled={!usable || isDefault}
            onClick={() => void makeDefault()}
            className={`${actionButton} ${isDefault ? "" : "text-accent"}`}
            title={usable ? "Use this provider for the chat assistant" : "Sign in first"}
          >
            <Check size={12} /> {isDefault ? "Default for chat" : "Make default for chat"}
          </button>
        )}
      </div>
    </Card>
  );
}

function ApiKeyField({ provider }: { provider: ChatProviderStatus }) {
  const run = useProvidersStore((state) => state.run);
  const busy = useProvidersStore((state) => state.busy[provider.kind]);
  const [value, setValue] = useState("");
  const api = window.crashvzn?.providers;
  if (!api) return null;
  const save = () =>
    void run(provider.kind, "key", async () => {
      await api.setKey(provider.kind, value);
      setValue("");
    });
  return (
    <div>
      {provider.keyStored ? (
        <div className="flex items-center gap-2 text-xs text-ink-2">
          <ShieldCheck size={14} className="text-ok" />
          <span className="flex-1">Key saved, encrypted on this computer.</span>
          <button type="button" className={actionButton} disabled={Boolean(busy)} onClick={() => void run(provider.kind, "key", () => api.clearKey(provider.kind))}>
            <X size={12} /> Remove
          </button>
        </div>
      ) : (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) save();
          }}
        >
          <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-line px-2 py-1 focus-within:border-accent">
            <KeyRound size={12} className="shrink-0 text-ink-3" />
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={provider.health?.auth === "authenticated" ? `Using ${provider.apiKeyEnv} from the environment` : `Paste ${provider.apiKeyEnv}`}
              className="w-full bg-transparent text-xs outline-none placeholder:text-ink-3"
              aria-label={`${provider.label} API key`}
            />
          </label>
          <button type="submit" disabled={!value.trim() || Boolean(busy)} className={actionButton}>
            {busy === "key" ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
          </button>
        </form>
      )}
    </div>
  );
}
