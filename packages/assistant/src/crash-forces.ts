import type { CrashForces, CrashPeriod, Quantity, SpeedQuantity, Vec3 } from "./types";

/**
 * Crash forces from the per-frame motion: shared by the app's controller and the mock, so both
 * answer `crash_forces` the same way.
 *
 * Velocities just before and after the impact come from positions two frames either side of
 * first contact (not from stored velocities, which are central differences and would mix the two).
 * delta-v and impulse are robust; the force needs a contact time the footage can't resolve, so it
 * is reported as an average over an assumed pulse.
 */

export type CrashSample = {
  position: Vec3;
  /** Force the road applied through the tyres (N), when the database has the breakdown. */
  tyre?: Vec3;
  /** The vision model's own force reading near this time. */
  reported?: { vector: Vec3; cause: string; note: string } | null;
};

const FRAME = 1 / 30;
const PULSE_S = 0.1;
const G = 9.80665;
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const r3 = (v: Vec3, d = 2): Vec3 => [round(v[0], d), round(v[1], d), round(v[2], d)];
/** Compass word for a world-frame vector (+x east, -z north). */
export const compassOf = (v: Vec3) => COMPASS[Math.round((((Math.atan2(v[0], -v[2]) * 180) / Math.PI + 360) % 360) / 45) % 8]!;

const speedQ = (mps: number, sigma?: number): SpeedQuantity => ({
  mps: { value: round(mps), unit: "m/s", ...(sigma !== undefined ? { sigma: round(sigma) } : {}) },
  mph: { value: round(mps * 2.23694, 1), unit: "mph", ...(sigma !== undefined ? { sigma: round(sigma * 2.23694, 1) } : {}) },
  kmh: { value: round(mps * 3.6, 1), unit: "km/h", ...(sigma !== undefined ? { sigma: round(sigma * 3.6, 1) } : {}) },
});
const newtons = (n: number): Quantity => ({ value: Math.round(n), unit: "N" });

export async function computeCrashForces(input: {
  crash: CrashPeriod;
  vehicles: { id: string; label: string; mass_kg: number }[];
  sample: (entityId: string, times: number[]) => Promise<(CrashSample | null)[]>;
  /** Speed uncertainty (m/s) for crash vehicles, if known. */
  speedSigma?: number;
  basis?: string;
}): Promise<CrashForces> {
  const { crash } = input;
  const t0 = crash.start_s;
  const out: CrashForces["vehicles"] = [];
  const velocities = new Map<string, { before: Vec3; at: Vec3 }>();

  for (const vehicle of input.vehicles.filter((v) => crash.vehicles.includes(v.id))) {
    const [b2, b1, a0, a1, a2] = await input.sample(vehicle.id, [t0 - 2 * FRAME, t0 - FRAME, t0, t0 + FRAME, t0 + 2 * FRAME]);
    if (!b2 || !b1 || !a1 || !a2 || !a0) continue;
    const before = scale(sub(b1.position, b2.position), 1 / FRAME);
    const after = scale(sub(a2.position, a1.position), 1 / FRAME);
    velocities.set(vehicle.id, { before, at: a0.position });
    const dv = sub(after, before);
    const impulse = scale(dv, vehicle.mass_kg);

    // The slide: sample every 0.1 s from contact to the end of the crash period.
    const end = Math.max(crash.end_s, t0 + 0.2);
    const times: number[] = [];
    for (let t = t0; t <= end + 1e-9; t += 0.1) times.push(t);
    const path = (await input.sample(vehicle.id, times))
      .map((s, i) => (s ? { ...s, t: times[i] } : null))
      .filter((s): s is CrashSample & { t: number } => s !== null);
    let distance = 0;
    let stopped = end;
    for (let i = 1; i < path.length; i++) {
      const here = path[i]!;
      const prev = path[i - 1]!;
      const step = len(sub(here.position, prev.position));
      distance += step;
      if (step / 0.1 < 0.2 && i > 1) {
        stopped = prev.t;
        break;
      }
    }
    const duration = Math.max(0.1, stopped - t0);
    const tyres = path.filter((s) => s.tyre).map((s) => len(s.tyre!));
    const meanTyre = tyres.length ? tyres.reduce((a, b) => a + b, 0) / tyres.length : (vehicle.mass_kg * len(after)) / duration;
    const reported = path
      .filter((s) => s.reported)
      .map((s) => ({ t_s: round(s.t, 2), cause: s.reported!.cause, magnitude: newtons(len(s.reported!.vector)), note: s.reported!.note }))
      .filter((r, i, all) => i === 0 || r.cause !== all[i - 1]!.cause || Math.abs(r.magnitude.value - all[i - 1]!.magnitude.value) > 500);

    out.push({
      entity_id: vehicle.id,
      label: vehicle.label,
      mass_kg: vehicle.mass_kg,
      before: { t_s: round(t0 - FRAME, 3), speed: speedQ(len(before), input.speedSigma), heading_compass: compassOf(before) },
      after: { t_s: round(t0 + FRAME, 3), speed: speedQ(len(after), input.speedSigma), heading_compass: len(after) > 0.2 ? compassOf(after) : "stopped" },
      delta_v: { vector: r3(dv), magnitude: speedQ(len(dv)) },
      impulse: { vector: r3(impulse, 0), magnitude: { value: Math.round(len(impulse)), unit: "N·s" }, direction_compass: compassOf(dv) },
      average_force: { magnitude: newtons(len(impulse) / PULSE_S), pulse_s: PULSE_S, g: round(len(dv) / PULSE_S / G, 1) },
      slide: { distance: { m: round(distance, 1), ft: round(distance * 3.28084, 1) }, duration_s: round(duration, 1), mean_tyre_force: newtons(meanTyre) },
      reported_by_model: reported.slice(0, 6),
    });
  }
  if (out.length === 0) throw new Error("The database has no motion for the vehicles in the crash.");

  const [a, b] = crash.vehicles.map((id) => velocities.get(id)).filter((v) => v !== undefined);
  return {
    crash,
    closing_speed: a && b ? speedQ(len(sub(a.before, b.before))) : null,
    vehicles: out,
    ...(input.basis ? { basis: input.basis } : {}),
    caveats: [
      `Average force assumes the contact lasted about ${PULSE_S} s, typical for car crashes; the footage can't time the pulse, so delta-v and impulse are the firmer numbers.`,
      "Speeds before and after are read two frames either side of first contact.",
    ],
  };
}
