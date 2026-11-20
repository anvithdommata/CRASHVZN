export type StagedVideo = {
  fileName: string;
  sizeBytes: number;
  sha256: string;
};

export type StagedIncident = {
  incidentId: string;
  videos: StagedVideo[];
};

/** Provider health as reported by the assistant package (see packages/assistant/src/providers/types.ts). */
export type AssistantProviderHealth = {
  kind: string;
  installed: boolean;
  version?: string;
  auth: "authenticated" | "unauthenticated" | "unknown";
  authDetail?: string;
  hint?: string;
  usable: boolean;
};

export type AssistantEffort = "low" | "medium" | "high";

/** Which provider, model and effort the assistant is using. Empty model/effort = the provider's default. */
export type AssistantChoice = { provider: string; model?: string; effort?: AssistantEffort };

export type AssistantBridgeEvent = {
  turn: number;
  /** A SessionEvent from the assistant package, or a bridge-level error. */
  event: { type: string; source?: string; [key: string]: unknown };
};

export type ProcessorKind = "codex" | "claude";

/** One video-processing provider on the Providers page (electron/vision.ts + providers.ts). */
export type ProcessorStatus = {
  provider: ProcessorKind;
  label: string;
  detail: string;
  cli: string;
  models: string[];
  defaultModel: string;
  effort: string;
  health?: AssistantProviderHealth;
  /** Signed in with the right kind of account (ChatGPT / Claude subscription). */
  usable: boolean;
  hint?: string;
};

/** One chat provider: catalog entry (packages/assistant/src/providers/catalog.ts) + live health. */
export type ChatProviderStatus = {
  kind: string;
  label: string;
  detail: string;
  auth: "cli" | "api-key";
  cli?: string;
  login?: { args: string[]; browser: boolean };
  install?: { command?: string; url: string };
  apiKeyEnv?: string;
  chat: boolean;
  tested: "verified" | "partial" | "unverified";
  models: { id: string; label: string }[];
  efforts: AssistantEffort[];
  health?: AssistantProviderHealth;
  /** API-key providers: whether a key is stored (never the key itself). */
  keyStored?: boolean;
};

export type ProvidersStatus = {
  settings: { processor: { provider: ProcessorKind; model?: string }; chat: { provider?: string; model?: string; effort?: string } };
  processors: ProcessorStatus[];
  chat: ChatProviderStatus[];
  unsupported: { label: string; why: string }[];
  /** Whether OS-backed encryption is available for storing API keys. */
  encryption: boolean;
};

export type ProviderLoginEvent = { kind: string; state: "running" | "url" | "done" | "error" | "cancelled"; url?: string; message?: string };

export type KinVec3 = [number, number, number];

/** One object at one moment, as stored in MongoDB (see electron/kinematics.ts). World frame, SI units. */
export type KinematicsFrame = {
  incident_id: string;
  entity_id: string;
  t: number;
  frame: number;
  position: KinVec3;
  velocity: KinVec3;
  speed: number;
  accel: KinVec3;
  accel_long: number;
  heading_deg: number;
  yaw_rate_dps: number;
  mass_kg: number;
  force_net: KinVec3;
  /**
   * The net force split by source (N, world frame): what the road applies through the tyres
   * (braking, accelerating, steering), air drag, rolling resistance, the slope, and, during the
   * crash period, the impact. They sum to force_net.
   */
  force_parts?: { tyre_road: KinVec3; drag: KinVec3; rolling: KinVec3; grade: KinVec3; contact: KinVec3 };
  /** The vision model's own reading of the force from the footage, when it gave one near this time. */
  force_reported?: { vector: KinVec3; cause: string; note: string } | null;
  /** Precision tier: "crash" (precise) or "background" (approximate). */
  involvement?: "crash" | "background";
  sigma: { position_m?: number; speed_mps?: number; accel_mps2?: number } | null;
};

export type KinematicsIncident = {
  _id: string;
  title: string;
  hash: string;
  fps: number;
  duration_s: number;
  origin_scene: KinVec3;
  crash: { start_s: number; end_s: number; vehicles: string[] } | null;
  /** Vehicles, and fixed scenery with type "static" (mass_kg 0 = immovable; details in `static`). */
  entities: {
    id: string;
    label: string;
    type: string;
    mass_kg: number;
    from_s: number;
    to_s: number;
    involvement?: "crash" | "background";
    static?: KinematicsStatic;
  }[];
  basis: string;
  /** Road and air used for the force breakdown. */
  physics?: { wind: KinVec3; gradePercent: number; surface: string; mu: number; air_density: number };
  /** Where things touched during the crash, in time order (vehicle-vehicle and vehicle-static). */
  contacts?: KinematicsContact[];
};

/** A fixed object (median verge, barrier): never moves; footprint in the world frame (y = 0). */
export type KinematicsStatic = {
  kind: string;
  footprint: KinVec3[];
  height_m: number | null;
  material: string | null;
  friction: number | null;
  restitution: number | null;
  stiffness_n_per_m: number | null;
  immovable: boolean;
  sigma_m: number | null;
  source: string | null;
  note: string | null;
};

/** One contact: a pushes b along `normal` (unit, world frame); b pushes a back along its opposite. */
export type KinematicsContact = {
  a: string;
  b: string;
  kind: string;
  t_s: number;
  /** Frame index at the database's fps. */
  frame: number;
  point: KinVec3 | null;
  normal: KinVec3 | null;
  impulse_ns: number | null;
  /** "spec": given by the reconstruction; "derived": a's velocity change along the normal across window_s. */
  impulse_basis: "spec" | "derived" | null;
  window_s: number;
  /** Mean force on b over window_s (N, world frame): impulse / window along the normal. */
  force_avg_n: KinVec3 | null;
  source: string | null;
  note: string | null;
};

/** A vision-model analysis of uploaded footage (electron/analysis.ts), already validated by incident/spec.ts. */
export type IncidentAnalysis = { analysisId: string; spec: import("@/incident/spec").IncidentSpec; cached: boolean; models: string[] };

/** A reconstructed scene saved in MongoDB: rebuilt from its analysis and seed at startup. */
export type SavedSceneRecord = {
  sceneId: string;
  analysisId: string;
  seed: number;
  created: string;
  title: string;
  report?: unknown;
};

export type AnalysisProgress = { stage: string; detail?: string };

export type SceneCallMessage = { id: number; method: string; args: unknown[] };
export type SceneResultMessage = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

declare global {
  interface Window {
    crashvzn?: {
      isDesktop: boolean;
      stageVideos: (files: File[]) => Promise<StagedIncident>;
      assistant: {
        providers: (refresh?: boolean) => Promise<AssistantProviderHealth[]>;
        choice: () => Promise<AssistantChoice>;
        /** Switch provider, model or effort. Pass "" for model/effort to use the provider default. */
        start: (opts: { provider?: string; model?: string; effort?: AssistantEffort | "" }) => Promise<AssistantChoice>;
        send: (text: string) => Promise<{ turn: number }>;
        interrupt: () => Promise<void>;
        onEvent: (callback: (payload: AssistantBridgeEvent) => void) => () => void;
      };
      providers: {
        status: (refresh?: boolean) => Promise<ProvidersStatus>;
        check: (kind: string) => Promise<AssistantProviderHealth>;
        /** Runs the CLI's own login (browser OAuth), or opens a terminal for interactive logins. */
        login: (kind: string) => Promise<{ mode: "browser" | "terminal" }>;
        cancelLogin: (kind: string) => Promise<void>;
        openTerminal: (kind: string, purpose?: "login" | "install") => Promise<void>;
        openUrl: (url: string) => Promise<void>;
        setKey: (kind: string, value: string) => Promise<{ stored: boolean }>;
        clearKey: (kind: string) => Promise<{ stored: boolean }>;
        setProcessor: (choice: { provider: ProcessorKind; model?: string }) => Promise<ProvidersStatus["settings"]>;
        onLoginEvent: (callback: (event: ProviderLoginEvent) => void) => () => void;
        onChanged: (callback: () => void) => () => void;
      };
      scene: {
        onCall: (callback: (message: SceneCallMessage) => void) => () => void;
        reply: (message: SceneResultMessage) => void;
      };
      kinematics: {
        status: () => Promise<{ state: "starting" | "ready" | "error"; mode?: "embedded" | "external"; error?: string }>;
        sync: (meta: KinematicsIncident, frames: KinematicsFrame[]) => Promise<{ synced: boolean; frames: number }>;
        incident: (incidentId: string) => Promise<KinematicsIncident & { synced_at: Date }>;
        sample: (incidentId: string, entityId: string, times: number[]) => Promise<(KinematicsFrame | null)[]>;
        positions: (incidentId: string, t: number) => Promise<{ entity_id: string; position: KinVec3 }[]>;
      };
      /** Footage → scene description via the active video processor (Codex or Claude Code), plus saved scenes. */
      analysis: {
        status: () => Promise<{ configured: boolean; models: { fast: string; precise: string }; provider?: ProcessorKind; providerName?: string; error?: string }>;
        analyze: (files: File[], opts?: { refresh?: boolean; durations?: (number | null)[] }) => Promise<IncidentAnalysis>;
        saveScene: (record: SavedSceneRecord) => Promise<void>;
        listScenes: () => Promise<(SavedSceneRecord & { spec: import("@/incident/spec").IncidentSpec })[]>;
        /** Removes a saved reconstruction and its motion data (the footage reading stays cached). */
        deleteScene: (sceneId: string) => Promise<void>;
        onProgress: (callback: (progress: AnalysisProgress) => void) => () => void;
      };
      /** Resolves to the saved path, or null if the user cancelled the save dialog. */
      saveExport: (bytes: Uint8Array, fileName: string) => Promise<string | null>;
      voice: {
        invoke: (method: string, ...args: unknown[]) => Promise<unknown>;
        on: (callback: (payload: unknown) => void) => () => void;
      };
    };
  }
}

export {};
