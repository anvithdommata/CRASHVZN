"""Schema and folder checks for a scene package directory."""

from __future__ import annotations

import json
import math
from pathlib import Path

from jsonschema import Draft202012Validator

from reconstruct.geometry import crop_touches_span
from reconstruct.models import (
    CamerasFile,
    EntitiesFile,
    EventsFile,
    Manifest,
    ScenePackage,
    TracksFile,
)
from reconstruct.paths import schema_dir
from reconstruct.steps.ingest import sha256_file

_FILES = {
    "manifest": ("manifest.json", Manifest),
    "tracks": ("tracks.json", TracksFile),
    "entities": ("entities.json", EntitiesFile),
    "events": ("events.json", EventsFile),
    "cameras": ("cameras.json", CamerasFile),
}


def validate_package(package_dir: Path) -> list[str]:
    """Return a list of problems. An empty list means the package matches the contract."""
    package_dir = package_dir.resolve()
    errors: list[str] = []
    loaded: dict[str, object] = {}
    raw: dict[str, object] = {}

    for key, (filename, model) in _FILES.items():
        path = package_dir / filename
        if not path.is_file():
            errors.append(f"missing {filename}")
            continue
        try:
            data = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            errors.append(f"{filename}: {exc}")
            continue
        raw[key] = data
        schema_errors = _schema_errors(filename, data)
        errors.extend(schema_errors)
        if schema_errors:
            continue
        try:
            loaded[key] = model.model_validate(data)
        except Exception as exc:  # pydantic.ValidationError
            errors.append(f"{filename}: {exc}")

    if len(loaded) != len(_FILES):
        return errors

    package = ScenePackage(
        manifest=loaded["manifest"],  # type: ignore[arg-type]
        tracks=loaded["tracks"],  # type: ignore[arg-type]
        entities=loaded["entities"],  # type: ignore[arg-type]
        events=loaded["events"],  # type: ignore[arg-type]
        cameras=loaded["cameras"],  # type: ignore[arg-type]
    )
    errors.extend(consistency_errors(package, package_dir))
    return errors


def consistency_errors(package: ScenePackage, package_dir: Path | None = None) -> list[str]:
    errors: list[str] = []
    manifest = package.manifest
    entities = {entity.id: entity for entity in package.entities.entities}
    if len(entities) != len(package.entities.entities):
        errors.append("entity ids are not unique")
    track_ids = [track.entity_id for track in package.tracks.tracks]
    if len(track_ids) != len(set(track_ids)):
        errors.append("track entity ids are not unique")
    if set(track_ids) != set(entities):
        errors.append("track ids and entity ids do not match")

    event_ids = [event.id for event in package.events.events]
    if len(event_ids) != len(set(event_ids)):
        errors.append("event ids are not unique")

    dt = 1.0 / manifest.fps
    for track in package.tracks.tracks:
        entity = entities.get(track.entity_id)
        if entity is not None and entity.carriageway != track.carriageway:
            errors.append(f"{track.entity_id}: track carriageway does not match the entity")
        if not track.samples:
            continue
        times = [sample.t for sample in track.samples]
        if times != sorted(times) or len(times) != len(set(times)):
            errors.append(f"{track.entity_id}: sample times must be strictly increasing")
        if abs(track.visibility.t_start - times[0]) > 1e-6 or abs(track.visibility.t_end - times[-1]) > 1e-6:
            errors.append(f"{track.entity_id}: visibility must match the first and last sample")
        if track.visibility.t_end < track.visibility.t_start:
            errors.append(f"{track.entity_id}: visibility ends before it starts")
        for earlier, later in zip(times, times[1:]):
            if abs((later - earlier) - dt) > 1e-4:
                errors.append(f"{track.entity_id}: samples are not at {manifest.fps} Hz")
                break
        for sample in track.samples:
            if sample.t < track.visibility.t_start - 1e-6 or sample.t > track.visibility.t_end + 1e-6:
                errors.append(f"{track.entity_id}: sample at t={sample.t} is outside its visibility")
                break
            quat_norm = math.sqrt(sum(c * c for c in sample.quat))
            if abs(quat_norm - 1.0) > 1e-3:
                errors.append(f"{track.entity_id}: quaternion at t={sample.t} is not unit length")
                break
            speed = math.hypot(sample.vel[0], sample.vel[1], sample.vel[2])
            if abs(speed - sample.speed_mps) > 0.02:
                errors.append(f"{track.entity_id}: speed_mps does not match vel at t={sample.t}")
                break

    known = set(entities)
    impact_times = []
    for event in package.events.events:
        missing = [vehicle for vehicle in event.vehicles if vehicle not in known]
        if missing:
            errors.append(f"event {event.id} references unknown vehicles {missing}")
        if event.type == "impact":
            impact_times.append(event.t)
        for vehicle in event.vehicles:
            track = next((item for item in package.tracks.tracks if item.entity_id == vehicle), None)
            if track is None:
                continue
            if event.t < track.visibility.t_start - 1e-6 or event.t > track.visibility.t_end + 1e-6:
                errors.append(f"event {event.id} is outside {vehicle}'s visibility")

    if impact_times and manifest.impact_time_s is None:
        errors.append("an impact event is present but impact_time_s is null")
    if manifest.impact_time_s is not None and not impact_times:
        errors.append("impact_time_s is set but there is no impact event")
    if impact_times and manifest.impact_time_s is not None:
        if abs(min(impact_times) - manifest.impact_time_s) > 1e-3:
            errors.append("impact_time_s does not match the earliest impact event")

    cam_ids = [camera.id for camera in package.cameras.cameras]
    if len(cam_ids) != len(set(cam_ids)):
        errors.append("camera ids are not unique")
    mosaic = manifest.mosaic
    for camera in package.cameras.cameras:
        crop = camera.mosaic_crop
        if crop_touches_span(crop, *mosaic.column_gutter_x, axis="x"):
            errors.append(f"{camera.id} crop covers the column gutter")
        if crop_touches_span(crop, *mosaic.row_gutter_y, axis="y"):
            errors.append(f"{camera.id} crop covers the row gutter")
        if crop_touches_span(crop, *mosaic.letterbox_y, axis="y"):
            errors.append(f"{camera.id} crop covers the letterbox")
        right = crop.x + crop.width
        bottom = crop.y + crop.height
        if right > mosaic.width or bottom > mosaic.height:
            errors.append(f"{camera.id} crop extends outside the mosaic")
        quat_norm = math.sqrt(sum(c * c for c in camera.extrinsics.quaternion))
        if abs(quat_norm - 1.0) > 1e-3:
            errors.append(f"{camera.id}: extrinsics quaternion is not unit length")

    if package_dir is None:
        return errors

    background = package_dir / f"background.{manifest.splat_format}"
    if not background.is_file():
        errors.append(f"missing {background.name}")
    for entity in package.entities.entities:
        try:
            splat = _safe_relative(package_dir, entity.splat)
        except ValueError as exc:
            errors.append(f"{entity.id}: {exc}")
            continue
        if not splat.is_file():
            errors.append(f"{entity.id}: missing splat {entity.splat}")
    try:
        source = _safe_relative(package_dir, manifest.source.filename)
    except ValueError as exc:
        errors.append(str(exc))
        source = None
    if source is not None:
        if not source.is_file():
            errors.append(f"missing {manifest.source.filename}")
        elif sha256_file(source) != manifest.source.sha256:
            errors.append("mosaic sha256 does not match the manifest")
    if manifest.source.width != mosaic.width or manifest.source.height != mosaic.height:
        errors.append("source resolution does not match the mosaic")
    return errors


def _schema_errors(filename: str, data: object) -> list[str]:
    stem = filename.removesuffix(".json")
    schema_path = schema_dir() / f"{stem}.schema.json"
    schema = json.loads(schema_path.read_text())
    validator = Draft202012Validator(schema)
    messages = []
    for error in sorted(validator.iter_errors(data), key=lambda item: list(item.path)):
        location = "/".join(str(part) for part in error.path) or "(root)"
        messages.append(f"{filename}: {location}: {error.message}")
    return messages


def _safe_relative(package_dir: Path, relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"path escapes the package: {relative}")
    resolved = (package_dir / path).resolve()
    if not resolved.is_relative_to(package_dir.resolve()):
        raise ValueError(f"path escapes the package: {relative}")
    return resolved
