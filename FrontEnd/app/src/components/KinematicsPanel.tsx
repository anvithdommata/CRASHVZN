/**
 * The assistant's Analysis tab: speeds at the playhead and at the crash, read off the
 * reconstruction's trajectories, and a constant-acceleration calculator. Everything here is an
 * estimate from the reconstruction, not a measurement.
 */
import { Section } from "@/components/ui";
import { getLayout } from "@/scene/layouts";
import { speedAt, toKmh, toMph } from "@/scene/liveSpeed";
import { useAppStore } from "@/store/useAppStore";
import { Calculator, Gauge, Zap } from "lucide-react";
import { useState } from "react";

const CONSTANT_ACCELERATION_MPS2 = 1;

function parseNumber(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: number) {
  return Number(value.toFixed(3)).toString();
}

export function AnalysisPanel() {
  const view = useAppStore((state) => state.view);
  const scene = useAppStore((state) => state.scenes.find((item) => item.id === state.selectedId));

  if (view !== "viewer" || !scene) {
    return <Empty text="Open a reconstruction to see vehicle speeds, impact figures and the kinematics calculator." />;
  }
  if (scene.kind === "splat" || !getLayout(scene.id)) {
    return <Empty text="A Gaussian splat has no tracked vehicles, so there is no motion to analyse." />;
  }

  return (
    <div className="animate-panel-in space-y-1">
      <SpeedsNow />
      {scene.impactTime != null && <AtImpact />}
      <KinematicsCalculator />
      <p className="px-1 pt-1 text-[11px] leading-relaxed text-ink-3">
        Figures are derived from the reconstructed trajectories. They are estimates, not measured facts.
      </p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-2xl bg-white/6 text-ink-3">
        <Gauge size={20} />
      </div>
      <p className="text-sm text-ink-2">{text}</p>
    </div>
  );
}

function SpeedsNow() {
  const scene = useAppStore((state) => state.scenes.find((item) => item.id === state.selectedId));
  const time = useAppStore((state) => state.time);
  if (!scene) return null;
  const rows = scene.vehicles.map((vehicle) => ({ vehicle, mps: speedAt(scene.id, vehicle.id, time) }));
  const max = Math.max(1, ...rows.map((row) => row.mps ?? 0));
  return (
    <Section title={`Speed at ${time.toFixed(1)} s`}>
      <ul className="space-y-2">
        {rows.map(({ vehicle, mps }) => (
          <li key={vehicle.id}>
            <div className="mb-1 flex items-baseline gap-2 text-xs">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: vehicle.color }} />
              <span className="min-w-0 flex-1 truncate text-ink-2">{vehicle.label}</span>
              {mps == null ? (
                <span className="text-ink-3">not in view</span>
              ) : (
                <span className="tabular-nums" title={`${toKmh(mps).toFixed(0)} km/h · ${mps.toFixed(1)} m/s`}>
                  <span className="font-semibold text-ink">{toMph(mps).toFixed(0)}</span> <span className="text-ink-3">mph</span>
                </span>
              )}
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-white/8">
              <div className="h-full rounded-full transition-[width] duration-150" style={{ width: `${((mps ?? 0) / max) * 100}%`, background: vehicle.color }} />
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function AtImpact() {
  const scene = useAppStore((state) => state.scenes.find((item) => item.id === state.selectedId));
  const setTime = useAppStore((state) => state.setTime);
  if (!scene || scene.impactTime == null) return null;
  const impact = scene.impactTime;
  const involved = scene.vehicles.filter((vehicle) => (scene.crashVehicles ?? []).includes(vehicle.id));
  if (!involved.length) return null;
  // Closing speed between the first two vehicles in the crash: how fast the gap between them shrank.
  const layout = getLayout(scene.id);
  let closing: number | null = null;
  if (layout && involved.length >= 2) {
    const [a, b] = involved.map((vehicle) => layout.vehicles.find((item) => item.id === vehicle.id));
    if (a && b) {
      const dt = 0.1;
      const gap = (t: number) => {
        const pa = a.poseAt(t);
        const pb = b.poseAt(t);
        return pa.hidden || pb.hidden ? null : Math.hypot(pa.x - pb.x, pa.z - pb.z);
      };
      const before = gap(impact - dt);
      const at = gap(impact);
      if (before != null && at != null) closing = Math.max(0, (before - at) / dt);
    }
  }
  return (
    <Section
      title="At the crash"
      action={
        <button type="button" onClick={() => setTime(impact)} className="inline-flex items-center gap-1 text-[11px] font-medium text-crash hover:underline">
          <Zap size={11} />
          Jump to {impact.toFixed(1)} s
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        {involved.map((vehicle) => {
          const mps = speedAt(scene.id, vehicle.id, impact - 0.05);
          return (
            <Stat key={vehicle.id} label={vehicle.label} color={vehicle.color} value={mps == null ? "—" : toMph(mps).toFixed(0)} unit="mph" hint={mps == null ? undefined : `${toKmh(mps).toFixed(0)} km/h`} />
          );
        })}
        {closing != null && <Stat label="Closing speed" value={toMph(closing).toFixed(0)} unit="mph" hint={`${toKmh(closing).toFixed(0)} km/h, first two vehicles`} wide />}
      </div>
    </Section>
  );
}

function Stat({ label, value, unit, hint, color, wide = false }: { label: string; value: string; unit: string; hint?: string; color?: string; wide?: boolean }) {
  return (
    <div className={`rounded-lg border border-line bg-sunken px-2.5 py-2 ${wide ? "col-span-2" : ""}`} title={hint}>
      <div className="flex items-center gap-1.5 truncate text-[11px] text-ink-3">
        {color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
        {label}
      </div>
      <div className="mt-0.5">
        <span className="text-lg font-semibold tabular-nums">{value}</span> <span className="text-[11px] text-ink-3">{unit}</span>
      </div>
    </div>
  );
}

function KinematicsCalculator() {
  const [selectedVehicleId, setSelectedVehicleId] = useState("");
  const [time, setTime] = useState("1");
  const scene = useAppStore((state) => state.scenes.find((item) => item.id === state.selectedId));
  const layout = scene ? getLayout(scene.id) : undefined;
  const collisionVehicleIds = layout?.collision?.vehicleIds;
  const vehicles = scene ? (collisionVehicleIds ? scene.vehicles.filter((vehicle) => collisionVehicleIds.includes(vehicle.id)) : scene.vehicles) : [];
  const selectedVehicle = vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? vehicles[0] ?? null;
  const motion = selectedVehicle ? layout?.vehicles.find((vehicle) => vehicle.id === selectedVehicle.id) : undefined;
  const startSpeed = scene && motion ? getStartingSpeed(motion.poseAt, scene.startTime, selectedVehicle?.visibleFrom, selectedVehicle?.visibleTo) : null;

  const v0 = startSpeed;
  const t = parseNumber(time);
  const canCalculate = v0 !== null && t !== null;
  const position = canCalculate ? v0 * t + 0.5 * CONSTANT_ACCELERATION_MPS2 * t * t : null;
  const velocity = canCalculate ? v0 + CONSTANT_ACCELERATION_MPS2 * t : null;

  if (!scene || !selectedVehicle) return null;

  return (
    <Section
      title="Kinematics calculator"
      action={
        <span className="inline-flex items-center gap-1 text-[11px] text-ink-3">
          <Calculator size={11} /> constant a
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 flex flex-col gap-1 text-[11px] font-medium text-ink-3">
          Vehicle
          <select
            value={selectedVehicle.id}
            onChange={(event) => setSelectedVehicleId(event.currentTarget.value)}
            className="w-full rounded-lg border border-line bg-sunken px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
          >
            {vehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id} className="bg-panel">
                {vehicle.label}
              </option>
            ))}
          </select>
        </label>
        <Readout label="v₀ (m/s)" value={startSpeed === null ? "Unavailable" : formatNumber(startSpeed)} />
        <Readout label="a (m/s²)" value={formatNumber(CONSTANT_ACCELERATION_MPS2)} />
        <label className="col-span-2 flex flex-col gap-1 text-[11px] font-medium text-ink-3">
          Evaluate at t (s)
          <input
            type="number"
            step="any"
            value={time}
            onChange={(event) => setTime(event.currentTarget.value)}
            className="w-full rounded-lg border border-line bg-sunken px-2 py-1.5 text-sm text-ink tabular-nums outline-none focus:border-accent"
          />
        </label>
      </div>
      <div className="mt-3 rounded-lg bg-sunken px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-3">
        x(t) = v₀t + ½at² · v(t) = v₀ + at
      </div>
      <dl className="mt-3 space-y-1.5" aria-live="polite">
        <Result label="Position from start" value={position} unit="m" />
        <Result label="Velocity" value={velocity} unit="m/s" />
      </dl>
      {startSpeed === null ? (
        <p className="mt-2 text-xs text-warn">Vehicle speed is unavailable for this scene.</p>
      ) : t === null ? (
        <p className="mt-2 text-xs text-warn">Enter a valid time.</p>
      ) : null}
    </Section>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 text-[11px] font-medium text-ink-3">
      {label}
      <output className="w-full rounded-lg border border-line bg-white/4 px-2 py-1.5 text-sm text-ink-2 tabular-nums">{value}</output>
    </div>
  );
}

function getStartingSpeed(
  poseAt: (time: number) => { x: number; z: number; hidden?: boolean },
  startTime: number,
  visibleFrom?: number,
  visibleTo?: number,
) {
  const sampleStep = 0.01;
  // A vehicle that hasn't driven in yet (or already left) is parked off the road: measure from the
  // moment it is on screen instead of reading its held pose as "stopped".
  let from = startTime;
  if (poseAt(from).hidden) {
    if (visibleFrom != null && visibleFrom > from) from = visibleFrom;
    else if (visibleTo != null && visibleTo < from) from = visibleTo - sampleStep;
    else return null;
  }
  const start = poseAt(from);
  let to = from + sampleStep;
  // Right at its exit: difference backwards.
  if (poseAt(to).hidden) to = from - sampleStep;
  const next = poseAt(to);
  return Math.hypot(next.x - start.x, next.z - start.z) / sampleStep;
}

function Result({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-ink-2">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">{value === null ? "—" : `${formatNumber(value)} ${unit}`}</dd>
    </div>
  );
}
