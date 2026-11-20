import { DeleteSceneDialog } from "@/components/DeleteSceneDialog";
import { SceneArt } from "@/components/SceneArt";
import { BrandMark, Button, IconButton } from "@/components/ui";
import type { SceneInfo } from "@/data/scenes";
import { formatDuration, useAnalysisEta } from "@/incident/eta";
import { reconstructFootage } from "@/incident/reconstruct";
import { ingestFiles } from "@/lib/ingest";
import { formatBytes, formatClock } from "@/lib/time";
import { describeEnvironment } from "@/scene/environment";
import { useAppStore } from "@/store/useAppStore";
import { processorName, useProvidersStore } from "@/store/useProvidersStore";
import {
  ArrowRight,
  Car,
  Check,
  Clock,
  CloudSun,
  Film,
  HardDriveUpload,
  Layers,
  Loader2,
  MapPin,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

/** The library: a featured reconstruction, the drop zone / pipeline, then every reconstruction as a tile. */
export function HomeScreen({ dragOver }: { dragOver: boolean }) {
  const scenes = useAppStore((state) => state.scenes);
  const uploads = useAppStore((state) => state.uploads);
  const search = useAppStore((state) => state.search);
  const homeFolder = useAppStore((state) => state.homeFolder);
  const setSearch = useAppStore((state) => state.setSearch);
  const setHomeFolder = useAppStore((state) => state.setHomeFolder);
  const openScene = useAppStore((state) => state.openScene);
  const hiddenBuiltinCount = useAppStore((state) => state.hiddenBuiltinCount);
  const restoreBuiltins = useAppStore((state) => state.restoreBuiltins);
  const openProviders = useProvidersStore((state) => state.setOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const [crashOnly, setCrashOnly] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const folders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const scene of scenes) counts.set(scene.folder, (counts.get(scene.folder) ?? 0) + 1);
    return [...counts.entries()];
  }, [scenes]);

  const query = search.trim().toLowerCase();
  const visible = scenes.filter((scene) => {
    if (homeFolder && scene.folder !== homeFolder) return false;
    if (crashOnly && scene.impactTime == null) return false;
    if (!query) return true;
    return [scene.title, scene.location, scene.detail, scene.folder].some((text) => text.toLowerCase().includes(query));
  });
  // Featured: the newest reconstruction that has a crash in it.
  const featured = useMemo(
    () => [...scenes].filter((scene) => scene.impactTime != null && scene.kind === "proxy").sort((a, b) => b.created.localeCompare(a.created))[0] ?? scenes[0],
    [scenes],
  );
  const filtering = Boolean(query || homeFolder || crashOnly);
  const pickFiles = () => inputRef.current?.click();

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-canvas text-ink">
      {/* Soft glow behind the header. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(60%_100%_at_30%_0%,rgba(79,140,255,0.16),transparent)]" />

      <header className="relative flex items-center gap-4 border-b border-line px-6 py-3">
        <div className="flex items-center gap-2.5">
          <BrandMark />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight">CRASHVZN</div>
            <div className="text-[11px] text-ink-3">Incident reconstruction</div>
          </div>
        </div>
        <label className="mx-auto flex w-full max-w-[520px] items-center gap-2 rounded-xl border border-line bg-white/4 px-3.5 py-2 focus-within:border-accent/60 focus-within:bg-white/6">
          <Search size={16} className="text-ink-3" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by title, location or folder"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="text-ink-3 hover:text-ink">
              <X size={15} />
            </button>
          )}
        </label>
        {window.crashvzn?.providers && (
          <IconButton size={36} label="Providers: video processing and chat assistant" onClick={() => openProviders(true)}>
            <Settings size={17} />
          </IconButton>
        )}
        <Button variant="primary" size="md" onClick={pickFiles}>
          <Upload size={15} />
          New upload
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          accept="video/*,.spz,.ply,.splat,.ksplat,.sog,.zip"
          onChange={(event) => {
            if (event.target.files?.length) void ingestFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </header>

      <div className="relative flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1280px] px-6 pt-6 pb-12">
          {!filtering && (
            <div className="mb-8 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
              {featured ? <FeaturedCard scene={featured} onOpen={() => openScene(featured.id)} /> : <EmptyLibrary onUpload={pickFiles} />}
              {uploads.length > 0 ? <Pipeline /> : <DropZone active={dragOver} onClick={pickFiles} />}
            </div>
          )}
          {filtering && dragOver && (
            <div className="mb-6">
              <DropZone active onClick={pickFiles} compact />
            </div>
          )}
          {filtering && uploads.length > 0 && (
            <div className="mb-6 max-w-[640px]">
              <Pipeline />
            </div>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <h2 className="mr-2 text-lg font-semibold tracking-tight">{homeFolder ?? "All reconstructions"}</h2>
            <Chip active={homeFolder === null} onClick={() => setHomeFolder(null)} count={scenes.length}>
              All
            </Chip>
            {folders.map(([name, count]) => (
              <Chip key={name} active={homeFolder === name} onClick={() => setHomeFolder(homeFolder === name ? null : name)} count={count}>
                {name}
              </Chip>
            ))}
            <span className="mx-1 h-4 w-px bg-line" />
            <Chip active={crashOnly} onClick={() => setCrashOnly(!crashOnly)} tone="crash">
              <Zap size={12} />
              Has crash
            </Chip>
            <span className="flex-1" />
            {hiddenBuiltinCount > 0 && (
              <button type="button" onClick={restoreBuiltins} className="inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink">
                <RotateCcw size={12} />
                Restore {hiddenBuiltinCount} hidden example{hiddenBuiltinCount === 1 ? "" : "s"}
              </button>
            )}
          </div>

          {visible.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-3">
              {query ? "No reconstructions match that search." : scenes.length ? "Nothing here with these filters." : "The library is empty. Upload footage or a splat file to add one."}
            </p>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
              {visible.map((scene) => (
                <li key={scene.id}>
                  <SceneTile scene={scene} onOpen={() => openScene(scene.id)} onDelete={() => setDeleting(scene.id)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <DeleteSceneDialog sceneId={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function Chip({
  active,
  onClick,
  count,
  tone = "accent",
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  tone?: "accent" | "crash";
  children: ReactNode;
}) {
  const on = tone === "crash" ? "border-crash/50 bg-crash-soft text-crash" : "border-accent/50 bg-accent-soft text-accent";
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active ? on : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
      }`}
    >
      {children}
      {count != null && <span className={active ? "opacity-80" : "text-ink-3"}>{count}</span>}
    </button>
  );
}

function SceneStats({ scene }: { scene: SceneInfo }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-ink-2">
        <Clock size={11} />
        {formatClock(scene.duration)}
      </span>
      <span className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-ink-2">
        {scene.kind === "splat" ? <Layers size={11} /> : <Car size={11} />}
        {scene.kind === "splat" ? "Splat" : `${scene.vehicles.length} vehicle${scene.vehicles.length === 1 ? "" : "s"}`}
      </span>
      {scene.impactTime != null && (
        <span className="inline-flex items-center gap-1 rounded-md bg-crash-soft px-1.5 py-0.5 font-medium text-crash">
          <Zap size={11} />
          Crash at {scene.impactTime.toFixed(1)} s
        </span>
      )}
      {scene.sourceVideo && (
        <span className="inline-flex items-center gap-1 rounded-md bg-white/6 px-1.5 py-0.5 text-ink-2" title={scene.sourceVideo.name}>
          <Film size={11} />
          Footage
        </span>
      )}
    </div>
  );
}

function Thumb({ scene, tall = false }: { scene: SceneInfo; tall?: boolean }) {
  return (
    <div className={`overflow-hidden bg-[#1c2128] [&>svg]:!h-full ${tall ? "h-full min-h-[260px]" : "h-[150px]"}`}>
      {scene.kind === "splat" ? (
        <div className="grid h-full place-items-center text-ink-3">
          <Layers size={tall ? 56 : 36} />
        </div>
      ) : (
        <SceneArt sceneId={scene.id} large />
      )}
    </div>
  );
}

function FeaturedCard({ scene, onOpen }: { scene: SceneInfo; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative overflow-hidden rounded-2xl border border-line text-left transition-colors hover:border-accent/50"
    >
      <div className="absolute inset-0 transition-transform duration-500 group-hover:scale-[1.02]">
        <Thumb scene={scene} tall />
      </div>
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent" />
      <div className="relative flex h-full min-h-[260px] flex-col justify-end p-5">
        <span className="mb-2 w-fit rounded-full border border-white/15 bg-black/40 px-2 py-0.5 text-[10px] font-semibold tracking-[0.1em] text-white/80 uppercase backdrop-blur">
          Latest crash
        </span>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{scene.title}</h1>
        <div className="mt-1 mb-3 flex items-center gap-1 text-sm text-white/65">
          <MapPin size={13} />
          {scene.location}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SceneStats scene={scene} />
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-black transition-transform group-hover:translate-x-0.5">
            Open
            <ArrowRight size={15} />
          </span>
        </div>
      </div>
    </button>
  );
}

function SceneTile({ scene, onOpen, onDelete }: { scene: SceneInfo; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className="w-full overflow-hidden rounded-2xl border border-line bg-panel text-left transition-[border-color,transform] hover:-translate-y-0.5 hover:border-accent/50"
      >
        <Thumb scene={scene} />
        <div className="p-3.5">
          <div className="truncate pr-6 text-[15px] font-medium">{scene.title}</div>
          <div className="mt-0.5 mb-2.5 flex items-center gap-1 text-xs text-ink-3">
            <MapPin size={11} className="shrink-0" />
            <span className="truncate">{scene.location}</span>
          </div>
          <SceneStats scene={scene} />
        </div>
      </button>
      <button
        type="button"
        aria-label={`Delete ${scene.title}`}
        title="Delete this reconstruction"
        onClick={onDelete}
        className="absolute top-2 right-2 grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-black/60 text-white/80 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 hover:bg-crash hover:text-white focus-visible:opacity-100"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function DropZone({ active, onClick, compact = false }: { active: boolean; onClick: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 text-center transition-colors ${
        compact ? "py-6" : "min-h-[260px] py-8"
      } ${active ? "border-accent bg-accent-soft" : "border-line-strong bg-white/[0.02] hover:border-accent/60 hover:bg-white/[0.04]"}`}
    >
      <div className={`grid h-12 w-12 place-items-center rounded-2xl ${active ? "bg-accent text-white" : "bg-white/6 text-accent"}`}>
        <HardDriveUpload size={22} />
      </div>
      <div>
        <div className="text-base font-semibold">{active ? "Drop to add" : "Drop footage to reconstruct"}</div>
        <div className="mt-1 text-xs leading-relaxed text-ink-3">
          Up to 4 camera angles of one incident (.mp4, .mov…), or a splat (.spz, .ply) to view right away.
        </div>
      </div>
      {!active && <span className="text-xs font-medium text-accent">or click to browse</span>}
    </button>
  );
}

function EmptyLibrary({ onUpload }: { onUpload: () => void }) {
  return (
    <div className="flex min-h-[260px] flex-col items-start justify-end rounded-2xl border border-line bg-panel p-6">
      <BrandMark size={40} />
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">No reconstructions yet</h1>
      <p className="mt-1 mb-4 max-w-[420px] text-sm text-ink-2">Upload dashcam or traffic-camera footage and CRASHVZN rebuilds the scene in 3D.</p>
      <Button variant="primary" size="md" onClick={onUpload}>
        <Upload size={15} />
        Upload footage
      </Button>
    </div>
  );
}

type Step = { label: string; state: "done" | "active" | "todo" | "error"; detail?: string };

/** The upload queue as a pipeline: environment read → staged → reconstructed. */
function Pipeline() {
  const uploads = useAppStore((state) => state.uploads);
  const removeUpload = useAppStore((state) => state.removeUpload);
  const analysisJob = useAppStore((state) => state.analysisJob);
  const openScene = useAppStore((state) => state.openScene);
  const providerStatus = useProvidersStore((state) => state.status);
  const processor = processorName(providerStatus);
  const eta = useAnalysisEta();
  const running = analysisJob.state === "running";
  /** Copying queued videos into app data: never run, in progress, finished, or failed. */
  const [staging, setStaging] = useState<
    { state: "idle" } | { state: "copying" } | { state: "done"; message: string } | { state: "failed"; message: string }
  >({ state: "idle" });

  const stageUploads = async () => {
    if (!window.crashvzn?.stageVideos) {
      setStaging({ state: "failed", message: "Local video staging is available in the Electron desktop app." });
      return;
    }
    setStaging({ state: "copying" });
    try {
      const incident = await window.crashvzn.stageVideos(uploads.map((upload) => upload.file));
      setStaging({
        state: "done",
        message: `Incident ${incident.incidentId.slice(0, 8)} · ${incident.videos.length} video${incident.videos.length === 1 ? "" : "s"} copied and hashed.`,
      });
    } catch (error) {
      setStaging({ state: "failed", message: error instanceof Error ? `Could not stage footage: ${error.message}` : "Could not stage footage." });
    }
  };

  const analysed = uploads.filter((upload) => upload.analysis.state === "done").length;
  const analysing = uploads.some((upload) => upload.analysis.state === "analyzing");
  const steps: Step[] = [
    {
      label: "Environment",
      state: analysing ? "active" : analysed === uploads.length ? "done" : "error",
      detail: `${analysed}/${uploads.length} read`,
    },
    {
      label: "Staged",
      state: staging.state === "done" ? "done" : staging.state === "copying" ? "active" : staging.state === "failed" ? "error" : "todo",
      detail: staging.state === "done" ? "Hashed" : staging.state === "copying" ? "Copying…" : "Optional",
    },
    {
      label: "Reconstructed",
      state: analysisJob.state === "done" ? "done" : running ? "active" : analysisJob.state === "error" ? "error" : "todo",
      detail: running ? analysisJob.stage : analysisJob.state === "done" ? "Ready" : analysisJob.state === "error" ? "Failed" : processor,
    },
  ];

  return (
    <section className="flex min-h-[260px] flex-col rounded-2xl border border-line bg-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 uppercase">Upload queue · {uploads.length}</h2>
      </div>

      <ol className="mb-3 grid grid-cols-3 gap-2">
        {steps.map((step) => (
          <li key={step.label} className="rounded-xl border border-line bg-raised/60 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <StepDot state={step.state} />
              {step.label}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-ink-3" title={step.detail}>
              {step.detail}
            </div>
          </li>
        ))}
      </ol>

      {running && (
        <div className="mb-3 text-xs text-ink-2" role="status" aria-live="polite">
          {analysisJob.stage}
          {analysisJob.detail ? ` · ${analysisJob.detail}` : ""}
          {eta && (
            <>
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10"
                role="progressbar"
                aria-label="Reconstruction progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(eta.fraction * 100)}
              >
                <div className="h-full rounded-full bg-accent transition-[width] duration-1000 ease-linear" style={{ width: `${eta.fraction * 100}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-ink-3">
                <span>{formatDuration(eta.elapsedS)} elapsed</span>
                <span>Time remaining is unknown</span>
              </div>
            </>
          )}
        </div>
      )}
      {analysisJob.state === "done" && (
        <button
          type="button"
          onClick={() => openScene(analysisJob.sceneId)}
          className="mb-3 flex items-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-left text-xs text-ok hover:bg-ok/15"
        >
          <Check size={14} className="shrink-0" />
          <span className="flex-1">{analysisJob.message}</span>
          <ArrowRight size={14} />
        </button>
      )}
      {analysisJob.state === "error" && (
        <p className="mb-3 rounded-lg bg-crash-soft px-3 py-2 text-xs text-crash" role="status">
          {processor} reconstruction failed: {analysisJob.error}
        </p>
      )}
      {(staging.state === "done" || staging.state === "failed") && (
        <p className={`mb-3 text-xs ${staging.state === "failed" ? "text-crash" : "text-ink-2"}`} role="status">
          {staging.message}
        </p>
      )}

      <ul className="mb-3 flex-1 space-y-1.5 overflow-y-auto">
        {uploads.map((upload) => (
          <li key={upload.id} className="flex items-center gap-3 rounded-xl border border-line bg-raised/50 px-3 py-2">
            <Film size={15} className="shrink-0 text-ink-3" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{upload.name}</div>
              <div className="flex items-center gap-1 text-[11px] text-ink-3">
                <span className="shrink-0">{formatBytes(upload.size)}</span>
                <span>·</span>
                <CloudSun size={11} className="shrink-0" />
                <span className="truncate">
                  {upload.analysis.state === "analyzing" && "Reading environment…"}
                  {upload.analysis.state === "done" && describeEnvironment(upload.analysis.result.environment)}
                  {upload.analysis.state === "failed" && `Environment unknown: ${upload.analysis.error}`}
                </span>
              </div>
            </div>
            <IconButton label={`Remove ${upload.name}`} onClick={() => removeUpload(upload.id)}>
              <X size={14} />
            </IconButton>
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <Button
          variant="primary"
          size="md"
          className="flex-1"
          disabled={running || !window.crashvzn?.analysis}
          title={`${processor} reads frames from the queued videos (up to 4 views of one incident) and the app rebuilds the scene from its reading. Change the provider on the Providers page.`}
          onClick={() => void reconstructFootage(uploads)}
        >
          {running ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />}
          {running ? "Reconstructing…" : `Reconstruct with ${processor}`}
        </Button>
        <Button variant="soft" size="md" disabled={staging.state === "copying"} onClick={() => void stageUploads()} title="Copy the videos into app data and record SHA-256 hashes">
          {staging.state === "copying" ? "Staging…" : "Stage"}
        </Button>
      </div>
    </section>
  );
}

function StepDot({ state }: { state: Step["state"] }) {
  if (state === "done")
    return (
      <span className="grid h-4 w-4 place-items-center rounded-full bg-ok/20 text-ok">
        <Check size={10} strokeWidth={3} />
      </span>
    );
  if (state === "active") return <Loader2 size={14} className="animate-spin text-accent" />;
  if (state === "error") return <span className="h-2.5 w-2.5 rounded-full bg-crash" />;
  return <span className="h-2.5 w-2.5 rounded-full border border-line-strong" />;
}
