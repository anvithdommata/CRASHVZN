/**
 * Time-remaining estimate for a vision-model reconstruction, from the progress messages the main
 * process already sends (electron/analysis.ts) — no protocol change.
 *
 * A run is a known sequence of the vision model requests:
 *   upload ×cameras → scan ×cameras → close-up checks (0–5) → pass 1 → pass 2 (if a crash)
 *   → census ×cameras → merge → saving / building (local)
 * Each request's real duration is measured as it finishes, and the remaining ones are priced at
 * the running average (a fresh run starts from what typical runs take). Retries and model
 * fallbacks don't count as new requests, so a slow or busy model stretches the estimate instead
 * of resetting it.
 */
import { useEffect, useState } from "react";
import { useAppStore, type AnalysisJob } from "@/store/useAppStore";

/** Typical seconds, from the runs measured so far. */
const PRIOR = { upload: 5, request: 90, local: 12 };
/** Close-up checks we expect when we don't know yet (each candidate crash costs one). */
const EXPECTED_CHECKS = 2;

type Phase = "prep" | "upload" | "scan" | "check" | "pass1" | "pass2" | "census" | "merge" | "local" | "cached";

type Tracker = {
  startedAt: number;
  cameras: number;
  phase: Phase;
  /** Identity of the request in flight, so status updates within it aren't counted twice. */
  current: string | null;
  currentStartedAt: number;
  done: { phase: Phase; seconds: number }[];
  checksSeen: number;
  sawPass2: boolean;
};

let tracker: Tracker | null = null;

function phaseOf(stage: string): Phase {
  if (/^Loaded from the database/i.test(stage)) return "cached";
  if (/^Uploading/i.test(stage)) return "upload";
  if (/^Scanning/i.test(stage)) return "scan";
  if (/^Checking a possible/i.test(stage)) return "check";
  if (/^Pass 1/i.test(stage)) return "pass1";
  if (/^Pass 2/i.test(stage)) return "pass2";
  if (/^Counting/i.test(stage)) return "census";
  if (/^Merging/i.test(stage)) return "merge";
  if (/^(Saving|Building|Saving motion)/i.test(stage)) return "local";
  return "prep";
}

/** Retry / fallback chatter inside one request. */
const isStatus = (detail = "") => /busy|quota|retrying|switching|processing|Preparing \d+ frames|frame sheets/i.test(detail);

function observe(job: AnalysisJob) {
  const now = Date.now();
  if (job.state !== "running") {
    if (job.state !== "idle" && tracker) tracker.phase = "local";
    if (job.state === "idle") tracker = null;
    return;
  }
  if (!tracker || (job.stage === "Starting" && tracker.done.length > 0)) {
    tracker = { startedAt: now, cameras: 1, phase: "prep", current: null, currentStartedAt: now, done: [], checksSeen: 0, sawPass2: false };
  }
  const t = tracker;
  const views = /(\d+) views/.exec(job.detail ?? "");
  if (views) t.cameras = Number(views[1]);
  const ofN = /\((\d+) of (\d+)\)/.exec(job.detail ?? "");
  if (ofN) t.cameras = Math.max(t.cameras, Number(ofN[2]));

  const phase = phaseOf(job.stage);
  if (isStatus(job.detail) && phase === t.phase) return;
  // A new request begins: close the previous one.
  const key = `${phase}|${job.detail ?? ""}`;
  if (key === t.current) return;
  if (t.current && t.phase !== "prep") t.done.push({ phase: t.phase, seconds: (now - t.currentStartedAt) / 1000 });
  t.current = key;
  t.currentStartedAt = now;
  t.phase = phase;
  if (phase === "check") t.checksSeen++;
  if (phase === "pass2") t.sawPass2 = true;
}

function average(t: Tracker, phases: Phase[], prior: number) {
  const samples = t.done.filter((d) => phases.includes(d.phase)).map((d) => d.seconds);
  // Blend with the prior so one quick request doesn't swing the estimate.
  return (samples.reduce((a, b) => a + b, 0) + prior * 2) / (samples.length + 2);
}

export type Eta = { elapsedS: number; remainingS: number; fraction: number };

export function estimate(now = Date.now()): Eta | null {
  const t = tracker;
  if (!t) return null;
  const elapsedS = (now - t.startedAt) / 1000;
  if (t.phase === "cached") return { elapsedS, remainingS: PRIOR.local, fraction: Math.min(0.95, elapsedS / (elapsedS + PRIOR.local)) };

  const upload = average(t, ["upload"], PRIOR.upload);
  const request = average(t, ["scan", "check", "pass1", "pass2", "census"], PRIOR.request);
  const merge = average(t, ["merge"], PRIOR.request * 0.6);
  const n = t.cameras;
  const count = (phase: Phase) => t.done.filter((d) => d.phase === phase).length + (t.phase === phase ? 1 : 0);

  // Requests still to start, per phase (the one in flight is handled separately).
  const order: Phase[] = ["prep", "upload", "scan", "check", "pass1", "pass2", "census", "merge", "local"];
  const at = order.indexOf(t.phase);
  const left = (phase: Phase, total: number) => {
    const i = order.indexOf(phase);
    if (i < at) return 0;
    return Math.max(0, total - count(phase));
  };
  const checks = at > order.indexOf("check") ? 0 : Math.max(EXPECTED_CHECKS, t.checksSeen);
  let remaining =
    left("upload", n) * upload +
    left("scan", n) * request +
    left("check", checks) * request +
    left("pass1", 1) * request * 1.2 +
    left("pass2", at > order.indexOf("pass2") && !t.sawPass2 ? 0 : 1) * request * 1.4 +
    left("census", n) * request +
    left("merge", 1) * merge +
    (t.phase === "local" ? 0 : PRIOR.local);
  // The request in flight: what's typical for it, less what it has already used (never below a few seconds).
  const inFlight = (now - t.currentStartedAt) / 1000;
  const typical = t.phase === "upload" ? upload : t.phase === "merge" ? merge : t.phase === "local" ? PRIOR.local : t.phase === "prep" ? 5 : request;
  remaining += Math.max(typical - inFlight, Math.min(typical, 5) * 0.3);
  return { elapsedS, remainingS: remaining, fraction: Math.min(0.97, elapsedS / (elapsedS + remaining)) };
}

let subscribed = false;
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  observe(useAppStore.getState().analysisJob);
  useAppStore.subscribe((state, prev) => {
    if (state.analysisJob !== prev.analysisJob) observe(state.analysisJob);
  });
}

/** Re-renders every second while a reconstruction runs. */
export function useAnalysisEta(): Eta | null {
  ensureSubscribed();
  const running = useAppStore((state) => state.analysisJob.state === "running");
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return running ? estimate() : null;
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}
