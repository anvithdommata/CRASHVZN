"""Fuse per-camera tracks that land on the same vehicle.

The two views of a carriageway do not share a measured camera position, so the
along-road offset between them is the median disagreement of pairs that already
sit in the same lane. Tracks in one camera are never merged with each other.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from pydantic import BaseModel, ConfigDict

from reconstruct.models import CarriagewayId, VehicleType


class LocalRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    camera_id: str
    local_id: str


class GlobalEntity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entity_id: str
    type: VehicleType
    members: list[LocalRef]


@dataclass
class LiftedLocal:
    camera_id: str
    local_id: str
    type: VehicleType
    paint_rgb: tuple[int, int, int]
    confidence: float
    samples: list[tuple[float, float, float, float]] = field(default_factory=list)
    """(t, x, z, weight) on the road."""


@dataclass(frozen=True)
class Association:
    type: VehicleType
    carriageway: CarriagewayId
    members: tuple[LocalRef, ...]
    times: tuple[float, ...]
    xs: tuple[float, ...]
    zs: tuple[float, ...]
    paint_rgb: tuple[int, int, int]
    confidence: float


def align_cameras(tracks: list[LiftedLocal]) -> float | None:
    """Shift every camera but the first so same-lane pairs agree along X.

    Returns the offset applied to the second camera, or None when there is
    nothing to align.
    """
    by_camera: dict[str, list[LiftedLocal]] = {}
    for track in tracks:
        by_camera.setdefault(track.camera_id, []).append(track)
    if len(by_camera) < 2:
        return None
    anchor, *others = list(by_camera)
    offset_used = None
    for other in others:
        diffs: list[float] = []
        for left in by_camera[anchor]:
            left_at = {round(t, 2): (x, z) for t, x, z, _weight in left.samples}
            for right in by_camera[other]:
                if left.type != right.type:
                    continue
                paired = [
                    left_at[round(t, 2)][0] - x
                    for t, x, z, _weight in right.samples
                    if round(t, 2) in left_at and abs(left_at[round(t, 2)][1] - z) < 2.5
                ]
                if len(paired) >= 4:
                    diffs.append(float(np.median(paired)))
        if len(diffs) < 2:
            continue
        offset = float(np.median(diffs))
        offset_used = offset
        for right in by_camera[other]:
            right.samples = [(t, x + offset, z, weight) for t, x, z, weight in right.samples]
    return offset_used


def associate(tracks: list[LiftedLocal], *, carriageway: CarriagewayId) -> list[Association]:
    """One association per physical vehicle on this carriageway."""
    unused = set(range(len(tracks)))
    order = sorted(unused, key=lambda index: len(tracks[index].samples), reverse=True)
    groups: list[list[int]] = []
    for index in order:
        if index not in unused:
            continue
        group = [index]
        unused.remove(index)
        for other in list(unused):
            if _agrees(tracks[index], tracks[other]):
                group.append(other)
                unused.remove(other)
        groups.append(group)
    fused = [_fuse(carriageway, [tracks[index] for index in group]) for group in groups]
    return [item for item in fused if len(item.times) >= 2]


def _agrees(left: LiftedLocal, right: LiftedLocal) -> bool:
    if left.camera_id == right.camera_id or left.type != right.type:
        return False
    left_at = {round(t, 2): (x, z) for t, x, z, _weight in left.samples}
    dx: list[float] = []
    dz: list[float] = []
    for t, x, z, _weight in right.samples:
        key = round(t, 2)
        if key not in left_at:
            continue
        other_x, other_z = left_at[key]
        dx.append(other_x - x)
        dz.append(other_z - z)
    if len(dx) < 4:
        return False
    return abs(float(np.median(dx))) < 6.0 and abs(float(np.median(dz))) < 2.2


def _fuse(carriageway: CarriagewayId, tracks: list[LiftedLocal]) -> Association:
    combined: dict[float, list[tuple[float, float, float]]] = {}
    paints: list[tuple[int, int, int]] = []
    weights: list[float] = []
    members: list[LocalRef] = []
    for track in tracks:
        members.append(LocalRef(camera_id=track.camera_id, local_id=track.local_id))
        paints.append(track.paint_rgb)
        weights.append(max(track.confidence, 1e-3) * max(len(track.samples), 1))
        for t, x, z, weight in track.samples:
            combined.setdefault(round(t, 2), []).append((x, z, max(weight, 1e-3)))
    times: list[float] = []
    xs: list[float] = []
    zs: list[float] = []
    for t in sorted(combined):
        points = combined[t]
        total = sum(weight for _x, _z, weight in points)
        times.append(t)
        xs.append(sum(x * weight for x, _z, weight in points) / total)
        zs.append(sum(z * weight for _x, z, weight in points) / total)
    paint_weight = sum(weights)
    paint = tuple(
        int(round(sum(color[channel] * weight for color, weight in zip(paints, weights)) / paint_weight))
        for channel in range(3)
    )
    confidence = float(min(1.0, max(track.confidence for track in tracks)))
    return Association(
        type=tracks[0].type,
        carriageway=carriageway,
        members=tuple(members),
        times=tuple(times),
        xs=tuple(xs),
        zs=tuple(zs),
        paint_rgb=paint,  # type: ignore[arg-type]
        confidence=confidence,
    )
