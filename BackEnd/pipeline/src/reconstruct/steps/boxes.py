"""Class-colored wireframes burned into a camera crop.

Cars are cyan, vans yellow, trucks green. Those are the legend colors, not paint.
Compression shifts the pixels, so the masks are loose on purpose. Paint is the
median color inside the box after those overlay pixels are removed.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import ndimage

from reconstruct.models import VehicleType

_CLASS_ORDER: tuple[VehicleType, ...] = ("car", "van", "truck")


@dataclass(frozen=True)
class RawBox:
    type: VehicleType
    x0: int
    y0: int
    x1: int
    y1: int
    contact_u: float
    contact_v: float
    score: float
    paint_rgb: tuple[int, int, int]

    @property
    def width(self) -> int:
        return self.x1 - self.x0 + 1

    @property
    def height(self) -> int:
        return self.y1 - self.y0 + 1


def class_masks(image: np.ndarray) -> dict[VehicleType, np.ndarray]:
    """Boolean masks for the three legend colors. A pixel belongs to one class."""
    red = image[:, :, 0].astype(np.int16)
    green = image[:, :, 1].astype(np.int16)
    blue = image[:, :, 2].astype(np.int16)
    saturation = image.max(axis=2).astype(np.int16) - image.min(axis=2).astype(np.int16)
    yellow = (
        (red > 145)
        & (green > 130)
        & (blue < 170)
        & ((red + green - 2 * blue) > 80)
        & (saturation > 40)
    )
    truck = (
        (green > red + 40)
        & (green > blue + 10)
        & (green > 120)
        & (saturation > 40)
        & ~yellow
    )
    car = (
        (blue > red + 40)
        & (blue + 10 >= green)
        & (green > red + 15)
        & (blue > 100)
        & (saturation > 35)
        & ~yellow
        & ~truck
    )
    return {"car": car, "van": yellow, "truck": truck}


def detect_boxes(image: np.ndarray) -> list[RawBox]:
    """One box per connected wireframe. ``image`` is one camera crop, RGB uint8."""
    masks = class_masks(image)
    found: list[RawBox] = []
    for vehicle_type in _CLASS_ORDER:
        found.extend(_boxes_of_type(image, masks[vehicle_type], vehicle_type))
    return found


def _boxes_of_type(image: np.ndarray, mask: np.ndarray, vehicle_type: VehicleType) -> list[RawBox]:
    if not np.any(mask):
        return []
    structure = ndimage.generate_binary_structure(2, 1)
    closed = ndimage.binary_dilation(mask, structure=structure, iterations=1)
    labels, count = ndimage.label(closed)
    if count == 0:
        return []
    boxes: list[RawBox] = []
    for label_id, slices in enumerate(ndimage.find_objects(labels), start=1):
        if slices is None:
            continue
        region = labels[slices] == label_id
        area = int(region.sum())
        if area < 40:
            continue
        rows, cols = np.nonzero(region)
        y0 = int(rows.min() + slices[0].start)
        y1 = int(rows.max() + slices[0].start)
        x0 = int(cols.min() + slices[1].start)
        x1 = int(cols.max() + slices[1].start)
        width = x1 - x0 + 1
        height = y1 - y0 + 1
        if width < 12 or height < 12 or width > 100 or height > 90:
            continue
        if height > width * 4 or width > height * 4:
            continue
        if x0 <= 1 or y0 <= 1 or x1 >= mask.shape[1] - 2 or y1 >= mask.shape[0] - 2:
            continue
        wire = mask[y0 : y1 + 1, x0 : x1 + 1]
        wire_count = int(wire.sum())
        fraction = wire_count / float(width * height)
        if wire_count < 16 or not 0.04 <= fraction <= 0.55:
            continue
        contact_u, contact_v = _contact(wire, x0, y0)
        paint = _paint(image[y0 : y1 + 1, x0 : x1 + 1], wire)
        score = float(min(1.0, int(wire.sum()) / 80.0))
        boxes.append(
            RawBox(
                type=vehicle_type,
                x0=x0,
                y0=y0,
                x1=x1,
                y1=y1,
                contact_u=contact_u,
                contact_v=contact_v,
                score=score,
                paint_rgb=paint,
            )
        )
    return boxes


def _contact(wire: np.ndarray, x0: int, y0: int) -> tuple[float, float]:
    """Ground contact: the center of the lowest wireframe pixels."""
    rows, cols = np.nonzero(wire)
    lowest = rows.max()
    band = rows >= lowest - max(1, int(0.12 * wire.shape[0]))
    return (float(cols[band].mean() + x0), float(rows[band].mean() + y0))


def _paint(crop: np.ndarray, wire: np.ndarray) -> tuple[int, int, int]:
    """Median color inside the box, ignoring the overlay wires and the border."""
    height, width = wire.shape
    inset_y = max(1, height // 8)
    inset_x = max(1, width // 8)
    interior = np.zeros_like(wire)
    interior[inset_y : height - inset_y, inset_x : width - inset_x] = True
    keep = interior & ~wire
    pixels = crop[keep]
    if len(pixels) < 8:
        pixels = crop[~wire]
    if len(pixels) == 0:
        pixels = crop.reshape(-1, 3)
    center = np.median(pixels.astype(np.float32), axis=0)
    distance = np.linalg.norm(pixels.astype(np.float32) - center, axis=1)
    chosen = pixels[distance >= np.percentile(distance, 70)]
    if len(chosen) < 4:
        chosen = pixels
    median = np.median(chosen, axis=0)
    return tuple(int(channel) for channel in median)  # type: ignore[return-value]
