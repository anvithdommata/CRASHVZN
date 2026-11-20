import { BUILTIN_SCENES, type SceneInfo } from "@/data/scenes";
import { dropSplatFile, putSplatFile } from "@/lib/splatFiles";
import type { FootageAnalysis } from "@/lib/analyzeFootage";
import { CAMERA_ADJUSTMENT_BASE, FREE_CAMERA, type CameraAdjustments, type CameraMode, type CameraRequest } from "@/scene/camera";
import { DEFAULT_ENVIRONMENT } from "@/scene/environment";
import { getLayout } from "@/scene/layouts";
import type { Point3 } from "@/scene/mountScene";
import { create } from "zustand";

export type UploadItem = {
  id: string;
  name: string;
  size: number;
  file: File;
  status: "queued";
  /** Environment read from the footage; scenes reconstructed from it inherit it. */
  analysis: { state: "analyzing" } | { state: "done"; result: FootageAnalysis } | { state: "failed"; error: string };
};

/** A labeled pin. Annotations only: they never change the reconstruction. */
export type Marker = {
  id: string;
  label: string;
  /** Scene coordinates (three.js frame). For a vehicle marker, where the vehicle was when it was placed. */
  point: Point3;
  /** Pinned to a vehicle: the pin moves with it. */
  entityId?: string;
};

export type Layers = {
  trails: boolean;
  bounds: boolean;
  hitboxes: boolean;
  sourceVideo: boolean;
  hiddenVehicles: string[];
};

export type ExportJob = {
  id: string;
  status: "rendering" | "saving" | "done" | "error" | "cancelled";
  /** 0..1 while rendering. */
  progress: number;
  range: [number, number];
  path?: string;
  error?: string;
};

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 4;

/** Side panel widths (px): defaults and limits for the sideways resize handles. */
export const LEFT_PANEL = { default: 400, min: 300, max: 640 };
export const RIGHT_PANEL = { default: 384, min: 300, max: 720 };
/** Width of a collapsed panel's rail (px). */
export const LEFT_RAIL = 60;
export const RIGHT_RAIL = 60;
/** The 3D view keeps at least this much width when panels are dragged wider (px). */
const MIN_VIEWER = 360;

function savedWidth(key: string, fallback: number) {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

const HIDDEN_BUILTINS_KEY = "crashvzn.hiddenBuiltins";
const BUILTIN_IDS = new Set(BUILTIN_SCENES.map((scene) => scene.id));

/** Built-in examples the user deleted. They ship with the app, so "deleting" one only hides it. */
function hiddenBuiltins(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(HIDDEN_BUILTINS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveHiddenBuiltins(ids: string[]) {
  try {
    if (ids.length) localStorage.setItem(HIDDEN_BUILTINS_KEY, JSON.stringify(ids));
    else localStorage.removeItem(HIDDEN_BUILTINS_KEY);
  } catch {
    // Storage unavailable: the example comes back next launch.
  }
}

export const isBuiltinScene = (id: string) => BUILTIN_IDS.has(id);

function saveWidth(key: string, value: number) {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Storage unavailable (private window): the width just isn't remembered.
  }
}

function clampWidth(value: number, limits: { default: number; min: number; max: number }, other: number) {
  if (!Number.isFinite(value)) return limits.default;
  const room = typeof window === "undefined" ? limits.max : window.innerWidth - other - MIN_VIEWER;
  return Math.round(Math.min(limits.max, Math.max(limits.min, Math.min(value, room))));
}

const DEFAULT_LAYERS: Layers = { trails: false, bounds: true, hitboxes: false, sourceVideo: false, hiddenVehicles: [] };

type Store = {
  scenes: SceneInfo[];
  uploads: UploadItem[];
  /** Home screen (library) or the full-page viewer. */
  view: "home" | "viewer";
  /** Folder shown on the home screen; null = all reconstructions. */
  homeFolder: string | null;
  selectedId: string;
  time: number;
  duration: number;
  impactTime: number | null;
  playing: boolean;
  /** Playback rate, 1 = real time. */
  speed: number;
  scrubbing: boolean;
  panelOpen: boolean;
  assistantOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  /** True while a panel edge is being dragged (overlays skip their slide animation). */
  resizing: boolean;
  search: string;
  /** Live readout of the camera relative to the scene's base view. */
  cameraAdjustments: CameraAdjustments;
  /** The latest camera instruction from the panel (number fields or Fit view); null until the first one. */
  cameraRequest: CameraRequest | null;
  cameraMode: CameraMode;
  layers: Layers;
  markers: Marker[];
  exportJob: ExportJob | null;

  openScene: (id: string) => void;
  closeScene: () => void;
  setHomeFolder: (folder: string | null) => void;
  /** Kept for the existing callers: opens the scene in the viewer. */
  selectScene: (id: string) => void;
  setTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  togglePlay: () => void;
  setSpeed: (speed: number) => void;
  setScrubbing: (scrubbing: boolean) => void;
  setPanelOpen: (open: boolean) => void;
  setAssistantOpen: (open: boolean) => void;
  /** NaN resets to the default width. */
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  setResizing: (resizing: boolean) => void;
  setSearch: (search: string) => void;
  setCameraAdjustments: (adjustments: CameraAdjustments) => void;
  applyCameraAdjustments: (adjustments: CameraAdjustments) => void;
  jumpToImpact: () => void;
  resetCamera: () => void;
  setCameraMode: (mode: CameraMode) => void;
  setLayers: (patch: Partial<Layers>) => void;
  setVehicleHidden: (id: string, hidden: boolean) => void;
  addMarker: (marker: Omit<Marker, "id">) => Marker;
  removeMarker: (id: string) => void;
  clearMarkers: () => void;
  setExportJob: (job: ExportJob | null) => void;
  addUploads: (files: { id: string; name: string; size: number; file: File }[]) => void;
  setUploadAnalysis: (id: string, analysis: UploadItem["analysis"]) => void;
  removeUpload: (id: string) => void;
  addSplatScene: (file: { fileName: string; bytes: Uint8Array }) => void;
  /** Adds a scene to the library, or replaces the one with the same id. */
  upsertScene: (scene: SceneInfo) => void;
  /** Takes a scene out of the library (lib/deleteScene.ts also removes what's saved on disk). */
  removeScene: (id: string) => void;
  /** How many built-in examples are hidden, and bringing them all back. */
  hiddenBuiltinCount: number;
  restoreBuiltins: () => void;
  /** Progress of the current footage analysis (incident/reconstruct.ts). */
  analysisJob: AnalysisJob;
  setAnalysisJob: (job: AnalysisJob) => void;
};

export type AnalysisJob =
  | { state: "idle" }
  | { state: "running"; stage: string; detail?: string }
  | { state: "done"; sceneId: string; message: string }
  | { state: "error"; error: string };


const scenesWithDetectedCollisions = BUILTIN_SCENES.map((scene) => {
  const layout = getLayout(scene.id);
  if (!layout || scene.impactTime === null) return scene;

  const collision = layout.collision;
  if (!collision) {
    return { ...scene, impactTime: null, crashEnd: null, crashVehicles: [] };
  }
  const beforeCrash = scene.impactTime - scene.startTime;
  return {
    ...scene,
    impactTime: collision.impactTime,
    crashEnd: Math.min(scene.duration, collision.endTime),
    crashVehicles: collision.vehicleIds,
    startTime: Math.max(0, collision.impactTime - beforeCrash),
  };
});

const startupHidden = new Set(hiddenBuiltins());
const visibleBuiltins = scenesWithDetectedCollisions.filter((scene) => !startupHidden.has(scene.id));
const initial = visibleBuiltins[0] ?? scenesWithDetectedCollisions[0];

function clampTime(time: number, duration: number) {
  if (!Number.isFinite(time)) return 0;
  return Math.min(duration, Math.max(0, time));
}

function sameCameraAdjustments(a: CameraAdjustments, b: CameraAdjustments) {
  return (
    Math.abs(a.panX - b.panX) < 0.001 &&
    Math.abs(a.panY - b.panY) < 0.001 &&
    Math.abs(a.panZ - b.panZ) < 0.001 &&
    Math.abs(a.zoom - b.zoom) < 0.001 &&
    Math.abs(a.tilt - b.tilt) < 0.001 &&
    Math.abs(a.rotate - b.rotate) < 0.001
  );
}

let markerCount = 0;

export const useAppStore = create<Store>((set, get) => ({
  scenes: visibleBuiltins,
  hiddenBuiltinCount: scenesWithDetectedCollisions.length - visibleBuiltins.length,
  uploads: [],
  view: "home",
  homeFolder: null,
  selectedId: initial.id,
  time: initial.startTime,
  duration: initial.duration,
  impactTime: initial.impactTime,
  playing: false,
  speed: 1,
  scrubbing: false,
  panelOpen: true,
  assistantOpen: true,
  leftWidth: savedWidth("reconstruct.leftWidth", LEFT_PANEL.default),
  rightWidth: savedWidth("reconstruct.rightWidth", RIGHT_PANEL.default),
  resizing: false,
  search: "",
  cameraAdjustments: CAMERA_ADJUSTMENT_BASE,
  cameraRequest: null,
  cameraMode: FREE_CAMERA,
  layers: DEFAULT_LAYERS,
  markers: [],
  exportJob: null,

  openScene: (id) => {
    const scene = get().scenes.find((item) => item.id === id);
    if (!scene) return;
    const same = get().selectedId === id;
    set({
      view: "viewer",
      selectedId: id,
      duration: scene.duration,
      impactTime: scene.impactTime,
      ...(same
        ? {}
        : {
            time: scene.startTime,
            playing: false,
            speed: 1,
            cameraAdjustments: CAMERA_ADJUSTMENT_BASE,
            cameraMode: FREE_CAMERA,
            layers: DEFAULT_LAYERS,
            markers: [],
          }),
    });
  },

  closeScene: () => set({ view: "home", playing: false, cameraMode: FREE_CAMERA }),

  setHomeFolder: (homeFolder) => set({ homeFolder }),

  selectScene: (id) => get().openScene(id),

  setTime: (time) => set({ time: clampTime(time, get().duration) }),

  setPlaying: (playing) => set({ playing }),

  togglePlay: () => {
    const { playing, time, duration } = get();
    if (!playing && time >= duration - 0.05) {
      set({ time: 0, playing: true });
      return;
    }
    set({ playing: !playing });
  },

  setSpeed: (speed) => {
    if (!Number.isFinite(speed)) return;
    set({ speed: Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(speed * 100) / 100)) });
  },

  setScrubbing: (scrubbing) => set({ scrubbing }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  setLeftWidth: (width) => {
    const { rightWidth, assistantOpen } = get();
    const leftWidth = clampWidth(width, LEFT_PANEL, assistantOpen ? rightWidth : RIGHT_RAIL);
    saveWidth("reconstruct.leftWidth", leftWidth);
    set({ leftWidth });
  },
  setResizing: (resizing) => set({ resizing }),
  setRightWidth: (width) => {
    const { leftWidth, panelOpen } = get();
    const rightWidth = clampWidth(width, RIGHT_PANEL, panelOpen ? leftWidth : LEFT_RAIL);
    saveWidth("reconstruct.rightWidth", rightWidth);
    set({ rightWidth });
  },
  setSearch: (search) => set({ search }),
  setCameraAdjustments: (cameraAdjustments) =>
    set((state) => (sameCameraAdjustments(state.cameraAdjustments, cameraAdjustments) ? state : { cameraAdjustments })),
  applyCameraAdjustments: (adjustments) =>
    set((state) => ({
      cameraAdjustments: adjustments,
      cameraRequest: { seq: (state.cameraRequest?.seq ?? 0) + 1, kind: "adjust", adjustments },
      cameraMode: FREE_CAMERA,
    })),

  jumpToImpact: () => {
    const { impactTime, duration } = get();
    if (impactTime == null) return;
    set({ time: clampTime(impactTime, duration), playing: false });
  },

  resetCamera: () =>
    set((state) => ({
      cameraRequest: { seq: (state.cameraRequest?.seq ?? 0) + 1, kind: "reset" },
      cameraMode: FREE_CAMERA,
    })),

  setCameraMode: (cameraMode) => set({ cameraMode }),

  setLayers: (patch) => set((state) => ({ layers: { ...state.layers, ...patch } })),

  setVehicleHidden: (id, hidden) =>
    set((state) => {
      const rest = state.layers.hiddenVehicles.filter((item) => item !== id);
      return { layers: { ...state.layers, hiddenVehicles: hidden ? [...rest, id] : rest } };
    }),

  addMarker: (marker) => {
    markerCount += 1;
    const created: Marker = { ...marker, id: `m${markerCount}` };
    set((state) => ({ markers: [...state.markers, created] }));
    return created;
  },

  removeMarker: (id) => set((state) => ({ markers: state.markers.filter((item) => item.id !== id) })),
  clearMarkers: () => set({ markers: [] }),

  setExportJob: (exportJob) => set({ exportJob }),

  addUploads: (files) =>
    set((state) => ({
      uploads: [
        ...files.map((file) => ({
          id: file.id,
          name: file.name,
          size: file.size,
          file: file.file,
          status: "queued" as const,
          analysis: { state: "analyzing" as const },
        })),
        ...state.uploads,
      ],
    })),

  setUploadAnalysis: (id, analysis) =>
    set((state) => ({
      uploads: state.uploads.map((item) => (item.id === id ? { ...item, analysis } : item)),
    })),

  removeUpload: (id) =>
    set((state) => ({ uploads: state.uploads.filter((item) => item.id !== id) })),

  upsertScene: (scene) =>
    set((state) => ({
      scenes: state.scenes.some((item) => item.id === scene.id)
        ? state.scenes.map((item) => (item.id === scene.id ? scene : item))
        : [scene, ...state.scenes],
    })),

  removeScene: (id) => {
    const { scenes, selectedId } = get();
    const remaining = scenes.filter((item) => item.id !== id);
    if (remaining.length === scenes.length) return;
    let hiddenBuiltinCount = get().hiddenBuiltinCount;
    if (BUILTIN_IDS.has(id)) {
      const hidden = [...new Set([...hiddenBuiltins(), id])];
      saveHiddenBuiltins(hidden);
      hiddenBuiltinCount = hidden.filter((item) => BUILTIN_IDS.has(item)).length;
    }
    dropSplatFile(id);
    if (selectedId !== id) {
      set({ scenes: remaining, hiddenBuiltinCount });
      return;
    }
    // The open scene was deleted: back to the library, with the next scene loaded behind it.
    const next = remaining[0];
    set({
      scenes: remaining,
      hiddenBuiltinCount,
      view: "home",
      playing: false,
      cameraMode: FREE_CAMERA,
      markers: [],
      ...(next
        ? { selectedId: next.id, time: next.startTime, duration: next.duration, impactTime: next.impactTime, cameraAdjustments: CAMERA_ADJUSTMENT_BASE, layers: DEFAULT_LAYERS }
        : { selectedId: "", time: 0, duration: 0, impactTime: null }),
    });
  },

  restoreBuiltins: () => {
    saveHiddenBuiltins([]);
    const present = new Set(get().scenes.map((item) => item.id));
    const missing = scenesWithDetectedCollisions.filter((scene) => !present.has(scene.id));
    set((state) => ({ scenes: [...state.scenes, ...missing], hiddenBuiltinCount: 0 }));
  },

  analysisJob: { state: "idle" },
  setAnalysisJob: (analysisJob) => set({ analysisJob }),

  addSplatScene: (file) => {
    const id = `splat-${crypto.randomUUID()}`;
    // A splat carries no footage of its own; use the most recently analysed upload, if any.
    const analysed = get().uploads.find((item) => item.analysis.state === "done");
    const environment =
      analysed?.analysis.state === "done" ? analysed.analysis.result.environment : DEFAULT_ENVIRONMENT;
    // The most recent upload doubles as the scene's source footage.
    const footage = get().uploads[0];
    putSplatFile(id, file);
    const scene: SceneInfo = {
      id,
      title: file.fileName.replace(/\.[^.]+$/, ""),
      location: "Local splat file",
      detail: file.fileName,
      duration: 10,
      impactTime: null,
      crashEnd: null,
      crashVehicles: [],
      startTime: 0,
      folder: "Uploads",
      created: new Date().toISOString().slice(0, 10),
      kind: "splat",
      vehicles: [],
      environment,
      environmentSource: analysed?.name,
      sourceVideo: footage ? { url: URL.createObjectURL(footage.file), name: footage.name } : undefined,
    };
    set((state) => ({ scenes: [scene, ...state.scenes] }));
    get().openScene(id);
  },
}));
