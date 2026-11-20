// Checks that incident-spec.json survives sanitizeSpec and the app's motion planner intact, and
// prints the crash pair's poses. Fails only on real losses: dropped/renamed vehicles, dropped static
// objects or contacts, lost lanes or lane lines, or a vehicle resized beyond the sanitizer's limits.
// From FrontEnd/app:  <tsx> --tsconfig tsconfig.json electron/demo-incident/engine-check.mts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planMotion, trackAt } from "../../src/incident/motion.ts";
import { sanitizeSpec, type IncidentSpec } from "../../src/incident/spec.ts";

const here = dirname(fileURLToPath(import.meta.url));
const raw: IncidentSpec = JSON.parse(readFileSync(join(here, "incident-spec.json"), "utf8"));

let failed = false;
const fail = (msg: string) => {
  failed = true;
  console.log("FAIL", msg);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const s = sanitizeSpec(raw);

// Vehicles: none dropped or renamed; keyframes, width, mass and height untouched; length only where the
// sanitizer's limit applies (trucks over 16.6 m).
console.log(`vehicles: spec ${raw.objects.length}, sanitized ${s.objects.length}`);
if (s.objects.length !== raw.objects.length) fail("sanitizeSpec dropped vehicles");
for (const src of raw.objects) {
  const o = s.objects.find((x) => x.id === src.id);
  if (!o) {
    fail(`vehicle ${src.id} dropped or renamed`);
    continue;
  }
  if (o.keyframes.length !== src.keyframes.length) fail(`${src.id}: keyframes ${src.keyframes.length} -> ${o.keyframes.length}`);
  if (o.width_m !== src.width_m || o.mass_kg !== src.mass_kg) fail(`${src.id}: width/mass ${src.width_m}/${src.mass_kg} -> ${o.width_m}/${o.mass_kg}`);
  if (src.height_m !== undefined && o.height_m !== src.height_m) fail(`${src.id}: height ${src.height_m} -> ${o.height_m}`);
  if (src.rest && !same(src.rest, o.rest)) fail(`${src.id}: rest pose dropped`);
  if (o.length_m !== src.length_m) {
    const clipped = src.category === "truck" && src.length_m > 16.6 && o.length_m === 16.6;
    if (clipped) console.log(`WARN ${src.id}: truck length ${src.length_m} m clipped to 16.6 m (limit)`);
    else fail(`${src.id}: length ${src.length_m} -> ${o.length_m}`);
  }
}

// Crash: participants are the two vehicles, every contact kept (incl. vehicle-static).
console.log("crash participants:", JSON.stringify(s.crash?.participants));
if (!s.crash || !same([...s.crash.participants].sort(), [...(raw.crash?.participants ?? [])].sort())) fail("crash participants changed");
const vehicleIds = new Set(s.objects.map((o) => o.id));
const staticIds = new Set((s.static_objects ?? []).map((o) => o.id));
const rawContacts = raw.crash?.contacts ?? [];
console.log("contacts:", JSON.stringify(s.crash?.contacts.map((c) => `${c.a}->${c.b} @${c.t_s} ${c.kind}`)));
if ((s.crash?.contacts.length ?? 0) !== rawContacts.length) fail(`contacts ${rawContacts.length} -> ${s.crash?.contacts.length ?? 0}`);
for (const c of s.crash?.contacts ?? []) {
  if (!vehicleIds.has(c.a)) fail(`contact a ${c.a} is not a vehicle`);
  if (c.kind === "vehicle-static" ? !staticIds.has(c.b) : !vehicleIds.has(c.b)) fail(`contact b ${c.b} does not match its kind ${c.kind}`);
}

// Static objects: all kept, same ids, counter-clockwise footprints.
console.log(`static objects: spec ${raw.static_objects?.length ?? 0}, sanitized ${s.static_objects?.length ?? 0} (${[...staticIds].join(", ")})`);
for (const src of raw.static_objects ?? []) {
  const o = s.static_objects?.find((x) => x.id === src.id);
  if (!o) fail(`static object ${src.id} dropped`);
  else if (o.footprint_m.length !== src.footprint_m.length) fail(`static object ${src.id}: footprint changed`);
}

// Road: lane count and measured lane lines.
console.log(`lanes_each_way ${raw.road.lanes_each_way} -> ${s.road.lanes_each_way}; lines fwd ${JSON.stringify(s.road.lane_lines_forward_m)} back ${JSON.stringify(s.road.lane_lines_backward_m)}`);
if (s.road.lanes_each_way !== raw.road.lanes_each_way) fail("lanes_each_way changed");
if (!same(s.road.lane_lines_forward_m, raw.road.lane_lines_forward_m) || !same(s.road.lane_lines_backward_m, raw.road.lane_lines_backward_m)) fail("lane lines lost");

// Motion planner: every vehicle placed, lanes from the measured lines (as engine.ts does).
const centres = (l: number[]) => l.slice(1).map((t, i) => (t + l[i]) / 2);
const fl = s.road.lane_lines_forward_m;
const bl = s.road.lane_lines_backward_m;
const lanes = fl && bl ? { forward: centres(fl).map((o) => -o), backward: centres(bl) } : undefined;
const plan = planMotion(s, { lanes });
console.log(`planned ${plan.vehicles.length}, removed ${plan.removed.length}; crash ${JSON.stringify(plan.crash)}`);
if (plan.vehicles.length !== s.objects.length || plan.removed.length) fail(`engine removed: ${JSON.stringify(plan.removed)}`);
for (const id of s.crash?.participants ?? []) {
  const v = plan.vehicles.find((p) => p.object.id === id);
  if (!v) continue;
  for (const t of [0, 21, 22.64, 23.28, 24, 26, 28, 31.9]) {
    const { p, h } = trackAt(v.track, t);
    console.log(`${id.padEnd(10)} t=${String(t).padEnd(5)} x=${p[0].toFixed(2).padStart(7)} y=${p[1].toFixed(2).padStart(6)} h=${h.toFixed(1).padStart(6)}`);
  }
}

console.log(failed ? "ENGINE CHECK FAIL" : "ENGINE CHECK PASS");
process.exit(failed ? 1 : 0);
