import { useChatStore } from "@/assistant/chatStore";
import type { ProviderLoginEvent, ProvidersStatus } from "@/electron.d";
import { create } from "zustand";

const cleanIpcError = (error: unknown) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);

type ProvidersStore = {
  /** The Providers page is a full-window overlay over the library or the viewer. */
  open: boolean;
  status: ProvidersStatus | null;
  loading: boolean;
  error: string;
  /** Latest sign-in progress per provider kind. */
  logins: Record<string, ProviderLoginEvent | undefined>;
  /** Per-card action in flight ("check", "login", "key"…), for spinners. */
  busy: Record<string, string | undefined>;
  setOpen: (open: boolean) => void;
  load: (refresh?: boolean) => Promise<void>;
  run: (kind: string, action: string, task: () => Promise<unknown>) => Promise<void>;
  onLoginEvent: (event: ProviderLoginEvent) => void;
};

let subscribed = false;

export const useProvidersStore = create<ProvidersStore>((set, get) => ({
  open: false,
  status: null,
  loading: false,
  error: "",
  logins: {},
  busy: {},

  setOpen: (open) => {
    set({ open });
    if (open) void get().load();
    const api = window.crashvzn?.providers;
    if (open && api && !subscribed) {
      subscribed = true;
      api.onLoginEvent((event) => get().onLoginEvent(event));
      api.onChanged(() => void get().load());
    }
  },

  load: async (refresh = false) => {
    const api = window.crashvzn?.providers;
    if (!api) {
      set({ error: "Providers are managed in the desktop app." });
      return;
    }
    set({ loading: true });
    try {
      const status = await api.status(refresh);
      set({ status, error: "", loading: false });
      // Keep the chat panel's picker in step with what the page shows.
      useChatStore.getState().setProviders(status.chat.flatMap((p) => (p.health ? [p.health] : [])));
    } catch (error) {
      set({ error: cleanIpcError(error), loading: false });
    }
  },

  run: async (kind, action, task) => {
    set((state) => ({ busy: { ...state.busy, [kind]: action }, error: "" }));
    try {
      await task();
      await get().load();
    } catch (error) {
      set({ error: cleanIpcError(error) });
    } finally {
      set((state) => ({ busy: { ...state.busy, [kind]: undefined } }));
    }
  },

  onLoginEvent: (event) => {
    set((state) => {
      const previous = state.logins[event.kind];
      // Keep the sign-in link visible while the login runs.
      const url = event.url ?? (event.state === "running" ? undefined : previous?.url);
      return { logins: { ...state.logins, [event.kind]: { ...event, url, message: event.message ?? previous?.message } } };
    });
    if (event.state !== "running" && event.state !== "url") void get().load();
  },
}));

/** Display name of the active video-processing provider ("Codex" / "Claude"). */
export function processorName(status: ProvidersStatus | null) {
  return status?.settings.processor.provider === "claude" ? "Claude" : "Codex";
}
