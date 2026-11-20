// Run: packages/assistant/node_modules/.bin/tsx --tsconfig FrontEnd/app/tsconfig.json FrontEnd/app/tests/codex-vision.test.ts [--live]
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateVision, samplePlan, strictSchema, visionPreflight } from "../electron/codex-vision";
import { PASS1_SCHEMA, sanitizeSpec } from "../src/incident/spec";
import { buildIncidentScene } from "../src/incident/engine";
import { makeVehicle } from "../src/scene/cars";
import * as THREE from "three";

const plan = samplePlan(20, 26, 10, 1);
assert.equal(plan.count, 60);
assert.equal(plan.times[0], 20);
assert.ok(Math.abs(plan.times.at(-1)! - 25.9) < 1e-9);
const multi = samplePlan(0, 60, 2, 4);
assert.equal(multi.count, 40);
assert.equal(multi.times.at(-1), 58.5);
assert.throws(() => samplePlan(20, 10, 2, 1));
function checkClosed(schema: any) {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
  }
  Object.values(schema).forEach((value) => {
    if (Array.isArray(value)) value.forEach(checkClosed);
    else checkClosed(value);
  });
}
checkClosed(strictSchema(PASS1_SCHEMA));
assert.equal((PASS1_SCHEMA as any).additionalProperties, undefined, "conversion must not mutate shared schemas");
console.log("Sampling and nested structured-output checks passed.");

if (process.argv.includes("--live") || process.argv.includes("--full")) {
  const full = process.argv.includes("--full");
  const status = await visionPreflight();
  assert.ok(status.ok, JSON.stringify(status));
  const instructions = await readFile(resolve("FrontEnd/app/electron/vision-prompts/SKILL.md"), "utf8");
  const answer = await generateVision([
    { text: "Video 1: demo.mp4. Measure the supplied footage from the highway camera mosaic. Produce a scene with visible road vehicles, their colours, estimated dimensions and at least two position keyframes for each vehicle. All times must use the source-video timestamps in the image manifest. Report total source duration as 60 seconds. Do not invent a collision when the images do not establish contact." },
    { fileData: { fileUri: resolve("demo.mp4") }, videoMetadata: { startOffset: full ? "0s" : "20s", endOffset: full ? "59.92s" : "24s", fps: 2, duration: 60 } },
  ], PASS1_SCHEMA, instructions, console.log);
  const spec = sanitizeSpec(answer.json);
  assert.ok(spec.objects.length > 0, "vision must find vehicles");
  const built = buildIncidentScene({ id: "codex-auth-smoke", spec, seed: 42, created: "2026-11-15" });
  assert.ok(built.scene.vehicles.length > 0, "engine must retain renderable vehicles");
  assert.equal(built.scene.vehicles.length, built.layout.vehicles.length);
  for (const vehicle of built.layout.vehicles) {
    for (const time of [0, 20, 21, 22, 23, 24, spec.duration_s]) {
      const pose = vehicle.poseAt(time);
      assert.ok(Object.values(pose).every(Number.isFinite), `${vehicle.id} must have finite renderer coordinates at ${time}`);
    }
    const rig = makeVehicle(vehicle.kind ?? "car", "#888888", vehicle.id, "sedan");
    const bounds = new THREE.Box3().setFromObject(rig.root);
    assert.ok(!bounds.isEmpty() && [...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite));
    rig.root.traverse((node) => { if (node instanceof THREE.Mesh) node.geometry.dispose(); });
  }
  const artifact = resolve(full ? "FrontEnd/app/tests/codex-vision-full-result.json" : "FrontEnd/app/tests/codex-vision-live-result.json");
  await writeFile(artifact, JSON.stringify({ usage: answer.usage, spec, scene: built.scene, report: built.report }, null, 2));
  console.log(`Authenticated vision → scene engine → ${built.scene.vehicles.length} vehicle meshes and finite poses passed. Result: ${artifact}`);
}
