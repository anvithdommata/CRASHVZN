import { connectSceneBridge } from "@/assistant/bridge";
import { useChatStore } from "@/assistant/chatStore";
import { AssistantPanel } from "@/components/AssistantPanel";
import { HomeScreen } from "@/components/HomeScreen";
import { ProvidersPage } from "@/components/ProvidersPage";
import { SidePanel } from "@/components/SidePanel";
import { Timeline } from "@/components/Timeline";
import { Viewport } from "@/components/Viewport";
import { loadSavedScenes } from "@/incident/reconstruct";
import { syncBuiltinScenes } from "@/kinematics/store";
import { ingestFiles } from "@/lib/ingest";
import { useAppStore } from "@/store/useAppStore";
import { useProvidersStore } from "@/store/useProvidersStore";
import { useEffect, useState } from "react";

const cleanIpcError = (error: unknown) =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);

export default function App() {
  const [dragOver, setDragOver] = useState(false);
  const view = useAppStore((state) => state.view);
  const providersOpen = useProvidersStore((state) => state.open);

  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes("Files");

    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragOver(true);
    };
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        setDragOver(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragOver(false);
      if (event.dataTransfer?.files?.length) void ingestFiles(event.dataTransfer.files);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Typing, picking from a list, or pressing a focused button keeps its own keys.
      if (target && (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) || target.isContentEditable)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const store = useAppStore.getState();
      if (store.view !== "viewer") return;
      if (event.key === " ") {
        event.preventDefault();
        store.togglePlay();
      } else if (event.key === "ArrowRight") {
        store.setTime(store.time + (event.shiftKey ? 1 : 0.1));
      } else if (event.key === "ArrowLeft") {
        store.setTime(store.time - (event.shiftKey ? 1 : 0.1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep both side panels inside a window that gets narrower.
  useEffect(() => {
    const onResize = () => {
      const state = useAppStore.getState();
      state.setLeftWidth(state.leftWidth);
      state.setRightWidth(state.rightWidth);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Assistant: answer tool calls from the main process, and warm up the default model.
  useEffect(() => {
    const disconnect = connectSceneBridge();
    // Store each preview scene's per-frame motion in MongoDB (skipped when it's unchanged).
    void syncBuiltinScenes();
    // AI reconstructions saved in MongoDB come back into the library.
    void loadSavedScenes();
    // Provider status for the Providers page and the "Reconstruct with …" button.
    if (window.crashvzn?.providers) void useProvidersStore.getState().load();
    const api = window.crashvzn?.assistant;
    if (api) {
      const chat = useChatStore.getState();
      chat.setStatus("starting");
      void api
        .providers()
        .then((providers) => useChatStore.getState().setProviders(providers))
        .catch(() => {});
      void api
        .start({})
        .then((choice) => {
          useChatStore.getState().setChoice(choice);
          useChatStore.getState().setStatus("ready");
        })
        .catch(async (error) => {
          useChatStore.getState().setStatus("error", cleanIpcError(error));
          const choice = await api.choice().catch(() => null);
          if (choice) useChatStore.getState().setChoice(choice);
        });
    }
    return disconnect;
  }, []);

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-black">
      <div className="relative h-full min-w-0 flex-1 overflow-hidden">
        <Viewport />
        {view === "viewer" && (
          <>
            <SidePanel />
            <Timeline />
          </>
        )}
        {view === "home" && <HomeScreen dragOver={dragOver} />}
        {providersOpen && <ProvidersPage />}
      </div>
      <AssistantPanel />
    </div>
  );
}
