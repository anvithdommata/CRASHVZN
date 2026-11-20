# Lane system

Lanes come from three sources, in order of trust: **measured paint** (prepared demo only), the
**LLM's road reading** combined with regional design standards, and **per-vehicle lane hints** from
the camera census. Lanes control **how the road is drawn** and **where census-only vehicles are
placed**. They never move a vehicle that has its own keyframes (see [Lanes and vehicle motion](#lanes-and-vehicle-motion)).

Code: `src/road/spec.ts` (standards, `resolveRoadSpec`, `crossSection`), `src/incident/engine.ts`
(`roadFor`, `measuredDividedRoad`, `measuredLines`), `src/scene/layouts.ts` and `src/scene/roads/*`
(drawing), `src/incident/motion.ts` (`LaneModel`, census placement),
`electron/demo-incident/build-measured-spec.py` (measured lines).

## Conventions

- Lane positions are **lateral offsets in the plan frame** (y, positive left of +x travel).
  Right-hand traffic: the +x ("forward") carriageway is at **negative y**, the −x ("backward") one at
  positive y. On a divided highway y = 0 is the median barrier.
- `LaneModel = { forward: number[]; backward: number[] }`: plan-y of each lane **centre**, innermost
  (next to the median or centre line) first.
- Census `lane_from_median`: 1 = the lane next to the median, counting outward.

Cross-section of a divided highway with three lanes each way, looking along +x (plan frame; the
scene's z is −y). Measured roads use the same layout with their own line offsets and lane count:

```text
  plan y (m): +12.0     +8.25     +4.5  +0.75 0 −0.75  −4.5     −8.25     −12.0
                │         │         │     │   ║   │     │         │         │
                │ lane 3  │ lane 2  │ l.1 │   ║   │ l.1 │ lane 2  │ lane 3  │
                │         │         │     │   ║   │     │         │         │
              outer     lane      lane  inner │ inner lane      lane     outer
              edge      line      line  edge  │ edge  line      line     edge
                                              median barrier
          backward carriageway (−x traffic)       forward carriageway (+x traffic)

  lane_lines_backward_m = [0.75, 4.5, 8.25, 12.0]    lane_lines_forward_m = [0.75, 4.5, 8.25, 12.0]
  LaneModel.backward    = [+2.6, +6.4, +10.1]         LaneModel.forward    = [−2.6, −6.4, −10.1]
```

The line offsets are distances from the median, so both lists are positive; the sign comes from the
side. The numbers shown are illustrative 3.75 m lanes with a 0.75 m inner shoulder.

## Source 1: regional standards (every LLM-built scene)

Pass 1 reports `road.kind` (`straight`, `divided_highway`, `intersection`, `roundabout`), `region`
(`US`, `DE`, `EU`), `road_class` and `lanes_each_way`. `roadFor` turns that into a `RoadSpec` with
`resolveRoadSpec`, whose lane width comes from `STANDARDS[region][class]`:

| Class | US | DE / EU |
| --- | --- | --- |
| motorway | 12 ft (3.66 m) | 3.75 m |
| arterial | 11 ft (3.35 m) | 3.25 m |
| collector | 11 ft | 3.0 m |
| local | 10 ft (3.05 m) | 2.75 m |

`EU` reuses the German tables. A divided highway always uses the motorway class. Lane counts default
to motorway 3, arterial 2, collector and local 1 per direction when nothing better is known.
`resolveRoadSpec` records provenance per value (`standard`, `database` or `observed`).

`crossSection(spec)` then lays the lanes out from the centre line: start at `medianHalf + innerShoulder`
(divided) or 0, and lane *i*'s centre is `start + laneWidth · (i + ½)`. `roadFor` flips the sign into
plan-y to build the `LaneModel`.

## Source 2: measured paint (prepared demo)

The spec may carry `road.lane_lines_forward_m` and `road.lane_lines_backward_m`: every painted line of
each carriageway as a **distance from the median barrier**, inner edge line first, each lane line, outer
edge line last (n lanes = n + 1 values). `measuredLines` accepts them only if there are 2–9 values,
increasing, with every gap between 2 and 6 m. If both sides pass:

- Lane centres are the midpoints of consecutive lines. They override `lanes_each_way` and the
  standard width, so lanes can differ in width per lane and per side.
- `measuredDividedRoad` draws edge lines at the first and last values, dashed lane lines between,
  pavement, verges, guardrails, and a barrier unless the spec has a static `barrier` object.

`build-measured-spec.py` produces these lines from the calibrated crash camera (`br_camera.json`).
The current demo has **six crash-side strips**, not the older symmetric three lanes. Some of these may be
auxiliary or exit lanes, so don't describe them all as through lanes without checking the footage.
Lane membership in the track audits (`measure/review_tracks/REVIEW-COMPLETE.md`) uses lanes
L0–L7, where L0 and L7 lie beyond the inner and outer edge lines.

## Source 3: census lane hints

The census prompt (`vision-prompts/census.md`) asks each camera for every vehicle's `toward_camera` and
`lane_from_median`. `applyCensus` (`spec.ts`) merges sightings of the same vehicle and builds a
`LaneHint`:

- `direction`: `with` (+x) or `against` (−x), by majority vote. Each camera's `plus_x_traffic` from
  pass 1 converts "toward the camera" into ±x. Unknown cameras assume +x comes toward the camera.
- `lane_from_median`: median of the sightings, clamped to 1–6.
- `first_seen_s`, `last_seen_s`, mean `speed_mps`, `stopped`, `cameras`.

## Lanes and vehicle motion

`planMotion` uses the `LaneModel` for one thing: placing **census-only** vehicles, which have a lane hint
but no keyframes. Such a vehicle drives the centre of lane `lane_from_median` on its direction's side
at its census speed, passing the site's origin halfway through its on-camera window; a stopped one
waits upstream in that lane. Its position along the road is an assumption and its `adjustments` say
so (details in [vision-pipeline.md](vision-pipeline.md#from-keyframes-to-per-frame-vectors)).

Every vehicle with keyframes keeps exactly the lateral positions it reported:

- Vehicles are not snapped to lane centres. An LLM vehicle can sit between lanes or on a line.
- Lane changes appear only if the keyframes show them. In the measured demo they come from per-frame
  tracking. In LLM scenes they depend on keyframe density.
- A matched pass-1 object's `lane_hint` is kept in the spec for reference but doesn't move it.

An earlier version snapped background traffic to lanes, ran an IDM car-following model, queued
vehicles behind the crash and relocated ones that overlapped it. It was removed because those
queues and relocations invented traffic behaviour the footage didn't show (see
[the Nov 15 handoff](history/2026-11-15-handoff.md), "do not create a generic pile-up"). If
lane-aware placement comes back, keep observed positions authoritative and record every adjustment in
`PlannedVehicle.adjustments`.
