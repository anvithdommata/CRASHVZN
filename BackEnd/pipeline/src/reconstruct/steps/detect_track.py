"""Track the class-colored boxes in one camera.

The mosaic already has a wireframe on each vehicle. YOLO is not run on those
pixels: it would trace the overlay. Each camera gets its own track ids.
Association across cameras happens after the boxes are lifted onto the road.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from pydantic import BaseModel, ConfigDict, Field

from reconstruct.models import VehicleType
from reconstruct.steps.boxes import RawBox, detect_boxes


class Box(BaseModel):
    model_config = ConfigDict(extra="forbid")

    t: float
    xyxy: tuple[float, float, float, float]
    score: float = Field(ge=0, le=1)
    type: VehicleType
    contact_uv: tuple[float, float]
    paint_rgb: tuple[int, int, int]


class LocalTrack(BaseModel):
    """A track id that exists inside one camera only."""

    model_config = ConfigDict(extra="forbid")

    camera_id: str
    local_id: str
    type: VehicleType
    boxes: list[Box]


def detect_and_track(
    frames: Iterable[tuple[float, object]],
    camera_id: str,
) -> list[LocalTrack]:
    """Detect and track one crop.

    ``frames`` yields ``(t_seconds, rgb_crop)``. ``camera_id`` is one of
    cam_tl, cam_tr, cam_bl, cam_br.
    """
    series: list[tuple[float, list[RawBox]]] = []
    for t, image in frames:
        series.append((float(t), detect_boxes(image)))  # type: ignore[arg-type]
    return link_tracks(camera_id, series)


def link_tracks(
    camera_id: str,
    series: Sequence[tuple[float, Sequence[RawBox]]],
) -> list[LocalTrack]:
    """Greedy overlap tracker. A box that misses three frames in a row ends."""
    active: list[_OpenTrack] = []
    closed: list[_OpenTrack] = []
    for t, boxes in series:
        pool = [box for box in boxes]
        used = [False] * len(pool)
        order = sorted(active, key=lambda item: item.boxes[-1].width * item.boxes[-1].height, reverse=True)
        for track in order:
            match = _best_match(track, pool, used)
            if match is None:
                track.gap += 1
                continue
            used[match] = True
            track.boxes.append(pool[match])
            track.times.append(t)
            track.gap = 0
        retiring = [track for track in active if track.gap > 2]
        for track in retiring:
            active.remove(track)
            if len(track.boxes) >= 2:
                closed.append(track)
        active = [track for track in active if track.gap <= 2]
        for index, box in enumerate(pool):
            if used[index]:
                continue
            opened = _OpenTrack(vehicle_type=box.type)
            opened.boxes.append(box)
            opened.times.append(t)
            active.append(opened)
    for track in active:
        if len(track.boxes) >= 2:
            closed.append(track)
    return [_export(camera_id, index, track) for index, track in enumerate(closed, start=1)]


class _OpenTrack:
    def __init__(self, vehicle_type: VehicleType) -> None:
        self.vehicle_type: VehicleType = vehicle_type
        self.boxes: list[RawBox] = []
        self.times: list[float] = []
        self.gap = 0


def _best_match(track: _OpenTrack, boxes: Sequence[RawBox], used: list[bool]) -> int | None:
    previous = track.boxes[-1]
    prediction = _predict(track)
    best_index = None
    best_score = 0.15
    for index, box in enumerate(boxes):
        if used[index] or box.type != track.vehicle_type:
            continue
        overlap = _iou(prediction, box)
        if overlap > best_score:
            best_score = overlap
            best_index = index
    if best_index is not None:
        return best_index
    # A small or distant box can move more than its own size between frames.
    limit = max(18.0, 0.85 * max(previous.width, previous.height))
    best_distance = limit
    for index, box in enumerate(boxes):
        if used[index] or box.type != track.vehicle_type:
            continue
        distance = _center_distance(prediction, box)
        if distance < best_distance:
            best_distance = distance
            best_index = index
    return best_index


def _predict(track: _OpenTrack) -> RawBox:
    current = track.boxes[-1]
    if len(track.boxes) < 2:
        return current
    earlier = track.boxes[-2]
    return RawBox(
        type=current.type,
        x0=int(round(current.x0 + (current.x0 - earlier.x0))),
        y0=int(round(current.y0 + (current.y0 - earlier.y0))),
        x1=int(round(current.x1 + (current.x1 - earlier.x1))),
        y1=int(round(current.y1 + (current.y1 - earlier.y1))),
        contact_u=current.contact_u,
        contact_v=current.contact_v,
        score=current.score,
        paint_rgb=current.paint_rgb,
    )


def _iou(left: RawBox, right: RawBox) -> float:
    x0 = max(left.x0, right.x0)
    y0 = max(left.y0, right.y0)
    x1 = min(left.x1, right.x1)
    y1 = min(left.y1, right.y1)
    if x1 <= x0 or y1 <= y0:
        return 0.0
    intersection = (x1 - x0) * (y1 - y0)
    union = left.width * left.height + right.width * right.height - intersection
    if union <= 0:
        return 0.0
    return intersection / union


def _center_distance(left: RawBox, right: RawBox) -> float:
    du = (left.x0 + left.x1) / 2 - (right.x0 + right.x1) / 2
    dv = (left.y0 + left.y1) / 2 - (right.y0 + right.y1) / 2
    return (du * du + dv * dv) ** 0.5


def _export(camera_id: str, index: int, track: _OpenTrack) -> LocalTrack:
    boxes = [
        Box(
            t=t,
            xyxy=(float(box.x0), float(box.y0), float(box.x1), float(box.y1)),
            score=box.score,
            type=box.type,
            contact_uv=(box.contact_u, box.contact_v),
            paint_rgb=box.paint_rgb,
        )
        for t, box in zip(track.times, track.boxes, strict=True)
    ]
    return LocalTrack(
        camera_id=camera_id,
        local_id=f"{camera_id}-{index}",
        type=track.vehicle_type,
        boxes=boxes,
    )
