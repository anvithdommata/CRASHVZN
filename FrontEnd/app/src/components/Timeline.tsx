import { formatClock, formatRelative } from "@/lib/time";
import { LEFT_RAIL, useAppStore } from "@/store/useAppStore";
import { Pause, Play } from "lucide-react";
import { useRef } from "react";

const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2, 4];

export function Timeline() {
  const panelOpen = useAppStore((state) => state.panelOpen);
  const leftWidth = useAppStore((state) => state.leftWidth);
  const resizing = useAppStore((state) => state.resizing);
  const time = useAppStore((state) => state.time);
  const duration = useAppStore((state) => state.duration);
  const impactTime = useAppStore((state) => state.impactTime);
  const crashEnd = useAppStore((state) => state.scenes.find((item) => item.id === state.selectedId)?.crashEnd ?? null);
  const speed = useAppStore((state) => state.speed);
  const setSpeed = useAppStore((state) => state.setSpeed);
  const playing = useAppStore((state) => state.playing);
  const setTime = useAppStore((state) => state.setTime);
  const togglePlay = useAppStore((state) => state.togglePlay);
  const setScrubbing = useAppStore((state) => state.setScrubbing);
  const trackRef = useRef<HTMLDivElement>(null);

  const fraction = duration > 0 ? time / duration : 0;
  const impactFraction = impactTime == null || duration <= 0 ? null : impactTime / duration;
  const endFraction = crashEnd == null || duration <= 0 ? null : crashEnd / duration;
  const speedOptions = SPEEDS.includes(speed) ? SPEEDS : [...SPEEDS, speed].sort((a, b) => a - b);

  const seek = (clientX: number) => {
    const track = trackRef.current;
    if (!track || duration <= 0) return;
    const rect = track.getBoundingClientRect();
    const next = ((clientX - rect.left) / rect.width) * duration;
    setTime(next);
  };

  return (
    <div
      className={`absolute right-4 bottom-4 z-20 ${resizing ? "" : "transition-[left] duration-200 ease-in-out"}`}
      style={{ left: (panelOpen ? leftWidth : LEFT_RAIL) + 16 }}
    >
      <div className="rounded-2xl border border-line bg-panel/85 px-4 py-3 text-ink shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <div className="mb-1 flex items-center gap-3">
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            title={`${playing ? "Pause" : "Play"} (Space) · ← → step 0.1 s, Shift for 1 s`}
            onClick={togglePlay}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-black transition-transform hover:scale-105"
          >
            {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
          </button>
          <span className="w-10 text-sm tabular-nums">{formatClock(time)}</span>
          <span className="flex-1 text-center text-sm tabular-nums text-white/90">
            {impactTime == null ? "No crash in this reconstruction" : `${formatRelative(time, impactTime)} from crash start`}
          </span>
          <span className="w-10 text-right text-sm tabular-nums text-white/70">{formatClock(duration)}</span>
          <label className="flex items-center gap-1 text-xs text-white/70" title="Playback speed">
            <span className="sr-only">Playback speed</span>
            <select
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              className="rounded-md border border-white/15 bg-white/10 px-1.5 py-1 text-xs text-white tabular-nums outline-none hover:bg-white/15 focus:border-white/40"
            >
              {speedOptions.map((option) => (
                <option key={option} value={option} className="bg-panel">
                  {option}×
                </option>
              ))}
            </select>
          </label>
        </div>

        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Reconstruction time"
          aria-valuemin={0}
          aria-valuemax={duration}
          aria-valuenow={Number(time.toFixed(2))}
          className="relative h-8 cursor-pointer touch-none select-none"
          onPointerDown={(event) => {
            setScrubbing(true);
            event.currentTarget.setPointerCapture(event.pointerId);
            seek(event.clientX);
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            seek(event.clientX);
          }}
          // A cancelled drag (window lost focus, touch interrupted) must not leave playback frozen.
          onLostPointerCapture={() => setScrubbing(false)}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            setScrubbing(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") setTime(time + (event.shiftKey ? 1 : 0.1));
            if (event.key === "ArrowLeft") setTime(time - (event.shiftKey ? 1 : 0.1));
            if (event.key === "Home") setTime(0);
            if (event.key === "End") setTime(duration);
          }}
        >
          <div className="absolute top-1/2 right-0 left-0 h-1.5 -translate-y-1/2 rounded-full bg-white/25">
            <div className="h-full rounded-full bg-accent" style={{ width: `${fraction * 100}%` }} />
          </div>
          {impactFraction != null && endFraction != null && endFraction > impactFraction && (
            <div
              className="absolute top-1/2 h-1.5 -translate-y-1/2 bg-red-400/60"
              style={{ left: `${impactFraction * 100}%`, width: `${(endFraction - impactFraction) * 100}%` }}
              title="Crash period"
            />
          )}
          {impactFraction != null && (
            <div
              className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 bg-red-400"
              style={{ left: `${impactFraction * 100}%` }}
              title="Crash start"
            />
          )}
          {endFraction != null && (
            <div
              className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-red-300/80"
              style={{ left: `${endFraction * 100}%` }}
              title="Crash end"
            />
          )}
          <div
            className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-white shadow"
            style={{ left: `${fraction * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
