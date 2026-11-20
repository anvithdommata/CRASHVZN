import { hasModel, interruptTurn, sendMessage } from "@/assistant/bridge";
import { useChatStore, type ChatItem, type ToolChip } from "@/assistant/chatStore";
import type { AssistantEffort } from "@/electron.d";
import { AnalysisPanel } from "@/components/KinematicsPanel";
import { ResizeHandle } from "@/components/ResizeHandle";
import { Tabs, readPref, writePref } from "@/components/ui";
import { formatClock, formatRelative } from "@/lib/time";
import { RIGHT_RAIL, useAppStore } from "@/store/useAppStore";
import { useProvidersStore } from "@/store/useProvidersStore";
import { ArrowUp, Check, ChevronDown, CircleAlert, Gauge, Loader2, MessageSquare, PanelRightClose, PanelRightOpen, Settings, Sparkles, Square, Trash2, X, Zap } from "lucide-react";
import { useVoiceHotkey, VoiceButton } from "@/voice";
import { useEffect, useMemo, useRef, useState } from "react";

type ModelOption = { id: string; label: string };
type ProviderOption = { kind: string; label: string; detail: string; models: ModelOption[]; efforts: AssistantEffort[] };

const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
];
const EFFORTS: AssistantEffort[] = ["low", "medium", "high"];

/**
 * What the picker offers, like T3 Code's: providers, each with its models and effort levels.
 * Mirrors packages/assistant/src/providers/catalog.ts (chat-capable entries); sign-in and API keys
 * live on the Providers page.
 */
const CATALOG: ProviderOption[] = [
  { kind: "claude", label: "Claude", detail: "Claude Code login", models: CLAUDE_MODELS, efforts: EFFORTS },
  { kind: "codex", label: "Codex", detail: "ChatGPT login", models: [{ id: "", label: "Default model" }], efforts: EFFORTS },
  { kind: "opencode", label: "OpenCode", detail: "OpenCode login", models: [{ id: "", label: "Default model" }], efforts: [] },
  { kind: "gemini", label: "Gemini", detail: "Gemini CLI login", models: [{ id: "", label: "Default model" }], efforts: [] },
  { kind: "grok", label: "Grok", detail: "Grok CLI login", models: [{ id: "", label: "Default model" }], efforts: [] },
  { kind: "anthropic-api", label: "Claude API", detail: "API key", models: CLAUDE_MODELS, efforts: EFFORTS },
  {
    kind: "openai-api",
    label: "OpenAI API",
    detail: "API key",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    ],
    efforts: EFFORTS,
  },
  { kind: "gemini-api", label: "Gemini API", detail: "API key", models: [{ id: "", label: "Gemini 3.1 Flash Lite" }], efforts: [] },
];

const TOOL_VERBS: Record<string, string> = {
  library_list: "Checking the library",
  incident_open: "Opening the reconstruction",
  incident_close: "Going back to the library",
  scene_describe: "Reading the scene",
  entity_find: "Finding the vehicle",
  camera_focus: "Zooming in",
  camera_pan_to: "Panning",
  camera_orbit: "Orbiting",
  camera_rotate: "Turning",
  camera_move: "Moving",
  camera_zoom: "Zooming",
  camera_set: "Placing the camera",
  camera_preset: "Switching view",
  camera_follow: "Following",
  camera_pov: "Driver's-eye view",
  camera_reset: "Resetting the view",
  timeline_seek: "Seeking",
  timeline_play: "Playing",
  timeline_pause: "Pausing",
  kinematics_query: "Reading motion data",
  kinematics_series: "Reading motion data",
  measure_distance: "Measuring",
  marker_add: "Dropping a pin",
  ui_toggle: "Updating the view",
  export_video: "Starting the export",
};

const toolName = (name: string) => name.replace(/^mcp__crashvzn__/, "");

function choiceLabel(provider?: string, model?: string, effort?: string) {
  const option = CATALOG.find((item) => item.kind === provider);
  const modelLabel = option?.models.find((item) => item.id === (model ?? ""))?.label ?? (model || option?.models[0]?.label || "Assistant");
  return { model: modelLabel, effort: effort ? effort[0].toUpperCase() + effort.slice(1) : null, provider: option?.label ?? provider ?? "" };
}

export function AssistantPanel() {
  const open = useAppStore((state) => state.assistantOpen);
  const setOpen = useAppStore((state) => state.setAssistantOpen);
  const width = useAppStore((state) => state.rightWidth);
  const setWidth = useAppStore((state) => state.setRightWidth);
  const isResizing = useAppStore((state) => state.resizing);
  const setResizing = useAppStore((state) => state.setResizing);
  const items = useChatStore((state) => state.items);
  const status = useChatStore((state) => state.status);
  const statusText = useChatStore((state) => state.statusText);
  const clear = useChatStore((state) => state.clear);
  const [draft, setDraft] = useState("");
  const [partial, setPartial] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const desktop = hasModel();
  const [tab, setTabState] = useState<"chat" | "analysis">(() => readPref("crashvzn.rightTab", ["chat", "analysis"] as const, "chat"));
  const setTab = (next: "chat" | "analysis") => {
    setTabState(next);
    writePref("crashvzn.rightTab", next);
  };

  const busy = useMemo(() => items.some((item) => item.kind === "assistant" && !item.done), [items]);

  const submitRef = useRef<(text?: string) => void>(() => {});
  // Hold (or tap) Ctrl+M anywhere in the window to talk, even with this panel collapsed.
  const hotkey = useVoiceHotkey({
    onTranscript: (text) => {
      setPartial("");
      if (text.trim()) submitRef.current(text);
    },
    onPartial: setPartial,
  });

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [items, partial]);

  const submit = (text = draft) => {
    if (!text.trim() || busy) return;
    void sendMessage(text);
    setDraft("");
    setPartial("");
  };

  submitRef.current = submit;

  // Same collapse model as the left panel: one mounted aside, translateX to a rail.
  // Remounting a separate 48px rail was what caused the black flash.
  const hiddenX = width - RIGHT_RAIL;

  return (
    <>
      <div
        aria-hidden
        className={`h-full shrink-0 ${isResizing ? "" : "transition-[width] duration-200 ease-in-out"}`}
        style={{ width: open ? width : RIGHT_RAIL }}
      />
      <aside
        style={{ width, transform: `translateX(${open ? 0 : hiddenX}px)` }}
        className={`absolute inset-y-0 right-0 z-30 flex flex-col border-l border-line bg-panel text-ink shadow-[-4px_0_32px_rgba(0,0,0,0.45)] ${
          isResizing ? "" : "transition-transform duration-200 ease-in-out"
        }`}
      >
        {open && (
          <ResizeHandle edge="left" width={width} onResize={setWidth} onResizingChange={setResizing} label="Resize the assistant" dark />
        )}
        <header className="flex items-center gap-2 px-3 pt-3 pb-2">
          <button
            type="button"
            aria-label={open ? "Hide the assistant" : "Show the assistant"}
            title={open ? "Hide the assistant" : "Show the assistant"}
            className="rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white"
            onClick={() => setOpen(!open)}
          >
            {open ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
          {open && (
            <>
              <div className="min-w-0 flex-1">
                <Tabs
                  label="Assistant sections"
                  value={tab}
                  onChange={setTab}
                  tabs={[
                    { id: "chat", label: "Chat", icon: <MessageSquare size={13} /> },
                    { id: "analysis", label: "Analysis", icon: <Gauge size={13} /> },
                  ]}
                />
              </div>
              <button
                type="button"
                aria-label="Clear the conversation view"
                title="Clear the conversation view"
                disabled={items.length === 0 || busy || tab !== "chat"}
                className="rounded-full p-1.5 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-30"
                onClick={clear}
              >
                <Trash2 size={15} />
              </button>
            </>
          )}
        </header>

        {open && (status === "starting" || status === "error") && (
          <div
            className={`mx-3 mb-1 flex items-center gap-1.5 truncate rounded-lg px-2.5 py-1.5 text-[11px] ${status === "error" ? "bg-crash-soft text-crash" : "bg-white/5 text-ink-3"}`}
            title={statusText}
          >
            {status === "starting" ? <Loader2 size={12} className="shrink-0 animate-spin" /> : <CircleAlert size={12} className="shrink-0" />}
            <span className="truncate">{status === "starting" ? "Starting the assistant…" : statusText}</span>
          </div>
        )}
        {open && <ContextStrip />}

        {open && tab === "analysis" && (
          <div className="flex-1 overflow-y-auto px-3 py-3">
            <AnalysisPanel />
          </div>
        )}

        {open && tab === "chat" && (
          <>
            <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
              {items.length === 0 ? (
                <EmptyState onPick={(text) => submit(text)} desktop={desktop} />
              ) : (
                items.map((item) => <Message key={item.id} item={item} />)
              )}
              {partial && <div className="ml-auto max-w-[85%] rounded-2xl bg-white/5 px-3 py-2 text-sm text-white/50 italic">{partial}</div>}
            </div>

            <div className="px-3 pb-3">
              <div className="rounded-2xl border border-line bg-raised focus-within:border-accent/50">
                <textarea
                  ref={inputRef}
                  value={draft}
                  rows={2}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={desktop ? `Ask about the crash, or hold ${hotkey} to talk` : "Quick commands: pause, top view, zoom in…"}
                  className="block max-h-40 min-h-[52px] w-full resize-none bg-transparent px-4 pt-3 text-sm text-white outline-none placeholder:text-white/35"
                />
                <div className="flex items-center gap-1 px-2 pb-2">
                  <ModelPicker disabled={busy || !desktop} />
                  <div className="flex-1" />
                  <VoiceButton
                    disabled={busy}
                    onPartial={setPartial}
                    onTranscript={(text) => {
                      setPartial("");
                      if (text.trim()) submit(text);
                    }}
                  />
                  {busy ? (
                    <button
                      type="button"
                      aria-label="Stop"
                      title="Stop"
                      onClick={() => void interruptTurn()}
                      className="grid h-8 w-8 place-items-center rounded-full bg-white text-black hover:bg-white/85"
                    >
                      <Square size={12} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label="Send"
                      title="Send (Enter)"
                      disabled={!draft.trim()}
                      onClick={() => submit()}
                      className="grid h-8 w-8 place-items-center rounded-full bg-white text-black hover:bg-white/85 disabled:bg-white/15 disabled:text-white/40"
                    >
                      <ArrowUp size={16} />
                    </button>
                  )}
                </div>
              </div>
              <p className="mt-2 px-1 text-[11px] leading-snug text-white/35">
                Answers come from the reconstruction only and are estimates, not measured facts.
              </p>
            </div>
          </>
        )}
      </aside>
    </>
  );
}

/** What's open and where the playhead is, so it's clear what the assistant is looking at. */
function ContextStrip() {
  const view = useAppStore((state) => state.view);
  const scene = useAppStore((state) => state.scenes.find((item) => item.id === state.selectedId));
  const time = useAppStore((state) => state.time);
  const impactTime = useAppStore((state) => state.impactTime);
  const text =
    view === "viewer" && scene
      ? scene.title
      : "Library";
  return (
    <div className="mx-3 mb-1 flex items-center gap-2 rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-[11px] text-ink-3">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-ink-2" title="What the assistant is looking at">
        {text}
      </span>
      {view === "viewer" && scene && (
        <span className="shrink-0 tabular-nums">
          {formatClock(time)}
          {impactTime != null && <span className={time >= impactTime ? "text-crash" : ""}> · {formatRelative(time, impactTime)}</span>}
        </span>
      )}
    </div>
  );
}

function EmptyState({ onPick, desktop }: { onPick: (text: string) => void; desktop: boolean }) {
  const view = useAppStore((state) => state.view);
  const scene = useAppStore((state) => state.scenes.find((item) => item.id === state.selectedId));
  const library = useAppStore((state) => state.scenes);
  // Suggestions name what's actually in the open scene (or the library).
  const crashVehicles = scene ? scene.vehicles.filter((vehicle) => (scene.crashVehicles ?? []).includes(vehicle.id)) : [];
  const first = crashVehicles[0] ?? scene?.vehicles[0];
  const second = crashVehicles[1];
  const suggestions =
    view === "home"
      ? [...(library[0] ? [`Open ${library[0].title}`] : []), "What reconstructions do I have?"]
      : desktop
        ? [
            "Show me the crash from above",
            ...(first ? [`How fast was the ${first.label} at impact?`, `Follow the ${first.label}`] : []),
            ...(second ? [`Driver's-eye view from the ${second.label}`] : []),
            "Go to 3 seconds before the crash and pause",
          ].slice(0, 4)
        : ["top view", "jump to the crash", "slow motion", "zoom in"];
  return (
    <div className="flex h-full flex-col justify-end pb-2">
      <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-[#d97757]/15"><Sparkles size={20} className="text-[#d97757]" /></div>
      <p className="mb-1 text-sm text-white/85">I can move the camera, play the footage and answer questions about this reconstruction.</p>
      <p className="mb-4 text-xs text-white/40">{desktop ? "Type, or hold the mic (or Ctrl+M) to talk." : "Open the desktop app to talk to the model."}</p>
      <div className="flex flex-col items-start gap-2">
        {suggestions.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-left text-xs text-white/80 hover:border-white/25 hover:bg-white/10"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ item }: { item: ChatItem }) {
  if (item.kind === "user") {
    return <div className="ml-auto w-fit max-w-[85%] rounded-2xl bg-[#2a2a2d] px-3 py-2 text-sm whitespace-pre-wrap text-white">{item.text}</div>;
  }
  const thinking = !item.done && !item.text && item.tools.length === 0 && !item.error;
  return (
    <div className="space-y-1.5">
      {item.tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.tools.map((tool) => (
            <ToolBadge key={tool.id} tool={tool} />
          ))}
        </div>
      )}
      {item.text && <div className="text-sm leading-relaxed whitespace-pre-wrap text-white/90">{item.text}</div>}
      {thinking && (
        <div className="flex items-center gap-2 text-xs text-white/45">
          <Loader2 size={13} className="animate-spin" /> Working…
        </div>
      )}
      {item.error && (
        <div className="flex items-start gap-1.5 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <CircleAlert size={14} className="mt-px shrink-0" />
          <span>{item.error}</span>
        </div>
      )}
      {item.done && item.source === "fast-path" && (
        <div className="flex items-center gap-1 text-[10px] text-white/30">
          <Zap size={10} /> Instant command
        </div>
      )}
    </div>
  );
}

function ToolBadge({ tool }: { tool: ToolChip }) {
  const name = toolName(tool.name);
  const label = TOOL_VERBS[name] ?? name.replace(/_/g, " ");
  return (
    <span
      title={tool.output ? `${name}: ${tool.output.slice(0, 400)}` : name}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
        tool.ok === false ? "border-red-400/30 bg-red-500/10 text-red-300" : "border-white/10 bg-white/5 text-white/65"
      }`}
    >
      {tool.ok === undefined ? <Loader2 size={11} className="animate-spin" /> : tool.ok ? <Check size={11} /> : <X size={11} />}
      {label}
    </span>
  );
}

/** Provider, model and effort picker, laid out like T3 Code's. Opus 5.5 at low effort is the default. */
function ModelPicker({ disabled }: { disabled: boolean }) {
  const providers = useChatStore((state) => state.providers);
  const choice = useChatStore((state) => state.choice);
  const setChoice = useChatStore((state) => state.setChoice);
  const setStatus = useChatStore((state) => state.setStatus);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = async (opts: { provider?: string; model?: string; effort?: AssistantEffort | "" }) => {
    const api = window.crashvzn?.assistant;
    if (!api) return;
    setStatus("starting");
    try {
      setChoice(await api.start(opts));
      setStatus("ready");
    } catch (error) {
      setStatus("error", error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error));
    }
  };

  const label = choiceLabel(choice?.provider, choice?.model, choice?.effort);
  const current = CATALOG.find((item) => item.kind === choice?.provider);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title={label.provider ? `${label.provider} · ${label.model}${label.effort ? ` · ${label.effort} effort` : ""}` : "Assistant model"}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-white/80 hover:bg-white/10 disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <span className="font-medium">{label.model}</span>
        {label.effort && <span className="text-white/45">{label.effort}</span>}
        <ChevronDown size={12} className="text-white/45" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-[290px] overflow-hidden rounded-xl border border-white/10 bg-[#1b1b1d] py-1 shadow-2xl">
          <div className="max-h-[360px] overflow-y-auto">
            {CATALOG.map((provider) => {
              const health = providers?.find((item) => item.kind === provider.kind);
              const usable = health?.usable ?? false;
              return (
                <div key={provider.kind} className="px-1 py-1">
                  <div className="flex items-baseline gap-2 px-2 pt-1 pb-0.5">
                    <span className="text-[11px] font-medium tracking-wide text-white/50 uppercase">{provider.label}</span>
                    <span className="truncate text-[10px] text-white/30" title={health?.hint}>
                      {usable ? health?.authDetail ?? provider.detail : health?.hint ?? (health ? "Not signed in" : "Checking…")}
                    </span>
                  </div>
                  {provider.models.map((model) => {
                    const selected = choice?.provider === provider.kind && (choice?.model ?? "") === model.id;
                    return (
                      <button
                        key={`${provider.kind}:${model.id}`}
                        type="button"
                        disabled={!usable}
                        onClick={() => {
                          setOpen(false);
                          void pick({
                            provider: provider.kind,
                            model: model.id,
                            effort: provider.efforts.length ? (choice?.effort && provider.efforts.includes(choice.effort) ? choice.effort : "low") : "",
                          });
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-white/85 hover:bg-white/10 disabled:text-white/30 disabled:hover:bg-transparent"
                      >
                        <span className="flex-1">{model.label}</span>
                        {selected && <Check size={14} className="text-white" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {current && current.efforts.length > 0 && (
            <div className="border-t border-white/10 px-3 py-2">
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-white/50 uppercase">Effort</div>
              <div className="flex gap-1 rounded-lg bg-black/40 p-0.5">
                {current.efforts.map((effort) => (
                  <button
                    key={effort}
                    type="button"
                    onClick={() => void pick({ effort })}
                    className={`flex-1 rounded-md px-2 py-1 text-xs capitalize ${choice?.effort === effort ? "bg-white/15 text-white" : "text-white/55 hover:text-white"}`}
                  >
                    {effort}
                  </button>
                ))}
              </div>
            </div>
          )}
          {window.crashvzn?.providers && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                useProvidersStore.getState().setOpen(true);
              }}
              className="flex w-full items-center gap-2 border-t border-white/10 px-3 py-2 text-left text-xs text-white/60 hover:bg-white/5 hover:text-white"
            >
              <Settings size={13} /> Manage providers and sign-ins…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
