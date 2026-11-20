"""Build a scene package by tracking the vehicles in the mosaic.

Positions come from the class-colored boxes in the video, lifted onto the road
with the lane width and the configured focal length. Nothing in the package is
an authored trajectory.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml

from reconstruct import __version__
from reconstruct.geometry import camera_forward, look_quaternion
from reconstruct.models import (
    SCHEMA_VERSION,
    Camera,
    CamerasFile,
    Carriageways,
    ClassColor,
    ClassLegend,
    Crop,
    EntitiesFile,
    Event,
    EventsFile,
    Extrinsics,
    Intrinsics,
    Manifest,
    ModelRecord,
    MosaicLayout,
    Origin,
    PipelineInfo,
    Road,
    RoadCarriageway,
    Seeds,
    Sigma,
    SourceVideo,
    Track,
    TracksFile,
    Units,
)
from reconstruct.paths import repo_root
from reconstruct.steps.associate import (
    LiftedLocal,
    align_cameras,
    associate,
)
from reconstruct.steps.attributes import CLASS_LEGEND, paint_name, resolve_entities
from reconstruct.steps.boxes import detect_boxes
from reconstruct.steps.cache import write_step_cache
from reconstruct.steps.detect_track import LocalTrack, link_tracks
from reconstruct.steps.frames import iter_rgb_frames
from reconstruct.steps.ground import (
    GroundPlane,
    fit_ground,
    flipped_depth,
    flipped_lateral,
    pixel_to_xz,
)
from reconstruct.steps.ingest import ingest_mosaic
from reconstruct.steps.kinematics import (
    VIDEO_JERK_SIGMA,
    VIDEO_MEAS_SIGMA_M,
    brake_events,
    detect_impacts,
    incident_onset_s,
    lane_change_events,
    pass_events,
    rest_events,
    crash_rest_onset_s,
    smooth_track,
)
from reconstruct.steps.package import write_package
from reconstruct.steps.scale import cache_scale, scale_from_lane_width


@dataclass(frozen=True)
class BuildResult:
    package_dir: Path
    vehicles: int
    samples: int
    events: tuple[str, ...]
    sha256: str


def build_package(
    config_path: Path,
    out: Path | None = None,
    cache_dir: Path | None = None,
) -> BuildResult:
    config = yaml.safe_load(config_path.read_text())
    root = repo_root()
    package_dir = (out or (root / config["output"])).resolve()
    if package_dir.name != config["incident_id"]:
        raise ValueError(
            f"output directory must be named {config['incident_id']}, got {package_dir.name}"
        )
    if package_dir in {root.resolve(), Path("/").resolve(), Path.home().resolve()}:
        raise ValueError(f"refusing to replace {package_dir}")

    cache = cache_dir or (root / "BackEnd" / "pipeline" / ".cache" / config["incident_id"])
    mosaic = root / config["mosaic"]
    ingested = ingest_mosaic(mosaic, config, cache)
    sigma = Sigma(**config["sigma"])
    planes, local_tracks = _track_mosaic(mosaic, ingested, config)
    tracks, entities = _kinematics(local_tracks, planes, config, sigma, cache)
    if not tracks:
        raise RuntimeError("no vehicle tracks survived the road lift and the speed check")

    onset = incident_onset_s(tracks)
    impacts = _select_impacts(
        detect_impacts(
            tracks,
            separation_m=float(config["impact_separation_m"]),
            min_closing_mps=float(config["impact_min_closing_mps"]),
        ),
        tracks,
        onset_s=onset,
    )
    events = _events(tracks, impacts, config)
    impact_time = None if not impacts else round(min(impact.t for impact in impacts), 2)
    cameras = _cameras(config, ingested.crops)
    manifest = _manifest(config, config_path, ingested, impact_time)
    scale = scale_from_lane_width(float(config["lane_width_m"]))
    cache_scale(cache, scale)
    write_step_cache(
        cache,
        "kinematics",
        {
            "impacts": len(impacts),
            "events": [event.id for event in events],
            "meas_sigma_m": VIDEO_MEAS_SIGMA_M,
            "tracks": {
                track.entity_id: {
                    "samples": len(track.samples),
                    "t_start": track.visibility.t_start,
                    "t_end": track.visibility.t_end,
                    "mean_speed_mps": round(
                        sum(sample.speed_mps for sample in track.samples) / len(track.samples),
                        3,
                    ),
                }
                for track in tracks
            },
        },
    )
    write_step_cache(
        cache,
        "segment",
        {
            "status": "skipped",
            "reason": (
                "SAM 2 is not run. The class wireframes in demo.mp4 are the "
                "detections, and they are not vehicle masks."
            ),
        },
    )

    errors = write_package(
        package_dir,
        manifest,
        TracksFile(tracks=tracks),
        EntitiesFile(entities=entities),
        EventsFile(events=events),
        cameras,
        mosaic,
        class_dims=config["default_dims_m"],
    )
    if errors:
        raise RuntimeError("scene package failed validation:\n" + "\n".join(errors))
    return BuildResult(
        package_dir=package_dir,
        vehicles=len(entities),
        samples=sum(len(track.samples) for track in tracks),
        events=tuple(event.id for event in events),
        sha256=ingested.sha256,
    )


def _track_mosaic(mosaic: Path, ingested, config: dict):
    width = ingested.width
    height = ingested.height
    fps = float(ingested.fps)
    kept: list[np.ndarray] = []
    detections: dict[str, list[tuple[float, list]]] = {cam_id: [] for cam_id in ingested.crops}
    for index, frame in iter_rgb_frames(mosaic, width, height):
        t = round(index / fps, 2)
        if index % 12 == 0:
            kept.append(np.array(frame, copy=True))
        for cam_id, crop in ingested.crops.items():
            image = frame[crop.y : crop.y + crop.height, crop.x : crop.x + crop.width]
            detections[cam_id].append((t, detect_boxes(image)))
    if not kept:
        raise RuntimeError("the mosaic produced no frames")
    median = np.median(np.stack(kept), axis=0).astype(np.uint8)

    planes: dict[str, GroundPlane] = {}
    local: dict[str, list[LocalTrack]] = {}
    for cam_id, crop in ingested.crops.items():
        view = median[crop.y : crop.y + crop.height, crop.x : crop.x + crop.width]
        planes[cam_id] = _fit_camera(cam_id, view, config)
        local[cam_id] = link_tracks(cam_id, detections[cam_id])
    return planes, local


def _fit_camera(cam_id: str, view: np.ndarray, config: dict) -> GroundPlane:
    spec = config["cameras"][cam_id]
    carriageway = spec["carriageway"]
    heading = config["road_carriageways"][carriageway]["heading"]
    return fit_ground(
        view,
        camera_id=cam_id,
        carriageway=carriageway,
        camera_x=float(spec["eye"][0]),
        heading_sign=-1.0 if heading == "-X" else 1.0,
        fy=float(config["intrinsics"]["fy"]),
        lane_width_m=float(config["lane_width_m"]),
        median_half_width_m=float(config["median_half_width_m"]),
        lane_count=int(config["lanes_per_carriageway"]),
    )


def _kinematics(local, planes: dict[str, GroundPlane], config: dict, sigma: Sigma, cache: Path):
    x_min = float(config["x_min_m"])
    x_max = float(config["x_max_m"])
    pieces = []
    alignments: dict[str, float | None] = {}
    oriented: dict[str, dict] = {}
    for carriageway, cam_ids in _cameras_by_carriageway(config).items():
        chosen: dict[str, tuple[GroundPlane, list[LiftedLocal]]] = {}
        for cam_id in cam_ids:
            plane, lifted = _best_orientation(local[cam_id], planes[cam_id], x_min, x_max)
            chosen[cam_id] = (plane, lifted)
            oriented[cam_id] = {
                "outer_to_the_right": plane.outer_to_the_right,
                "depth_sign": plane.depth_sign,
                "lifted": len(lifted),
            }
            planes[cam_id] = plane
        grouped = [track for cam_id in cam_ids for track in chosen[cam_id][1]]
        alignments[carriageway] = align_cameras(grouped)
        for association in associate(grouped, carriageway=carriageway):
            pieces.extend(_uniform_pieces(association, dt=0.08))

    drafted: list[tuple[Track, dict]] = []
    for piece in pieces:
        heading = -1.0 if piece["carriageway"] == "a" else 1.0
        height = float(config["default_dims_m"][piece["type"]]["height"])
        track = smooth_track(
            "pending",
            piece["carriageway"],
            piece["times"],
            piece["xs"],
            piece["zs"],
            center_y=height / 2,
            sigma=sigma,
            meas_sigma=VIDEO_MEAS_SIGMA_M,
            jerk_sigma=VIDEO_JERK_SIGMA,
        )
        if _plausible(track, heading, x_min, x_max):
            drafted.append((track, piece))
    drafted = _collapse_duplicates(drafted)
    drafted.sort(key=lambda item: (item[0].visibility.t_start, item[0].samples[0].pos[0]))

    labels = []
    tracks = []
    for index, (track, piece) in enumerate(drafted, start=1):
        entity_id = f"v{index}"
        name, color_hex = paint_name(piece["paint_rgb"])
        label = f"{name} {piece['type']}"
        labels.append(
            {
                "id": entity_id,
                "label": label,
                "color": name,
                "color_hex": color_hex,
                "type": piece["type"],
                "carriageway": piece["carriageway"],
                "confidence": piece["confidence"],
                "label_source": "measured",
                "aliases": [label, f"the {label}"],
                "make": None,
                "model": None,
            }
        )
        tracks.append(track.model_copy(update={"entity_id": entity_id}))

    entities = resolve_entities(labels, config.get("label_overrides") or {}, config["default_dims_m"])
    known = {track.entity_id for track in tracks}
    entities = [entity for entity in entities if entity.id in known]
    by_id = {entity.id: entity for entity in entities}
    tracks = [
        track.model_copy(
            update={
                "samples": [
                    sample.model_copy(update={"pos": (sample.pos[0], by_id[track.entity_id].dims_m.height / 2, sample.pos[2])})
                    for sample in track.samples
                ]
            }
        )
        for track in tracks
    ]
    write_step_cache(
        cache,
        "detect_track",
        {
            "status": "measured",
            "source": "burned-in class boxes",
            "ground": {
                cam_id: {
                    "u_h": round(plane.u_h, 2),
                    "v_h": round(plane.v_h, 2),
                    "s0": round(plane.s0, 4),
                    "score": round(plane.score, 1),
                    "outer_to_the_right": plane.outer_to_the_right,
                    "depth_sign": plane.depth_sign,
                    "carriageway": plane.carriageway,
                }
                for cam_id, plane in planes.items()
            },
            "local_tracks": {cam_id: len(tracks) for cam_id, tracks in local.items()},
            "orientation": oriented,
        },
    )
    write_step_cache(
        cache,
        "associate",
        {
            "status": "measured",
            "alignment_m": {key: None if value is None else round(value, 2) for key, value in alignments.items()},
            "orientation": oriented,
            "vehicles": [entity.id for entity in entities],
        },
    )
    write_step_cache(
        cache,
        "attributes",
        {
            "status": "measured",
            "entities": [
                {"id": entity.id, "label": entity.label, "type": entity.type, "carriageway": entity.carriageway}
                for entity in entities
            ],
            "note": "Paint is the median color inside the wireframe. Make and model stay null.",
        },
    )
    return tracks, entities


def _best_orientation(local_tracks: list[LocalTrack], plane: GroundPlane, x_min: float, x_max: float):
    candidates = (
        plane,
        flipped_lateral(plane),
        flipped_depth(plane),
        flipped_depth(flipped_lateral(plane)),
    )
    ranked = []
    for candidate in candidates:
        lifted = _lift(local_tracks, candidate, x_min, x_max)
        ranked.append((_orientation_score(lifted, candidate.heading_sign), candidate, lifted))
    ranked.sort(key=lambda item: item[0], reverse=True)
    _score, chosen, lifted = ranked[0]
    return chosen, lifted


def _orientation_score(lifted: list[LiftedLocal], heading_sign: float) -> float:
    score = 0.0
    for track in lifted:
        times = np.asarray([sample[0] for sample in track.samples], dtype=float)
        xs = np.asarray([sample[1] for sample in track.samples], dtype=float)
        if float(times[-1] - times[0]) < 0.4:
            continue
        slope = float(np.polyfit(times, xs, 1)[0])
        if slope * heading_sign > 3.0:
            score += len(track.samples) * min(slope * heading_sign, 40.0)
    return score


def _lift(
    local_tracks: list[LocalTrack],
    plane: GroundPlane,
    x_min: float,
    x_max: float,
) -> list[LiftedLocal]:
    lifted: list[LiftedLocal] = []
    for track in local_tracks:
        samples: list[tuple[float, float, float, float]] = []
        paints: list[tuple[int, int, int]] = []
        scores: list[float] = []
        for box in track.boxes:
            point = pixel_to_xz(plane, box.contact_uv[0], box.contact_uv[1])
            if point is None:
                continue
            x, z = point
            if x < x_min or x > x_max:
                continue
            samples.append((box.t, x, z, max(box.score, 0.05)))
            paints.append(box.paint_rgb)
            scores.append(box.score)
        if len(samples) < 4:
            continue
        paint = tuple(int(np.median([color[channel] for color in paints])) for channel in range(3))
        lifted.append(
            LiftedLocal(
                camera_id=track.camera_id,
                local_id=track.local_id,
                type=track.type,
                paint_rgb=paint,  # type: ignore[arg-type]
                confidence=float(np.mean(scores)),
                samples=samples,
            )
        )
    return lifted


def _uniform_pieces(association, dt: float) -> list[dict]:
    times = list(association.times)
    xs = list(association.xs)
    zs = list(association.zs)
    chunks: list[list[tuple[float, float, float]]] = [[(times[0], xs[0], zs[0])]]
    for index in range(1, len(times)):
        steps = int(round((times[index] - chunks[-1][-1][0]) / dt))
        if steps == 1:
            chunks[-1].append((times[index], xs[index], zs[index]))
        elif steps == 2:
            previous = chunks[-1][-1]
            mid_t = round(previous[0] + dt, 2)
            chunks[-1].append((mid_t, 0.5 * (previous[1] + xs[index]), 0.5 * (previous[2] + zs[index])))
            chunks[-1].append((times[index], xs[index], zs[index]))
        else:
            chunks.append([(times[index], xs[index], zs[index])])
    pieces = []
    for chunk in chunks:
        if len(chunk) < 4:
            continue
        pieces.append(
            {
                "type": association.type,
                "carriageway": association.carriageway,
                "paint_rgb": association.paint_rgb,
                "confidence": association.confidence,
                "times": [sample[0] for sample in chunk],
                "xs": [sample[1] for sample in chunk],
                "zs": [sample[2] for sample in chunk],
            }
        )
    return pieces


def _collapse_duplicates(drafted: list[tuple[Track, dict]]) -> list[tuple[Track, dict]]:
    """Drop the shorter of two tracks that occupy the same space at the same time."""
    drop: set[int] = set()
    for index, (left, _piece) in enumerate(drafted):
        if index in drop:
            continue
        left_at = {round(sample.t, 2): sample.pos for sample in left.samples}
        for other_index in range(index + 1, len(drafted)):
            if other_index in drop:
                continue
            right, _other = drafted[other_index]
            if left.carriageway != right.carriageway:
                continue
            distances = [
                math.dist(left_at[round(sample.t, 2)], sample.pos)
                for sample in right.samples
                if round(sample.t, 2) in left_at
            ]
            if len(distances) >= 3 and float(np.median(distances)) < 4.0:
                loser = other_index if len(right.samples) <= len(left.samples) else index
                drop.add(loser)
                if loser == index:
                    break
    return [item for index, item in enumerate(drafted) if index not in drop]


def _plausible(track: Track, heading_sign: float, x_min: float, x_max: float) -> bool:
    """Keep moving traffic and on-road stopped / braking vehicles from the crash.

    Near-stationary lift noise is rejected by requiring a stable footprint or a
    clear deceleration into rest. Absolute highway speed is only a weak gate
    because along-road scale comes from the configured focal length.
    """
    sign = 1.0 if track.carriageway == "a" else -1.0
    if any(sample.pos[2] * sign <= 0 for sample in track.samples):
        return False
    if any(sample.pos[0] < x_min - 0.5 or sample.pos[0] > x_max + 0.5 for sample in track.samples):
        return False

    speeds = [sample.speed_mps for sample in track.samples]
    med_speed = float(np.median(speeds))
    if med_speed > 48.0:
        return False
    along = [heading_sign * sample.vel[0] for sample in track.samples]
    med_along = float(np.median(along))
    net_along = heading_sign * (track.samples[-1].pos[0] - track.samples[0].pos[0])
    duration = track.visibility.t_end - track.visibility.t_start
    xs = [sample.pos[0] for sample in track.samples]
    zs = [sample.pos[2] for sample in track.samples]

    moving = (
        med_speed >= 5.0
        and med_along >= 3.0
        and net_along >= 4.0
        and all(value >= 0.0 for value in along)
    )
    if moving:
        return True

    # Decelerating into the incident (was moving, ends slow).
    braking = (
        duration >= 1.0
        and len(track.samples) >= 8
        and float(np.median(speeds[: max(2, len(speeds) // 4)])) >= 5.0
        and float(np.median(speeds[-max(2, len(speeds) // 4) :])) <= 3.0
        and med_along >= -1.0
    )
    if braking:
        return True

    # Stopped / crawling after a crash: long enough, spatially stable, on-road.
    resting = (
        duration >= 1.5
        and len(track.samples) >= 12
        and med_speed <= 4.0
        and float(np.std(xs)) <= 10.0
        and float(np.std(zs)) <= 3.5
    )
    return resting


def _select_impacts(impacts, tracks: list[Track], *, onset_s: float | None):
    """Keep the primary crash wave; drop later secondary hits into the pile-up."""
    by_id = {track.entity_id: track for track in tracks}
    candidates = []
    for impact in impacts:
        left = by_id[impact.vehicles[0]]
        right = by_id[impact.vehicles[1]]
        if (
            impact.closing_mps >= 4.0
            or impact.separation_m <= 8.0
            or _slow_after(left, impact.t)
            or _slow_after(right, impact.t)
        ):
            candidates.append(impact)
    if not candidates:
        return []

    rests = [
        (onset, track.carriageway)
        for track in tracks
        for onset in [crash_rest_onset_s(track)]
        if onset is not None
    ]

    def support(impact) -> int:
        carriageway = by_id[impact.vehicles[0]].carriageway
        return sum(
            1
            for onset, other_carriageway in rests
            if other_carriageway == carriageway and impact.t - 2.0 <= onset <= impact.t + 10.0
        )

    scored = [(support(impact), impact) for impact in candidates]
    best_support = max(score for score, _impact in scored)
    if onset_s is not None:
        # Stay on the carriageway of the onset contact (demo crash is on B).
        onset_hits = [impact for impact in candidates if abs(impact.t - onset_s) <= 0.5]
        carriageway = (
            by_id[onset_hits[0].vehicles[0]].carriageway if onset_hits else None
        )
        near_onset = [
            impact
            for impact in candidates
            if abs(impact.t - onset_s) <= 3.0
            and (
                carriageway is None
                or by_id[impact.vehicles[0]].carriageway == carriageway
            )
        ]
        if near_onset:
            return sorted(near_onset, key=lambda item: (item.t, item.vehicles))

    if best_support >= 3:
        bar = max(4, int(0.7 * best_support + 0.999))
        wave = [impact for score, impact in scored if score >= bar]
        if wave:
            start = min(impact.t for impact in wave)
            carriageway = by_id[wave[0].vehicles[0]].carriageway
            return sorted(
                [
                    impact
                    for impact in wave
                    if abs(impact.t - start) <= 5.0
                    and by_id[impact.vehicles[0]].carriageway == carriageway
                ],
                key=lambda item: (item.t, item.vehicles),
            )

    earliest = min(candidates, key=lambda impact: (impact.t, -impact.closing_mps))
    return [impact for impact in candidates if abs(impact.t - earliest.t) <= 5.0]


def _slow_after(track: Track, t0: float) -> bool:
    later = [sample for sample in track.samples if sample.t >= t0]
    if not later:
        return False
    window = later[: max(4, len(later) // 3)]
    return float(np.median([sample.speed_mps for sample in window])) <= 4.0


def _events(tracks: list[Track], impacts, config: dict) -> list[Event]:
    lane_width = float(config["lane_width_m"])
    separation = float(config["impact_separation_m"])
    events = []
    for impact in impacts:
        left, right = impact.vehicles
        if impact.separation_m > separation:
            note = (
                f"Incident onset involving {left} and {right} "
                f"({impact.separation_m:.1f} m apart). "
                "One crash participant may lack a complete box track."
            )
        else:
            note = (
                f"Centers are {impact.separation_m:.1f} m apart and closing at "
                f"{impact.closing_mps:.1f} m/s."
            )
        events.append(
            Event(
                id=f"impact-{left}-{right}",
                t=impact.t,
                type="impact",
                vehicles=[left, right],
                note=note,
            )
        )
    events.extend(brake_events(tracks))
    events.extend(rest_events(tracks))
    events.extend(lane_change_events(tracks, lane_width))
    events.extend(pass_events(tracks, lane_width, min_separation_m=separation))
    events.sort(key=lambda event: (event.t, event.id))
    return _unique_event_ids(events)


def _unique_event_ids(events: list[Event]) -> list[Event]:
    seen: dict[str, int] = {}
    unique: list[Event] = []
    for event in events:
        count = seen.get(event.id, 0)
        seen[event.id] = count + 1
        if count:
            event = event.model_copy(update={"id": f"{event.id}-{count + 1}"})
        unique.append(event)
    return unique


def _cameras_by_carriageway(config: dict) -> dict[str, list[str]]:
    grouped = {"a": [], "b": []}
    for cam_id, spec in config["cameras"].items():
        grouped[spec["carriageway"]].append(cam_id)
    return grouped


def _cameras(config: dict, crops: dict[str, Crop]) -> CamerasFile:
    intrinsics = config["intrinsics"]
    cameras: list[Camera] = []
    for cam_id, crop in crops.items():
        spec = config["cameras"][cam_id]
        eye = tuple(float(v) for v in spec["eye"])
        target = tuple(float(v) for v in spec["target"])
        quaternion = look_quaternion(eye, target)
        forward = camera_forward(quaternion)
        heading = config["road_carriageways"][spec["carriageway"]]["heading"]
        if heading == "-X" and forward[0] >= 0:
            raise RuntimeError(f"{cam_id} should look along −X")
        if heading == "+X" and forward[0] <= 0:
            raise RuntimeError(f"{cam_id} should look along +X")
        if forward[1] >= 0:
            raise RuntimeError(f"{cam_id} should look downward")
        cameras.append(
            Camera(
                id=cam_id,
                static=True,
                mosaic_crop=crop,
                intrinsics=Intrinsics(
                    model="pinhole",
                    width=crop.width,
                    height=crop.height,
                    fx=float(intrinsics["fx"]),
                    fy=float(intrinsics["fy"]),
                    cx=float(intrinsics["cx"]),
                    cy=float(intrinsics["cy"]),
                ),
                extrinsics=Extrinsics(
                    convention="camera_to_world_opengl",
                    position_m=tuple(round(v, 3) for v in eye),  # type: ignore[arg-type]
                    quaternion=tuple(round(c, 6) for c in quaternion),  # type: ignore[arg-type]
                ),
                note=str(spec["note"]),
            )
        )
    return CamerasFile(cameras=cameras)


def _manifest(config: dict, config_path: Path, ingested, impact_time: float | None) -> Manifest:
    root = repo_root()
    try:
        config_rel = str(config_path.resolve().relative_to(root))
    except ValueError:
        config_rel = str(config_path)
    legend = ClassLegend(**{name: ClassColor(**color) for name, color in CLASS_LEGEND.items()})
    road_cfg = config["road_carriageways"]
    return Manifest(
        id=config["incident_id"],
        schema_version=SCHEMA_VERSION,
        description=str(config["description"]),
        fps=ingested.fps,
        duration_s=ingested.duration_s,
        frame_count=ingested.frame_count,
        impact_time_s=None if impact_time is None else round(impact_time, 2),
        units=Units(length="m", time="s"),
        up_axis="Y",
        crs="local",
        origin=Origin(
            landmark="median",
            description="A point on the median, midway along the reconstructed stretch.",
        ),
        source=SourceVideo(
            filename="sources/mosaic.mp4",
            sha256=ingested.sha256,
            codec=ingested.codec,
            width=ingested.width,
            height=ingested.height,
            fps=ingested.fps,
            duration_s=ingested.duration_s,
            frame_count=ingested.frame_count,
            has_audio=ingested.has_audio,
        ),
        mosaic=MosaicLayout(
            width=ingested.width,
            height=ingested.height,
            image_origin="top-left",
            column_gutter_x=(int(config["gutters"]["column_x"][0]), int(config["gutters"]["column_x"][1])),
            row_gutter_y=(int(config["gutters"]["row_y"][0]), int(config["gutters"]["row_y"][1])),
            letterbox_y=(int(config["gutters"]["letterbox_y"][0]), int(config["gutters"]["letterbox_y"][1])),
        ),
        road=Road(
            stretch_m=float(config["stretch_m"]),
            x_min_m=float(config["x_min_m"]),
            x_max_m=float(config["x_max_m"]),
            lane_width_m=float(config["lane_width_m"]),
            lanes_per_carriageway=int(config["lanes_per_carriageway"]),
            shoulder=bool(config["shoulder"]),
            median_half_width_m=float(config["median_half_width_m"]),
            carriageways=Carriageways(
                a=RoadCarriageway(
                    heading=road_cfg["a"]["heading"],
                    z_sign=int(road_cfg["a"]["z_sign"]),
                    cameras=list(road_cfg["a"]["cameras"]),
                ),
                b=RoadCarriageway(
                    heading=road_cfg["b"]["heading"],
                    z_sign=int(road_cfg["b"]["z_sign"]),
                    cameras=list(road_cfg["b"]["cameras"]),
                ),
            ),
        ),
        tracks_are_schematic=False,
        splat_format="ply",
        models=[ModelRecord(**record) for record in config["models"]],
        seeds=Seeds(**config["seeds"]),
        class_legend=legend,
        pipeline=PipelineInfo(
            name="reconstruct",
            version=__version__,
            command="reconstruct build",
            config=config_rel,
        ),
    )
