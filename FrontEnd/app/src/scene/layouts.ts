import {
  crossSection,
  markingLayout,
  PARKING,
  resolveRoadSpec,
  ROUNDABOUTS,
  VERGE_WIDTH,
  type RoadSpec,
} from "@/road/spec";
import { carHitboxDimensions, type CarStyle, type VehicleKind } from "@/scene/cars";
import {
  findFirstEllipseContact,
  postImpactPosition,
  resolveEllipseImpact,
  stoppingTime,
} from "@/scene/collision";
import type { Painter } from "@/scene/draw";
import type { Site } from "@/scene/environment";
import { fourWayIntersection } from "@/scene/roads/intersection";
import { parkingLot } from "@/scene/roads/parking";
import { roundabout } from "@/scene/roads/roundabout";
import type { P } from "@/scene/roads/geometry";

export type Pose = { x: number; z: number; yaw: number; /** Off the road at this time (not yet arrived, or already gone). */ hidden?: boolean };

export type VehicleMotion = {
  id: string;
  kind?: VehicleKind;
  scale?: number;
  poseAt: (time: number) => Pose;
};

export type Layout = {
  id: string;
  site: Site;
  camera: { position: [number, number, number]; target: [number, number, number] };
  build: (painter: Painter) => void;
  vehicles: VehicleMotion[];
  collision?: { impactTime: number; endTime: number; vehicleIds: string[] };
};

function smoothstep(value: number) {
  const x = Math.min(1, Math.max(0, value));
  return x * x * (3 - 2 * x);
}

/** 0 → 1 easing out over `tau` seconds: how far a car slides after an impact. */
const settle = (after: number, tau: number) => 1 - Math.exp(-Math.max(0, after) / tau);

/** Heading from a velocity in the plan; yaw 0 faces +z, π/2 faces +x. */
const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);

type CollisionParticipant = { id: string; massKg: number; style: CarStyle; scale?: number };

function withHitboxCollision(
  vehicles: VehicleMotion[],
  first: CollisionParticipant,
  second: CollisionParticipant,
  duration: number,
) {
  const firstVehicle = vehicles.find((vehicle) => vehicle.id === first.id);
  const secondVehicle = vehicles.find((vehicle) => vehicle.id === second.id);
  if (!firstVehicle || !secondVehicle) return undefined;

  const firstAuthored = firstVehicle.poseAt;
  const secondAuthored = secondVehicle.poseAt;
  const firstBase = carHitboxDimensions(first.style);
  const secondBase = carHitboxDimensions(second.style);
  const firstScale = first.scale ?? 1;
  const secondScale = second.scale ?? 1;
  const firstFootprint = {
    radiusX: firstBase.radiusX * firstScale,
    radiusZ: firstBase.radiusZ * firstScale,
    centerZ: firstBase.centerZ * firstScale,
  };
  const secondFootprint = {
    radiusX: secondBase.radiusX * secondScale,
    radiusZ: secondBase.radiusZ * secondScale,
    centerZ: secondBase.centerZ * secondScale,
  };
  const contact = findFirstEllipseContact(firstAuthored, secondAuthored, firstFootprint, secondFootprint, duration);
  if (!contact) return undefined;

  const impactTime = contact.time;
  const firstPose = firstAuthored(impactTime);
  const secondPose = secondAuthored(impactTime);
  const derivativeStep = 0.005;
  const velocityAt = (poseAt: (time: number) => Pose, pose: Pose) => {
    const before = poseAt(impactTime - derivativeStep);
    const after = poseAt(impactTime + derivativeStep);
    const yawDelta = Math.atan2(Math.sin(after.yaw - before.yaw), Math.cos(after.yaw - before.yaw));
    return {
      velocityX: (after.x - before.x) / (2 * derivativeStep),
      velocityZ: (after.z - before.z) / (2 * derivativeStep),
      yawRate: yawDelta / (2 * derivativeStep),
      pose,
    };
  };
  const firstState = velocityAt(firstAuthored, firstPose);
  const secondState = velocityAt(secondAuthored, secondPose);
  const resolved = resolveEllipseImpact(
    {
      ...firstState,
      massKg: first.massKg,
      footprint: firstFootprint,
    },
    {
      ...secondState,
      massKg: second.massKg,
      footprint: secondFootprint,
    },
    { x: contact.normalX, z: contact.normalZ },
  );
  if (!resolved) return undefined;

  const [firstVelocity, secondVelocity] = resolved;
  const firstStopTime = stoppingTime(firstVelocity.velocityX, firstVelocity.velocityZ);
  const secondStopTime = stoppingTime(secondVelocity.velocityX, secondVelocity.velocityZ);
  const endTime = impactTime + Math.max(firstStopTime, secondStopTime);
  const postImpactPose = (
    pose: Pose,
    velocity: (typeof resolved)[number],
    time: number,
  ): Pose => {
    const elapsed = Math.max(0, time - impactTime);
    const position = postImpactPosition(
      { x: pose.x, z: pose.z },
      velocity.velocityX,
      velocity.velocityZ,
      elapsed,
    );
    const spinTau = 0.45;
    return {
      ...position,
      yaw: pose.yaw + velocity.yawRate * spinTau * settle(elapsed, spinTau),
    };
  };

  firstVehicle.poseAt = (time) =>
    time < impactTime ? firstAuthored(time) : postImpactPose(firstPose, firstVelocity, time);
  secondVehicle.poseAt = (time) =>
    time < impactTime ? secondAuthored(time) : postImpactPose(secondPose, secondVelocity, time);
  return { impactTime, endTime, vehicleIds: [first.id, second.id] };
}

// ---------------------------------------------------------------------------
// Roundabout: German urban single-lane roundabout (FGSV Merkblatt 2006) joining four
// collector streets, with a car park on either side of the east arm.

const ROUND_CENTER: P = [-6, 2];
const ROUND_STANDARD = ROUNDABOUTS.DE;
const COLLISION_APPROACH_SPEED_MPS = 20;
const COLLECTOR = resolveRoadSpec({ region: "DE", roadClass: "collector" });
const COLLECTOR_HALF = crossSection(COLLECTOR).pavedHalfWidthForward;
const ROUND_INNER = ROUND_STANDARD.outerRadius - ROUND_STANDARD.circulatoryWidth;
const ROUND_LANE = (ROUND_INNER + ROUND_STANDARD.outerRadius) / 2;
const ENTRY_OFFSET = -(ROUND_STANDARD.splitterWidth / 2 + ROUND_STANDARD.entryWidth / 2);
/** Inbound lane centre on a plain stretch of an arm (left of the outbound direction). */
const ARM_INBOUND = crossSection(COLLECTOR).backwardLaneCenters[0];

/** Arms: east, north (+z), west, south (-z). */
const ARM_ANGLES = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
const EAST: P = [1, 0];

/** Point on an arm at distance s from the centre, t to the right of the outbound direction. */
function armPoint(angle: number, s: number, t: number): P {
  const u: P = [Math.cos(angle), Math.sin(angle)];
  return [ROUND_CENTER[0] + u[0] * s - u[1] * t, ROUND_CENTER[1] + u[1] * s + u[0] * t];
}

const LOT_PLAN = { from: 21, to: 48, drivewayFrom: 37, setback: 5 };

/** Aisle centre of the -z car park (same rule as parkingLot): setback, near row, half the aisle. */
const SOUTH_AISLE_T = -(COLLECTOR_HALF + LOT_PLAN.setback + PARKING.DE.stallDepth + PARKING.DE.aisleWidth / 2);

function whiteAngle(time: number) {
  // Joined from the west arm, circulating anticlockwise in plan (right-hand traffic).
  const omega = COLLISION_APPROACH_SPEED_MPS / ROUND_LANE;
  return -0.3 + omega * 12 - omega * time;
}

function whitePose(time: number): Pose {
  const angle = whiteAngle(time);
  return {
    x: ROUND_CENTER[0] + Math.cos(angle) * ROUND_LANE,
    z: ROUND_CENTER[1] + Math.sin(angle) * ROUND_LANE,
    yaw: yawOf(Math.sin(angle), -Math.cos(angle)),
  };
}

/** Red enters from the east arm without giving way, on an intercept path toward the SUV. */
function redPose(time: number): Pose {
  const impact = 12;
  const hit = whitePose(impact);
  const p0 = armPoint(0, 36, ARM_INBOUND);
  const p2: P = [hit.x + 2.9, hit.z + 0.2];
  const dx = p2[0] - p0[0];
  const dz = p2[1] - p0[1];
  const duration = Math.hypot(dx, dz) / COLLISION_APPROACH_SPEED_MPS;
  const approachStart = impact - duration;
  const progress = Math.max(0, (time - approachStart) / duration);
  return {
    x: p0[0] + dx * progress,
    z: p0[1] + dz * progress,
    yaw: yawOf(dx, dz),
  };
}

const roundaboutVehicles: VehicleMotion[] = [
  { id: "white", scale: 1.08, poseAt: whitePose },
  { id: "red", poseAt: redPose },
  {
    id: "orange",
    scale: 0.94,
    // Approaches on the west arm and waits at the give-way line.
    poseAt: (time) => {
      const from = armPoint(Math.PI, 40, ARM_INBOUND);
      const to = armPoint(Math.PI, ROUND_STANDARD.outerRadius + 3.2, ENTRY_OFFSET);
      const u = smoothstep(time / 14);
      return { x: from[0] + (to[0] - from[0]) * u, z: from[1] + (to[1] - from[1]) * u, yaw: yawOf(to[0] - from[0], to[1] - from[1]) };
    },
  },
  {
    id: "green",
    // Creeping along the car-park aisle looking for a space.
    poseAt: (time) => {
      const [x, z] = armPoint(0, 24 + time * 0.42, SOUTH_AISLE_T);
      return { x, z, yaw: Math.PI / 2 };
    },
  },
];
const roundaboutCollision = withHitboxCollision(
  roundaboutVehicles,
  { id: "white", massKg: 1950, style: "suv", scale: 1.08 },
  { id: "red", massKg: 1500, style: "sedan" },
  25,
);

const roundaboutLayout: Layout = {
  id: "roundabout",
  site: { width: 96, depth: 74 },
  camera: { position: [34, 30, 36], target: [-2, 0, 2] },
  build(p) {
    const southLotGeometry = parkingLot(p, ROUND_CENTER, EAST, COLLECTOR, COLLECTOR_HALF, { ...LOT_PLAN, side: -1 });
    const northLotGeometry = parkingLot(p, ROUND_CENTER, EAST, COLLECTOR, COLLECTOR_HALF, { ...LOT_PLAN, side: 1 });
    roundabout(
      p,
      ROUND_CENTER,
      ROUND_STANDARD,
      ARM_ANGLES.map((angle, index) => ({
        angle,
        spec: COLLECTOR,
        notches:
          index === 0
            ? [
                { side: -1 as const, points: southLotGeometry.notch, radii: southLotGeometry.notchRadii },
                { side: 1 as const, points: northLotGeometry.notch, radii: northLotGeometry.notchRadii },
              ]
            : undefined,
      })),
    );
    p.finish();
  },
  vehicles: roundaboutVehicles,
  collision: roundaboutCollision,
};

// ---------------------------------------------------------------------------
// Apache Blvd, Tempe AZ: US urban arterial (2 lanes each way, double yellow) crossing a
// collector at a four-way intersection.

const APACHE = resolveRoadSpec({ region: "US", roadClass: "arterial" });
const APACHE_CROSS = resolveRoadSpec({ region: "US", roadClass: "collector" });
const APACHE_LANES = crossSection(APACHE);
/** The blue SUV's late swerve to its right (-z) (m). */
const APACHE_SWERVE = 0.35;
/** Aim the sedan's late drift toward the center of the two converging lanes. */
const APACHE_SILVER_TARGET_Z =
  (APACHE_LANES.forwardLaneCenters[0] + APACHE_LANES.backwardLaneCenters[0] - APACHE_SWERVE) / 2;

const apacheVehicles: VehicleMotion[] = [
  {
    // Eastbound (+x, right side is +z) in the inner lane, drifting over the centre line.
    id: "silver",
    poseAt: (time) => {
      const lane = APACHE_LANES.forwardLaneCenters[0];
      const drift = (lane - APACHE_SILVER_TARGET_Z) * smoothstep((time - 5.5) / 2.5);
      return {
        x: COLLISION_APPROACH_SPEED_MPS * (time - 8),
        z: lane - drift,
        yaw: Math.PI / 2 - 0.06 * smoothstep((time - 5.5) / 2.5),
      };
    },
  },
  {
    // Westbound (-x) in its inner lane; swerves too late.
    id: "blue",
    scale: 1.08,
    poseAt: (time) => {
      const lane = APACHE_LANES.backwardLaneCenters[0];
      const swerve = -APACHE_SWERVE * smoothstep((time - 7) / 1);
      return {
        x: 0.6 - COLLISION_APPROACH_SPEED_MPS * (time - 8),
        z: lane + swerve,
        yaw: -Math.PI / 2,
      };
    },
  },
];
const apacheCollision = withHitboxCollision(
  apacheVehicles,
  { id: "silver", massKg: 1600, style: "sedan" },
  { id: "blue", massKg: 2000, style: "suv", scale: 1.08 },
  16,
);

const apache: Layout = {
  id: "apache",
  site: { width: 100, depth: 52 },
  camera: { position: [22, 24, 30], target: [0, 0, 0] },
  build(p) {
    fourWayIntersection(p, APACHE, APACHE_CROSS);
    p.finish();
  },
  vehicles: apacheVehicles,
  collision: apacheCollision,
};

// ---------------------------------------------------------------------------
// Divided highway modelled on the r05_s03 camera footage: a German Autobahn (RAA cross
// section, RMS markings) with three lanes and a hard shoulder each way, a concrete
// median barrier, W-beam guardrails on gravel verges and an overhead sign gantry.

const AUTOBAHN = resolveRoadSpec({ region: "DE", roadClass: "motorway" });
const AUTOBAHN_SECTION = crossSection(AUTOBAHN);
/** Centre of lane 1 (next to the median) .. 3 (next to the hard shoulder); fractional while changing lanes. */
const laneCenter = (lane: number) => AUTOBAHN_SECTION.forwardLaneCenters[0] + (lane - 1) * AUTOBAHN.laneWidth;
const HIGHWAY_LOOP = 450;

function wrap(x: number) {
  const span = HIGHWAY_LOOP * 2;
  return ((((x + HIGHWAY_LOOP) % span) + span) % span) - HIGHWAY_LOOP;
}

/** Constant-speed travel along the highway; `lane` may change smoothly over time. */
function cruise(x0: number, speed: number, direction: 1 | -1, lane: (time: number) => number) {
  const zAt = (time: number) => direction * laneCenter(lane(time));
  return (time: number): Pose => {
    const x = wrap(x0 + direction * speed * time);
    const z = zAt(time);
    const dz = (zAt(time + 0.05) - zAt(time - 0.05)) / 0.1;
    return { x, z, yaw: Math.atan2(direction * speed, dz) };
  };
}

const steady = (lane: number) => () => lane;
const laneChange = (from: number, to: number, start: number, length: number) => (time: number) =>
  from + (to - from) * smoothstep((time - start) / length);

/** Both carriageways of a divided road along x, with the forward (eastbound) one at +z. */
export function motorway(p: Painter, spec: RoadSpec) {
  const section = crossSection(spec);
  const layout = markingLayout(spec);
  const m = spec.markings;
  const west = -p.reach([0, 0], [-1, 0]);
  const east = p.reach([0, 0], [1, 0]);
  const a: P = [west, 0];
  const b: P = [east, 0];
  const paved = section.pavedHalfWidthForward;
  p.paveStrip(a, b, -paved, paved);
  p.verge(a, b, paved, paved + VERGE_WIDTH);
  p.verge(a, b, -paved, -paved - VERGE_WIDTH);
  p.obstacle(a, b, paved + VERGE_WIDTH + 1);

  // Lines are laid out from x = 0 so the 6 m / 12 m pattern is the same on every lane.
  const line = (t: number) => [[west, t], [east, t]] as P[];
  const phase = (style: { dash: number; gap: number }) => (style.dash > 0 ? -west % (style.dash + style.gap) : 0);
  // Positive offsets are right of +x, i.e. +z: the eastbound carriageway.
  for (const t of [...layout.forwardLanes, ...layout.backwardLanes]) p.styled(line(t), m.laneLine, "white", phase(m.laneLine));
  for (const t of [layout.forwardEdge, layout.backwardEdge, layout.forwardInnerEdge, layout.backwardInnerEdge]) {
    if (t !== undefined) p.styled(line(t), m.edgeLine);
  }

  p.barrier(a, b);
  // Guardrail 0.5 m into the verge, rail facing the road (road on the left of a→b).
  const rail = paved + 0.5;
  p.guardrail([east, rail], [west, rail]);
  p.guardrail([west, -rail], [east, -rail]);
  return { paved, rail };
}

const highway: Layout = {
  id: "highway",
  site: { width: 160, depth: 70 },
  camera: { position: [-58, 17, 24], target: [18, 0, 2] },
  build(p) {
    const { rail } = motorway(p, AUTOBAHN);
    const post = rail + 1.2;
    p.gantry(34, -post, post, [
      { z: laneCenter(1) + 1, lines: ["EXIT 21", "→ Riverside"] },
      { z: laneCenter(3), lines: ["Ring Road", "Centre ↑"] },
    ]);
    p.finish();
  },
  vehicles: [
    { id: "e-truck", kind: "truck", poseAt: cruise(-120, 22.5, 1, steady(3)) },
    { id: "e-van", kind: "van", poseAt: cruise(-30, 25, 1, steady(3)) },
    { id: "e-silver", poseAt: cruise(-70, 30, 1, laneChange(2, 1, 6, 4)) },
    { id: "e-graphite", poseAt: cruise(35, 29, 1, steady(2)) },
    { id: "e-black", poseAt: cruise(-160, 37, 1, steady(1)) },
    { id: "e-red", poseAt: cruise(-10, 34, 1, steady(1)) },
    { id: "w-white", poseAt: cruise(120, 35, -1, steady(1)) },
    { id: "w-blue", poseAt: cruise(40, 31, -1, steady(2)) },
    { id: "w-truck", kind: "truck", poseAt: cruise(90, 21.5, -1, steady(3)) },
    { id: "w-van", kind: "van", poseAt: cruise(-20, 26, -1, laneChange(3, 2, 14, 5)) },
  ],
};

const layouts = new Map<string, Layout>([
  [roundaboutLayout.id, roundaboutLayout],
  [apache.id, apache],
  [highway.id, highway],
]);

export function getLayout(id: string) {
  return layouts.get(id);
}

/** Adds a layout built at runtime (AI and measured reconstructions, see incident/engine.ts). Replaces one with the same id. */
export function registerLayout(layout: Layout) {
  layouts.set(layout.id, layout);
}
