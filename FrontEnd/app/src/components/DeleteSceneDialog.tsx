import { Button } from "@/components/ui";
import { deleteEffect, deleteScene } from "@/lib/deleteScene";
import { useAppStore } from "@/store/useAppStore";
import { Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Confirms deleting (or hiding) one reconstruction. Render it with the scene id, or null for closed. */
export function DeleteSceneDialog({ sceneId, onClose }: { sceneId: string | null; onClose: () => void }) {
  const scene = useAppStore((state) => state.scenes.find((item) => item.id === sceneId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Parents pass an inline callback; keep the effect below from re-running (and resetting) on every render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!sceneId) return;
    setError(null);
    setBusy(false);
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sceneId]);

  if (!sceneId || !scene) return null;
  const effect = deleteEffect(sceneId);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteScene(sceneId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that reconstruction.");
      setBusy(false);
    }
  };

  // Portalled: the scene panel is transformed, which would trap a fixed overlay inside it.
  return createPortal(
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-scene-title"
        aria-describedby="delete-scene-detail"
        className="animate-panel-in w-full max-w-[420px] rounded-2xl border border-line bg-panel p-5 text-ink shadow-2xl"
      >
        <div className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-crash-soft text-crash">
          <Trash2 size={18} />
        </div>
        <h2 id="delete-scene-title" className="text-base font-semibold">
          {effect.verb} “{scene.title}”?
        </h2>
        <p id="delete-scene-detail" className="mt-1.5 text-sm leading-relaxed text-ink-2">
          {effect.detail}
        </p>
        {error && <p className="mt-3 rounded-lg bg-crash-soft px-3 py-2 text-xs text-crash">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant="ghost" size="md" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" size="md" onClick={() => void confirm()} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {effect.verb}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
