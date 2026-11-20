"""Write a scene package folder and copy the portable mosaic."""

from __future__ import annotations

import shutil
from pathlib import Path

from reconstruct.models import CamerasFile, EntitiesFile, EventsFile, Manifest, TracksFile
from reconstruct.splats import (
    highway_gaussians,
    vehicle_gaussians,
    write_ply,
    hex_to_rgb,
)
from reconstruct.steps.attributes import CLASS_LEGEND
from reconstruct.validate import validate_package


def write_package(
    package_dir: Path,
    manifest: Manifest,
    tracks: TracksFile,
    entities: EntitiesFile,
    events: EventsFile,
    cameras: CamerasFile,
    mosaic_source: Path,
    *,
    class_dims: dict[str, dict],
) -> list[str]:
    """Replace ``package_dir`` with a validated scene package. Returns any errors."""
    if package_dir.exists():
        shutil.rmtree(package_dir)
    package_dir.mkdir(parents=True)

    _write_model(package_dir / "manifest.json", manifest)
    _write_model(package_dir / "tracks.json", tracks)
    _write_model(package_dir / "entities.json", entities)
    _write_model(package_dir / "events.json", events)
    _write_model(package_dir / "cameras.json", cameras)

    write_ply(package_dir / f"background.{manifest.splat_format}", highway_gaussians())
    vehicles = package_dir / "vehicles"
    for vehicle_type, color in CLASS_LEGEND.items():
        dims = class_dims[vehicle_type]
        write_ply(
            vehicles / f"{vehicle_type}.{manifest.splat_format}",
            vehicle_gaussians(
                float(dims["length"]),
                float(dims["width"]),
                float(dims["height"]),
                hex_to_rgb(color["hex"]),
            ),
        )

    destination = package_dir / manifest.source.filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(mosaic_source, destination)

    return validate_package(package_dir)


def _write_model(path: Path, model) -> None:
    path.write_text(model.model_dump_json(indent=2) + "\n")
