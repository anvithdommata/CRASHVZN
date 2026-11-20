import { appSceneController } from "@/assistant/sceneController";
import { DeleteSceneDialog } from "@/components/DeleteSceneDialog";
import { ResizeHandle } from "@/components/ResizeHandle";
import { Button, IconButton, Kbd, NumberField, Section, Tabs, TextInput, Toggle, readPref, writePref } from "@/components/ui";
import { cancelExport } from "@/lib/exportVideo";
import { formatClock } from "@/lib/time";
import type { CameraAdjustments } from "@/scene/camera";
import { describeEnvironment } from "@/scene/environment";
import { speedAt, toKmh, toMph } from "@/scene/liveSpeed";
import { LEFT_RAIL, useAppStore } from "@/store/useAppStore";
import { useProvidersStore } from "@/store/useProvidersStore";
import type { CameraPreset, Vec3 } from "@assistant/types";
import {
  ArrowLeft,
  Camera,
  Car,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CloudSun,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  Film,
  GripVertical,
  LocateFixed,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Route,
  Settings,
  SlidersHorizontal,
  Square,
  Trash2,
  Video,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type ReactNode } from "react";

const PRESETS: { id: CameraPreset; label: string }[] = [
  { id: "top", label: "Top" },
  { id: "iso", label: "Iso" },
  { id: "front", label: "Front" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "back", label: "Back" },
  { id: "dimetric", label: "Dimetric" },
  { id: "trimetric", label: "Trimetric" },
  { id: "bottom", label: "Bottom" },
];

type Tab = "scene" | "camera" | "notes" | "export";
const TAB_IDS = ["scene", "camera", "notes", "export"] as const;
const TAB_KEY = "crashvzn.leftTab";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "scene", label: "Scene", icon: <Car size={14} /> },
  { id: "camera", label: "Camera", icon: <Camera size={14} /> },
  { id: "notes", label: "Pins", icon: <MapPin size={14} /> },
  { id: "export", label: "Export", icon: <Download size={14} /> },
];

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

export function SidePanel() {
  const dragStartRef = useRef<{ pointerX: number; x: number } | null>(null);
  const dragXRef = useRef<number | null>(null);
  /** Panel offset while it is being dragged open or shut; null when not dragging. */
  const [dragX, setDragX] = useState<number | null>(null);
  const isDragging = dragX !== null;
  const isResizing = useAppStore((state) => state.resizing);
  const setIsResizing = useAppStore((state) => state.setResizing);
  const leftWidth = useAppStore((state) => state.leftWidth);
  const setLeftWidth = useAppStore((state) => state.setLeftWidth);
  const hiddenX = -(leftWidth - LEFT_RAIL);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [tab, setTabState] = useState<Tab>(() => readPref(TAB_KEY, TAB_IDS, "scene"));
  const [deleting, setDeleting] = useState<string | null>(null);
  const panelOpen = useAppStore((state) => state.panelOpen);
  const scene = useAppStore((state) => state.scenes.find((item) => item.id === state.selectedId));
  const playing = useAppStore((state) => state.playing);
  const impactTime = useAppStore((state) => state.impactTime);
  const layers = useAppStore((state) => state.layers);
  const togglePlay = useAppStore((state) => state.togglePlay);
  const jumpToImpact = useAppStore((state) => state.jumpToImpact);
  const resetCamera = useAppStore((state) => state.resetCamera);
  const setPanelOpen = useAppStore((state) => state.setPanelOpen);
  const closeScene = useAppStore((state) => state.closeScene);
  const setLayers = useAppStore((state) => state.setLayers);

  const setTab = (next: Tab) => {
    setTabState(next);
    writePref(TAB_KEY, next);
  };

  const run: Runner = async (action, success) => {
    try {
      const result = (await action()) as { clamped?: boolean } | undefined;
      if (result && typeof result === "object" && result.clamped) setNotice({ text: "Stopped at the edge of the scene.", error: false });
      else if (success) setNotice({ text: success, error: false });
      else setNotice(null);
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "That didn't work.", error: true });
    }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.error ? 6000 : 2500);
    return () => clearTimeout(timer);
  }, [notice]);

  const startPanelDrag = (event: ReactDragEvent<HTMLButtonElement>) => {
    const x = panelOpen ? 0 : hiddenX;
    dragStartRef.current = { pointerX: event.clientX, x };
    dragXRef.current = x;
    setDragX(x);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", "scene-panel");
  };

  const dragPanel = (event: ReactDragEvent<HTMLButtonElement>) => {
    const start = dragStartRef.current;
    if (!start || event.clientX === 0) return;
    const x = Math.min(0, Math.max(hiddenX, start.x + event.clientX - start.pointerX));
    dragXRef.current = x;
    setDragX(x);
  };

  const finishPanelDrag = () => {
    const start = dragStartRef.current;
    if (!start) return;
    setPanelOpen((dragXRef.current ?? start.x) > hiddenX / 2);
    dragStartRef.current = null;
    dragXRef.current = null;
    setDragX(null);
  };

  if (!scene) return null;

  return (
    <aside
      style={{ width: leftWidth, transform: `translateX(${dragX ?? (panelOpen ? 0 : hiddenX)}px)` }}
      className={`absolute inset-y-0 left-0 z-30 flex flex-col border-r border-line bg-panel/92 text-ink shadow-[4px_0_32px_rgba(0,0,0,0.45)] backdrop-blur-xl ${
        isDragging || isResizing ? "" : "transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]"
      }`}
    >
      {panelOpen && (
        <ResizeHandle edge="right" width={leftWidth} onResize={setLeftWidth} onResizingChange={setIsResizing} label="Resize the panel" dark />
      )}

      {/* Collapsed: a rail of shortcuts on the visible strip. */}
      {!panelOpen && (
        <div className="absolute inset-y-0 right-0 flex flex-col items-center gap-1 py-3" style={{ width: LEFT_RAIL }}>
          <button
            type="button"
            draggable
            className="grid h-9 w-9 place-items-center rounded-lg text-ink-2 hover:bg-white/8 hover:text-ink"
            aria-label="Show the panel"
            title="Show the panel"
            onClick={() => setPanelOpen(true)}
            onDragStart={startPanelDrag}
            onDrag={dragPanel}
            onDragEnd={finishPanelDrag}
          >
            <PanelLeftOpen size={18} />
          </button>
          <div className="my-1 h-px w-6 bg-line" />
          {TABS.map((item) => (
            <IconButton
              key={item.id}
              size={36}
              label={item.label}
              onClick={() => {
                setTab(item.id);
                setPanelOpen(true);
              }}
            >
              {item.icon}
            </IconButton>
          ))}
          <div className="flex-1" />
          <IconButton size={36} label={playing ? "Pause (Space)" : "Play (Space)"} onClick={togglePlay}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </IconButton>
          <IconButton size={36} label="Back to the library" onClick={closeScene}>
            <ArrowLeft size={16} />
          </IconButton>
        </div>
      )}

      {panelOpen && (
        <>
          <div className="flex items-center gap-1 px-2 pt-2.5">
            <button
              type="button"
              draggable
              aria-label="Drag the panel horizontally"
              title="Drag left or right to slide the panel"
              className="grid h-8 w-5 shrink-0 cursor-ew-resize place-items-center rounded text-ink-3 hover:bg-white/5"
              onDragStart={startPanelDrag}
              onDrag={dragPanel}
              onDragEnd={finishPanelDrag}
            >
              <GripVertical size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={closeScene}
              className="flex items-center gap-1.5 rounded-lg py-1.5 pr-2.5 pl-1.5 text-sm font-medium text-ink-2 hover:bg-white/8 hover:text-ink"
              title="Back to the library"
            >
              <ArrowLeft size={16} />
              Library
            </button>
            <div className="flex-1" />
            <IconButton label="Delete this reconstruction" onClick={() => setDeleting(scene.id)}>
              <Trash2 size={15} />
            </IconButton>
            {window.crashvzn?.providers && (
              <IconButton label="Providers: video processing and chat assistant" onClick={() => useProvidersStore.getState().setOpen(true)}>
                <Settings size={15} />
              </IconButton>
            )}
            <IconButton label="Hide the panel" onClick={() => setPanelOpen(false)}>
              <PanelLeftClose size={16} />
            </IconButton>
          </div>

          <div className="px-4 pt-2 pb-3">
            <h1 className="text-[17px] leading-tight font-semibold tracking-tight">{scene.title}</h1>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-3">
              <span className="inline-flex min-w-0 items-center gap-1">
                <MapPin size={12} className="shrink-0" />
                <span className="truncate">{scene.location}</span>
              </span>
              <span className="inline-flex min-w-0 items-center gap-1" title={scene.environmentSource ? `Read from ${scene.environmentSource}` : undefined}>
                <CloudSun size={12} className="shrink-0" />
                <span className="truncate">{describeEnvironment(scene.environment)}</span>
              </span>
            </div>
            {scene.impactTime != null && (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-crash-soft px-2.5 py-1 text-xs font-medium text-crash">
                <Zap size={12} />
                Crash {fmt(scene.impactTime)}–{fmt(scene.crashEnd ?? scene.impactTime)} s of {formatClock(scene.duration)}
              </div>
            )}
          </div>

          <div className="grid grid-cols-4 gap-1.5 px-4 pb-3">
            <QuickAction icon={playing ? <Pause size={16} /> : <Play size={16} />} label={playing ? "Pause" : "Play"} hint="Space" onClick={togglePlay} primary />
            <QuickAction icon={<Zap size={16} />} label="Crash" onClick={jumpToImpact} disabled={impactTime == null} crash />
            <QuickAction icon={<LocateFixed size={16} />} label="Fit" onClick={resetCamera} hint="Reset the camera" />
            <QuickAction
              icon={<Film size={16} />}
              label="Footage"
              active={layers.sourceVideo}
              onClick={() => setLayers({ sourceVideo: !layers.sourceVideo })}
              disabled={!scene.sourceVideo}
              hint={scene.sourceVideo ? "Original footage, synced to the timeline" : "No source video for this reconstruction"}
            />
          </div>

          <div className="px-4 pb-3">
            <Tabs label="Panel sections" tabs={TABS} value={tab} onChange={setTab} />
          </div>

          {notice && (
            <p
              role="status"
              className={`mx-4 mb-3 rounded-lg px-3 py-2 text-xs ${notice.error ? "bg-crash-soft text-crash" : "bg-accent-soft text-accent"}`}
            >
              {notice.text}
            </p>
          )}

          <div key={tab} className="animate-panel-in flex-1 overflow-y-auto px-4 pb-6">
            {tab === "scene" && <SceneTab run={run} />}
            {tab === "camera" && <CameraTab run={run} />}
            {tab === "notes" && <MarkersSection run={run} />}
            {tab === "export" && <ExportControls duration={scene.duration} run={run} />}
          </div>
        </>
      )}

      <DeleteSceneDialog sceneId={deleting} onClose={() => setDeleting(null)} />
    </aside>
  );
}

type Runner = (action: () => Promise<unknown>, success?: string) => Promise<void>;

function QuickAction({
  icon,
  label,
  onClick,
  disabled = false,
  hint,
  primary = false,
  crash = false,
  active = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  hint?: string;
  primary?: boolean;
  crash?: boolean;
  active?: boolean;
}) {
  const tone = primary || active ? "bg-accent-strong text-white hover:bg-accent" : crash ? "bg-crash-soft text-crash hover:bg-crash/20" : "bg-white/6 text-ink-2 hover:bg-white/10 hover:text-ink";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={hint ? `${label} — ${hint}` : label}
      aria-pressed={active || undefined}
      className={`flex flex-col items-center gap-1 rounded-xl py-2 text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-35 ${tone}`}
    >
      {icon}
      {label}
    </button>
  );
}

/* ───────────────────────── Scene ───────────────────────── */

function SceneTab({ run }: { run: Runner }) {
  const scene = useAppStore((state) => state.scenes.find((item) => item.id === state.selectedId));
  const layers = useAppStore((state) => state.layers);
  const cameraMode = useAppStore((state) => state.cameraMode);
  const setLayers = useAppStore((state) => state.setLayers);
  const setVehicleHidden = useAppStore((state) => state.setVehicleHidden);
  if (!scene) return null;
  const following = cameraMode.kind === "follow" ? cameraMode.entityId : null;
  const pov = cameraMode.kind === "pov" ? cameraMode.entityId : null;
  const crashSet = new Set(scene.crashVehicles ?? []);
  // Vehicles in the crash first.
  const vehicles = [...scene.vehicles].sort((a, b) => Number(crashSet.has(b.id)) - Number(crashSet.has(a.id)));

  return (
    <>
      <Section title={`Vehicles${vehicles.length ? ` · ${vehicles.length}` : ""}`} flush>
        {vehicles.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs text-ink-3">
            {scene.kind === "splat" ? "A Gaussian splat has no tracked vehicles." : "No vehicles in this reconstruction."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {vehicles.map((vehicle) => {
              const hidden = layers.hiddenVehicles.includes(vehicle.id);
              const inCrash = crashSet.has(vehicle.id);
              return (
                <li
                  key={vehicle.id}
                  className={`group relative overflow-hidden rounded-xl border bg-raised/70 py-2 pr-2 pl-3.5 transition-colors ${
                    following === vehicle.id || pov === vehicle.id ? "border-accent/60" : "border-line hover:border-line-strong"
                  } ${hidden ? "opacity-55" : ""}`}
                >
                  <span className="absolute inset-y-0 left-0 w-1" style={{ background: vehicle.color }} aria-hidden />
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`truncate text-sm font-medium ${hidden ? "line-through" : ""}`}>{vehicle.label}</span>
                        {inCrash && <span className="shrink-0 rounded bg-crash-soft px-1.5 py-px text-[10px] font-semibold text-crash">CRASH</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-ink-3 capitalize">{vehicle.type}</div>
                    </div>
                    <LiveSpeed sceneId={scene.id} vehicleId={vehicle.id} />
                  </div>
                  <div className="mt-1.5 flex gap-0.5">
                    <IconButton label={`Zoom in on the ${vehicle.label}`} onClick={() => void run(() => appSceneController.focus(vehicle.id))}>
                      <Crosshair size={14} />
                    </IconButton>
                    <IconButton
                      label={following === vehicle.id ? "Stop following" : `Follow the ${vehicle.label}`}
                      active={following === vehicle.id}
                      onClick={() => void run(() => appSceneController.follow(following === vehicle.id ? null : vehicle.id))}
                    >
                      <LocateFixed size={14} />
                    </IconButton>
                    <IconButton
                      label={pov === vehicle.id ? "Leave the driver's-eye view" : `Driver's-eye view from the ${vehicle.label}`}
                      active={pov === vehicle.id}
                      onClick={() => void run(() => appSceneController.pov(pov === vehicle.id ? null : vehicle.id))}
                    >
                      <Video size={14} />
                    </IconButton>
                    <div className="flex-1" />
                    <IconButton label={hidden ? `Show the ${vehicle.label}` : `Hide the ${vehicle.label}`} onClick={() => setVehicleHidden(vehicle.id, !hidden)}>
                      {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </IconButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Overlays" flush>
        <div className="rounded-xl border border-line bg-raised/50 p-1">
          <Toggle icon={<Route size={15} />} label="Vehicle paths" checked={layers.trails} disabled={scene.vehicles.length === 0} onChange={(trails) => setLayers({ trails })} />
          <Toggle icon={<Square size={15} />} label="Scene boundary" checked={layers.bounds} onChange={(bounds) => setLayers({ bounds })} />
          <Toggle icon={<Crosshair size={15} />} label="Vehicle hitboxes" checked={layers.hitboxes} disabled={scene.vehicles.length === 0} onChange={(hitboxes) => setLayers({ hitboxes })} />
          <Toggle
            icon={<Film size={15} />}
            label="Original footage"
            checked={layers.sourceVideo}
            disabled={!scene.sourceVideo}
            onChange={(sourceVideo) => setLayers({ sourceVideo })}
          />
        </div>
      </Section>
    </>
  );
}

/** Speed at the playhead, read off the trajectory. Its own component so only it re-renders during playback. */
function LiveSpeed({ sceneId, vehicleId }: { sceneId: string; vehicleId: string }) {
  const time = useAppStore((state) => state.time);
  const mps = speedAt(sceneId, vehicleId, time);
  if (mps == null) return <span className="shrink-0 text-[11px] text-ink-3">not in view</span>;
  return (
    <span className="shrink-0 text-right leading-none" title={`${toKmh(mps).toFixed(0)} km/h · ${mps.toFixed(1)} m/s at ${time.toFixed(1)} s (estimate from the reconstruction)`}>
      <span className="text-base font-semibold tabular-nums">{toMph(mps).toFixed(0)}</span>
      <span className="ml-0.5 text-[10px] text-ink-3">mph</span>
    </span>
  );
}

/* ───────────────────────── Camera ───────────────────────── */

function CameraTab({ run }: { run: Runner }) {
  const cameraAdjustments = useAppStore((state) => state.cameraAdjustments);
  const applyCameraAdjustments = useAppStore((state) => state.applyCameraAdjustments);
  const resetCamera = useAppStore((state) => state.resetCamera);
  const [advanced, setAdvanced] = useState(() => readPref("crashvzn.cameraAdvanced", ["open", "closed"] as const, "closed") === "open");
  const [degrees, setDegrees] = useState(30);
  const [meters, setMeters] = useState(5);
  const deg = Number.isFinite(degrees) ? degrees : 0;
  const m = Number.isFinite(meters) ? meters : 0;

  const updateCamera = (field: keyof CameraAdjustments, value: number) => {
    if (!Number.isFinite(value)) return;
    applyCameraAdjustments({ ...cameraAdjustments, [field]: value });
  };

  return (
    <>
      <Section title="Views" flush>
        <div className="grid grid-cols-3 gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => void run(() => appSceneController.preset(preset.id))}
              className="group flex flex-col items-center gap-1 rounded-xl border border-line bg-raised/60 py-2.5 text-[11px] font-medium text-ink-2 transition-colors hover:border-accent/60 hover:text-ink"
            >
              <ViewGlyph preset={preset.id} />
              {preset.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Nudge" flush>
        <div className="space-y-2 rounded-xl border border-line bg-raised/50 p-3">
          <div className="flex items-end gap-2">
            <NumberField label="Orbit by (°)" value={degrees} step="1" onCommit={setDegrees} live />
            <div className="flex gap-0.5 pb-0.5">
              <IconButton label={`Orbit ${deg}° left`} onClick={() => void run(() => appSceneController.orbit(-deg, 0))}>
                <RotateCcw size={14} />
              </IconButton>
              <IconButton label={`Orbit ${deg}° right`} onClick={() => void run(() => appSceneController.orbit(deg, 0))}>
                <RotateCw size={14} />
              </IconButton>
              <IconButton label={`Orbit ${deg}° higher`} onClick={() => void run(() => appSceneController.orbit(0, deg))}>
                <ChevronUp size={14} />
              </IconButton>
              <IconButton label={`Orbit ${deg}° lower`} onClick={() => void run(() => appSceneController.orbit(0, -deg))}>
                <ChevronDown size={14} />
              </IconButton>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <NumberField label="Move by (m)" value={meters} step="0.5" onCommit={setMeters} live />
            <div className="flex gap-0.5 pb-0.5">
              <IconButton label={`Move ${m} m left`} onClick={() => void run(() => appSceneController.move(-m, 0, 0))}>
                <ChevronLeft size={14} />
              </IconButton>
              <IconButton label={`Move ${m} m right`} onClick={() => void run(() => appSceneController.move(m, 0, 0))}>
                <ChevronRight size={14} />
              </IconButton>
              <IconButton label={`Move ${m} m up`} onClick={() => void run(() => appSceneController.move(0, m, 0))}>
                <ChevronUp size={14} />
              </IconButton>
              <IconButton label={`Move ${m} m down`} onClick={() => void run(() => appSceneController.move(0, -m, 0))}>
                <ChevronDown size={14} />
              </IconButton>
              <IconButton label={`Move ${m} m forward`} onClick={() => void run(() => appSceneController.move(0, 0, m))}>
                <Plus size={14} />
              </IconButton>
            </div>
          </div>
        </div>
      </Section>

      <button
        type="button"
        aria-expanded={advanced}
        onClick={() => {
          setAdvanced(!advanced);
          writePref("crashvzn.cameraAdvanced", advanced ? "closed" : "open");
        }}
        className="mb-2 flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase hover:text-ink-2"
      >
        <SlidersHorizontal size={13} />
        Advanced
        <span className="flex-1" />
        <ChevronDown size={14} className={`transition-transform ${advanced ? "rotate-180" : ""}`} />
      </button>

      {advanced && (
        <div className="animate-panel-in">
          <Section
            title="Offset from base view"
            action={
              <Button variant="soft" onClick={resetCamera}>
                Reset
              </Button>
            }
          >
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Pan X (m)" value={cameraAdjustments.panX} step="0.1" onCommit={(value) => updateCamera("panX", value)} />
              <NumberField label="Pan Y (m)" value={cameraAdjustments.panY} step="0.1" onCommit={(value) => updateCamera("panY", value)} />
              <NumberField label="Pan Z (m)" value={cameraAdjustments.panZ} step="0.1" onCommit={(value) => updateCamera("panZ", value)} />
              <NumberField label="Zoom (×)" value={cameraAdjustments.zoom} step="0.01" min="0.1" onCommit={(value) => updateCamera("zoom", value)} />
              <NumberField label="Tilt (°)" value={cameraAdjustments.tilt} step="0.1" onCommit={(value) => updateCamera("tilt", value)} />
              <NumberField label="Rotate (°)" value={cameraAdjustments.rotate} step="0.1" onCommit={(value) => updateCamera("rotate", value)} />
            </div>
          </Section>
          <PlaceCamera run={run} />
        </div>
      )}
    </>
  );
}

/** Plan-view glyph for each standard view: which side the camera looks from. */
function ViewGlyph({ preset }: { preset: CameraPreset }) {
  const stroke = "currentColor";
  const hi = "var(--color-accent)";
  const cube = (top: string, left: string, right: string) => (
    <>
      <path d={top} fill={hi} fillOpacity="0.35" stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" />
      <path d={left} fill={stroke} fillOpacity="0.08" stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" />
      <path d={right} fill={stroke} fillOpacity="0.18" stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" />
    </>
  );
  const sides: Partial<Record<CameraPreset, [number, number, number, number]>> = {
    front: [5, 17, 17, 17],
    back: [5, 5, 17, 5],
    left: [5, 5, 5, 17],
    right: [17, 5, 17, 17],
  };
  const edge = sides[preset];
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden className="text-ink-2 group-hover:text-ink">
      {preset === "iso" && cube("M11 3 18 7 11 11 4 7Z", "M4 7 11 11 11 19 4 15Z", "M11 11 18 7 18 15 11 19Z")}
      {preset === "dimetric" && cube("M11 4 18 7 11 10 4 7Z", "M4 7 11 10 11 19 4 16Z", "M11 10 18 7 18 16 11 19Z")}
      {preset === "trimetric" && cube("M9 4 19 6 12 10 3 8Z", "M3 8 12 10 12 19 3 17Z", "M12 10 19 6 19 15 12 19Z")}
      {preset === "top" && <rect x="5" y="5" width="12" height="12" rx="1.5" fill={hi} fillOpacity="0.35" stroke={stroke} strokeWidth="1.2" />}
      {preset === "bottom" && <rect x="5" y="5" width="12" height="12" rx="1.5" stroke={stroke} strokeWidth="1.2" strokeDasharray="2 2" />}
      {edge && (
        <>
          <rect x="5" y="5" width="12" height="12" rx="1.5" stroke={stroke} strokeOpacity="0.45" strokeWidth="1.2" />
          <line x1={edge[0]} y1={edge[1]} x2={edge[2]} y2={edge[3]} stroke={hi} strokeWidth="2.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

function PlaceCamera({ run }: { run: Runner }) {
  const [position, setPosition] = useState<Vec3>([0, 20, 30]);
  const [target, setTarget] = useState<Vec3>([0, 0, 0]);

  const loadCurrent = async () => {
    const state = await appSceneController.describe();
    setPosition(state.camera.position);
    setTarget(state.camera.target);
  };

  return (
    <Section title="Exact placement">
      <p className="mb-2 text-[11px] leading-relaxed text-ink-3">Meters from the crash point: +x east, +y up, −z north.</p>
      <div className="grid grid-cols-3 gap-2">
        {(["x", "y", "z"] as const).map((axis, i) => (
          <NumberField key={`p${axis}`} label={`Camera ${axis}`} value={position[i]} step="0.5" live onCommit={(v) => setPosition((p) => p.map((q, j) => (j === i ? v : q)) as Vec3)} />
        ))}
        {(["x", "y", "z"] as const).map((axis, i) => (
          <NumberField key={`t${axis}`} label={`Look at ${axis}`} value={target[i]} step="0.5" live onCommit={(v) => setTarget((p) => p.map((q, j) => (j === i ? v : q)) as Vec3)} />
        ))}
      </div>
      <div className="mt-2.5 flex gap-2">
        <Button variant="primary" onClick={() => void run(() => appSceneController.setCamera({ position, target }))}>
          Place camera
        </Button>
        <Button variant="soft" onClick={() => void run(loadCurrent)}>
          Use current
        </Button>
      </div>
    </Section>
  );
}

/* ───────────────────────── Pins ───────────────────────── */

function MarkersSection({ run }: { run: Runner }) {
  const markers = useAppStore((state) => state.markers);
  const removeMarker = useAppStore((state) => state.removeMarker);
  const [label, setLabel] = useState("");
  const add = () =>
    run(async () => {
      const text = label.trim() || `Pin ${markers.length + 1}`;
      const state = await appSceneController.describe();
      const point: Vec3 = [state.camera.target[0], 0, state.camera.target[2]];
      await appSceneController.addMarker(text, { point });
      setLabel("");
    });
  return (
    <Section title="Pins" flush>
      <div className="flex gap-2">
        <TextInput
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void add();
          }}
          placeholder="Label for a pin at the view centre"
          className="flex-1"
        />
        <Button variant="primary" onClick={() => void add()}>
          <MapPin size={13} />
          Drop
        </Button>
      </div>
      {markers.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-line px-3 py-4 text-center text-xs leading-relaxed text-ink-3">
          Pins mark points of interest, like a skid mark or the point of impact. Centre the view on a spot and drop one.
        </p>
      ) : (
        <ul className="mt-3 space-y-1">
          {markers.map((marker) => (
            <li key={marker.id} className="flex items-center gap-2 rounded-lg border border-line bg-raised/60 px-2.5 py-1.5 text-sm">
              <MapPin size={14} className="shrink-0 text-warn" />
              <span className="min-w-0 flex-1 truncate">{marker.label}</span>
              {marker.entityId && <span className="text-xs text-ink-3">on {marker.entityId}</span>}
              <IconButton label={`Remove ${marker.label}`} onClick={() => removeMarker(marker.id)}>
                <Trash2 size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* ───────────────────────── Export ───────────────────────── */

function ExportControls({ duration, run }: { duration: number; run: Runner }) {
  const job = useAppStore((state) => state.exportJob);
  const impactTime = useAppStore((state) => state.impactTime);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(duration);
  useEffect(() => {
    setStart(0);
    setEnd(duration);
  }, [duration]);
  const busy = job?.status === "rendering" || job?.status === "saving";
  const ranges: { label: string; range: [number, number] }[] = [
    { label: "Whole scene", range: [0, duration] },
    ...(impactTime != null
      ? [{ label: "Crash ±3 s", range: [Math.max(0, impactTime - 3), Math.min(duration, impactTime + 3)] as [number, number] }]
      : []),
  ];
  return (
    <Section title="Export video" flush>
      <div className="rounded-xl border border-line bg-raised/50 p-3">
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {ranges.map((item) => {
            const selected = Math.abs(start - item.range[0]) < 0.01 && Math.abs(end - item.range[1]) < 0.01;
            return (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setStart(item.range[0]);
                  setEnd(item.range[1]);
                }}
                className={`rounded-full border px-2.5 py-1 text-xs ${selected ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2 hover:border-line-strong"}`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-end gap-2">
          <NumberField label="From (s)" value={start} step="0.1" live onCommit={setStart} />
          <NumberField label="To (s)" value={end} step="0.1" live onCommit={setEnd} />
        </div>
        <div className="mt-3">
          {busy ? (
            <Button variant="danger" size="md" className="w-full" onClick={cancelExport}>
              Cancel export
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              className="w-full"
              onClick={() => void run(() => appSceneController.exportVideo({ range: [start, end] }), "Recording the export. It plays through once in real time.")}
            >
              <Download size={15} />
              Export {fmt(Math.max(0, end - start))} s
            </Button>
          )}
        </div>
        {job && (
          <div className="mt-3 text-xs text-ink-2">
            {job.status === "rendering" && (
              <>
                <div className="mb-1 flex justify-between">
                  <span>Recording…</span>
                  <span className="tabular-nums">{Math.round(job.progress * 100)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${job.progress * 100}%` }} />
                </div>
              </>
            )}
            {job.status === "saving" && "Saving…"}
            {job.status === "done" && <span className="break-all text-ok">Saved {job.path}</span>}
            {job.status === "cancelled" && "Export cancelled."}
            {job.status === "error" && <span className="text-crash">Export failed: {job.error}</span>}
          </div>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
        Every frame is watermarked as a demonstrative reconstruction, not original footage. Tip: <Kbd>Space</Kbd> plays, <Kbd>←</Kbd> <Kbd>→</Kbd> step 0.1 s.
      </p>
    </Section>
  );
}
