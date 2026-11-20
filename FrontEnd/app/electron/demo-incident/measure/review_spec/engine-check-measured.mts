// Runs the app's real engine on a measured incident spec and checks it is frame-exact and fast.
// From FrontEnd/app:  <tsx> --tsconfig tsconfig.json electron/demo-incident/measure/review_spec/engine-check-measured.mts [spec.json]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { planMotion, trackAt } from "../../../../src/incident/motion.ts";
import { sanitizeSpec, type IncidentSpec } from "../../../../src/incident/spec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] ?? join(here, "..", "..", "incident-spec.json");
let t0 = performance.now();
const spec: IncidentSpec = JSON.parse(readFileSync(path, "utf8"));
console.log(`parse ${(performance.now() - t0).toFixed(0)} ms; ${spec.objects.length} objects, ${spec.objects.reduce((s, o) => s + o.keyframes.length, 0)} keyframes, duration ${spec.duration_s} s`);

let failed = false;
const fail = (m: string) => {
  failed = true;
  console.log("FAIL", m);
};

t0 = performance.now();
const plan = planMotion(spec);
console.log(`planMotion ${(performance.now() - t0).toFixed(0)} ms; planned ${plan.vehicles.length}, removed ${plan.removed.length}`);

// Frame exactness: at every video frame the planned pose equals the measured keyframe.
let worst = 0;
let worstId = "";
for (const v of plan.vehicles) {
  for (const k of v.object.keyframes) {
    const { p } = trackAt(v.track, k.t_s);
    const e = Math.hypot(p[0] - k.x_m, p[1] - k.y_m);
    if (e > worst) {
      worst = e;
      worstId = `${v.object.id}@${k.t_s}`;
    }
  }
}
console.log(`max pose error at keyframe times: ${worst.toFixed(3)} m (${worstId})`);
if (worst > 0.05) fail("planned poses don't hit the keyframes");

// The full scene build (road, models, layout) and the kinematics derivation the app stores.
try {
  const { buildIncidentScene } = await import("../../../../src/incident/engine.ts");
  const { deriveSceneKinematics } = await import("../../../../src/kinematics/derive.ts");
  t0 = performance.now();
  const built = buildIncidentScene({ id: "measured-check", spec, seed: 1, created: new Date().toISOString() });
  console.log(`buildIncidentScene ${(performance.now() - t0).toFixed(0)} ms; scene ${built.scene.vehicles.length} vehicles, duration ${built.scene.duration}, impact ${built.scene.impactTime}, removed ${JSON.stringify(built.report.removed.map((r) => `${r.id}: ${r.reason}`))}`);
  t0 = performance.now();
  const kin = deriveSceneKinematics(built.scene);
  console.log(`deriveSceneKinematics ${(performance.now() - t0).toFixed(0)} ms; ${kin?.frames.length ?? 0} frame rows`);
  if (built.scene.duration !== spec.duration_s) fail("scene duration");
  // Hidden outside the keyframes.
  const lay = built.layout;
  for (const id of ["white-van", "yellow-car"]) {
    const v = lay.vehicles.find((x) => x.id === id);
    const o = spec.objects.find((x) => x.id === id)!;
    if (!v) {
      fail(`${id} missing from layout`);
      continue;
    }
    for (const t of [0, o.keyframes[0].t_s, spec.crash?.start_s ?? 0, spec.crash?.end_s ?? 0, 31.92]) {
      const pose = v.poseAt(t);
      console.log(`  ${id.padEnd(10)} t=${t.toFixed(2).padStart(5)} scene x=${pose.x.toFixed(2)} z=${pose.z.toFixed(2)} yaw=${((pose.yaw * 180) / Math.PI).toFixed(1)}${pose.hidden ? " hidden" : ""}`);
    }
  }
} catch (error) {
  fail(`scene build: ${error instanceof Error ? error.stack : String(error)}`);
}

const s = sanitizeSpec(spec);
const resized = s.objects.filter((o) => {
  const src = spec.objects.find((x) => x.id === o.id);
  return !src || src.length_m !== o.length_m || src.width_m !== o.width_m || src.mass_kg !== o.mass_kg || src.keyframes.length !== o.keyframes.length;
});
console.log(`sanitizeSpec: ${s.objects.length} objects, altered ${resized.length}`);
if (s.objects.length !== spec.objects.length || resized.length) fail("sanitizeSpec would alter objects");
console.log(failed ? "MEASURED ENGINE CHECK FAIL" : "MEASURED ENGINE CHECK PASS");
process.exit(failed ? 1 : 0);
