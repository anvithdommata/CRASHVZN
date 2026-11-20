import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planMotion, trackAt } from "../src/incident/motion";
const data = JSON.parse(readFileSync("FrontEnd/app/tests/codex-vision-live-result.json", "utf8"));
const original = data.spec.objects[0];
const objects = Array.from({ length: 131 }, (_, i) => ({ ...original, id: `v${i}`, label: `v${i}`, keyframes: [
  { t_s: 0, x_m: i, y_m: 0, heading_deg: 0, speed_mps: 1 },
  { t_s: 10, x_m: i + 10, y_m: 3, heading_deg: 10, speed_mps: 1 },
  { t_s: 20, x_m: i + 20, y_m: 0, heading_deg: 0, speed_mps: 1 },
] }));
const spec = { ...data.spec, duration_s: 60, objects, crash: { start_s: 15, end_s: 16, participants: ["v0", "v1"], contacts: [] } };
const start = performance.now();
const result = planMotion(spec);
assert.equal(result.vehicles.length, objects.length);
assert.equal(result.removed.length, 0);
assert.equal(result.crash?.start_s, 15);
for (const [i, vehicle] of result.vehicles.entries()) {
  for (const [t, x, y] of [[0, i, 0], [10, i + 10, 3], [20, i + 20, 0]]) {
    const pose = trackAt(vehicle.track, t);
    assert.ok(Math.abs(pose.p[0] - x) < 1e-8 && Math.abs(pose.p[1] - y) < 1e-8);
  }
}
console.log(`131 overlapping tracks retained; keyframes and crash time preserved in ${(performance.now() - start).toFixed(0)} ms`);

// Reported speeds shape the curve only where they agree with the positions; keyframes are always hit.
{
  const base = { ...original, id: "s", label: "s", lane_hint: undefined };
  const agree = planMotion({ ...spec, crash: null, objects: [{ ...base, keyframes: [
    { t_s: 0, x_m: 0, y_m: 0, heading_deg: 0, speed_mps: 10 },
    { t_s: 2, x_m: 20, y_m: 0, heading_deg: 0, speed_mps: 10 },
  ] }] });
  assert.equal(agree.vehicles[0].adjustments.length, 0);
  assert.ok(Math.abs(trackAt(agree.vehicles[0].track, 1).p[0] - 10) < 1e-6, "constant speed stays linear");
  const bad = planMotion({ ...spec, crash: null, objects: [{ ...base, keyframes: [
    { t_s: 0, x_m: 0, y_m: 0, heading_deg: 180, speed_mps: 10 },
    { t_s: 2, x_m: 20, y_m: 0, heading_deg: 0, speed_mps: 80 },
  ] }] });
  assert.match(bad.vehicles[0].adjustments[0], /straight-line speed at 2 of 2/);
  assert.ok(Math.abs(trackAt(bad.vehicles[0].track, 1).p[0] - 10) < 1e-6, "disagreeing speeds fall back to straight lines");
}

// Census-only vehicles are placed in their lane at their census speed, visible only while seen.
{
  const hint = { direction: "with" as const, lane_from_median: 2, first_seen_s: 4, last_seen_s: 8, speed_mps: 20, stopped: false, cameras: ["cam1"] };
  const lanes = { forward: [-2, -5.5], backward: [2, 5.5] };
  const census = planMotion({ ...spec, crash: null, objects: [
    { ...original, id: "c", label: "c", keyframes: [], lane_hint: hint },
    { ...original, id: "q", label: "q", keyframes: [], lane_hint: { ...hint, stopped: true, speed_mps: 0 } },
    { ...original, id: "none", label: "none", keyframes: [], lane_hint: undefined },
  ] }, { lanes });
  assert.deepEqual(census.vehicles.map((v) => v.object.id), ["c", "q"]);
  assert.equal(census.removed[0].id, "none");
  const moving = census.vehicles[0];
  assert.ok(Math.abs(trackAt(moving.track, 6).p[0]) < 1e-6 && Math.abs(trackAt(moving.track, 6).p[1] + 5.5) < 1e-6, "passes the origin mid-window in lane 2");
  assert.ok(Math.abs(trackAt(moving.track, 8).p[0] - 40) < 1e-6, "moves at the census speed");
  assert.match(moving.adjustments[0], /position along the road is assumed/);
  assert.equal(trackAt(census.vehicles[1].track, 6).p[0], -12, "stopped vehicle waits upstream");
  assert.equal(planMotion({ ...spec, crash: null, objects: [{ ...original, id: "c", label: "c", keyframes: [], lane_hint: hint }] }).removed.length, 1, "no lanes: not placed");
}
console.log("speed tangents and census placement behave as documented");
