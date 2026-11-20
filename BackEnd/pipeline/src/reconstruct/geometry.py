"""Scene frame, mosaic crops, and camera orientation.

World frame: meters, seconds, Y-up. The origin is a point on the median.
The road runs along X. Carriageway A heads −X (positive Z). Carriageway B
heads +X (negative Z). Heading 0 faces +X. Positive heading is a right-handed
yaw about +Y and turns a vehicle toward −Z.

Quaternion order everywhere in the package is [x, y, z, w].

Mosaic pixel y grows downward from the top left. That is not the 3D Y axis.
"""

from __future__ import annotations

import math

import numpy as np

from reconstruct.models import Crop


def quintic(u: float) -> float:
    """Smoothstep with zero velocity and acceleration at both ends."""
    return u * u * u * (u * (u * 6.0 - 15.0) + 10.0)


def lane_center_z(
    carriageway: str,
    lane: int,
    *,
    lane_width_m: float,
    median_half_width_m: float,
) -> float:
    """Lane 0 is the inner lane. Offset grows toward the outside of the road."""
    if lane < 0:
        raise ValueError(f"lane index {lane} is negative")
    offset = median_half_width_m + lane_width_m * (lane + 0.5)
    if carriageway == "a":
        return offset
    if carriageway == "b":
        return -offset
    raise ValueError(f"unknown carriageway {carriageway!r}")


def wrap_heading_deg(degrees: float) -> float:
    """Wrap into (−180, 180], with the branch cut stored as +180."""
    wrapped = (degrees + 180.0) % 360.0 - 180.0
    if wrapped <= -180.0 or abs(wrapped + 180.0) < 1e-8:
        return 180.0
    return wrapped


def yaw_quaternion(heading_rad: float) -> tuple[float, float, float, float]:
    """Vehicle quaternion for a yaw about +Y. Returns [x, y, z, w]."""
    half = heading_rad * 0.5
    return (0.0, math.sin(half), 0.0, math.cos(half))


def heading_forward(heading_deg: float) -> tuple[float, float, float]:
    """Unit forward vector. 0° is +X, positive heading points toward −Z."""
    theta = math.radians(heading_deg)
    return (math.cos(theta), 0.0, -math.sin(theta))


def quadrant_crops(
    width: int,
    height: int,
    column_gutter_x: tuple[int, int],
    row_gutter_y: tuple[int, int],
    letterbox_y: tuple[int, int],
) -> dict[str, Crop]:
    """Four view rectangles that tile the mosaic and skip gutters and letterbox.

    Keys are cam_tl, cam_tr, cam_bl, cam_br. Image y grows downward.
    """
    col0, col1 = column_gutter_x
    row0, row1 = row_gutter_y
    letter0, letter1 = letterbox_y
    if not (0 <= col0 <= col1 < width):
        raise ValueError("column gutter is outside the mosaic")
    if not (0 <= row0 <= row1 < height):
        raise ValueError("row gutter is outside the mosaic")
    if not (row1 < letter0 <= letter1 == height - 1):
        raise ValueError("letterbox must sit on the bottom edge, below the row gutter")

    left_w = col0
    right_x = col1 + 1
    right_w = width - right_x
    top_h = row0
    bot_y = row1 + 1
    bot_h = letter0 - bot_y
    if min(left_w, right_w, top_h, bot_h) <= 0:
        raise ValueError("gutter layout does not leave four positive view rectangles")

    return {
        "cam_tl": Crop(x=0, y=0, width=left_w, height=top_h),
        "cam_tr": Crop(x=right_x, y=0, width=right_w, height=top_h),
        "cam_bl": Crop(x=0, y=bot_y, width=left_w, height=bot_h),
        "cam_br": Crop(x=right_x, y=bot_y, width=right_w, height=bot_h),
    }


def crop_touches_span(crop: Crop, start: int, end: int, *, axis: str) -> bool:
    """True when the crop covers any pixel of an inclusive span on x or y."""
    if axis == "x":
        first, last = crop.x, crop.x + crop.width - 1
    elif axis == "y":
        first, last = crop.y, crop.y + crop.height - 1
    else:
        raise ValueError(axis)
    return not (last < start or first > end)


def crops_avoid_gutters(
    crops: dict[str, Crop],
    *,
    column_gutter_x: tuple[int, int],
    row_gutter_y: tuple[int, int],
    letterbox_y: tuple[int, int],
) -> None:
    for cam_id, crop in crops.items():
        if crop_touches_span(crop, *column_gutter_x, axis="x"):
            raise ValueError(f"{cam_id} crop covers the column gutter")
        if crop_touches_span(crop, *row_gutter_y, axis="y"):
            raise ValueError(f"{cam_id} crop covers the row gutter")
        if crop_touches_span(crop, *letterbox_y, axis="y"):
            raise ValueError(f"{cam_id} crop covers the letterbox")


def look_quaternion(
    eye: tuple[float, float, float] | np.ndarray,
    target: tuple[float, float, float] | np.ndarray,
) -> tuple[float, float, float, float]:
    """Camera-to-world quaternion. The camera looks down its local −Z axis."""
    eye_v = np.asarray(eye, dtype=float)
    target_v = np.asarray(target, dtype=float)
    forward = target_v - eye_v
    norm = float(np.linalg.norm(forward))
    if norm < 1e-8:
        raise ValueError("camera eye and target are the same point")
    forward /= norm
    z_axis = -forward
    up = np.array([0.0, 1.0, 0.0])
    x_axis = np.cross(up, z_axis)
    x_norm = float(np.linalg.norm(x_axis))
    if x_norm < 1e-8:
        raise ValueError("camera look direction is parallel to world up")
    x_axis /= x_norm
    y_axis = np.cross(z_axis, x_axis)
    rotation = np.column_stack([x_axis, y_axis, z_axis])
    return matrix_to_quaternion(rotation)


def matrix_to_quaternion(rotation: np.ndarray) -> tuple[float, float, float, float]:
    """Rotation matrix to [x, y, z, w]."""
    m = rotation
    trace = float(m[0, 0] + m[1, 1] + m[2, 2])
    if trace > 0.0:
        scale = math.sqrt(trace + 1.0) * 2.0
        w = 0.25 * scale
        x = (m[2, 1] - m[1, 2]) / scale
        y = (m[0, 2] - m[2, 0]) / scale
        z = (m[1, 0] - m[0, 1]) / scale
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        scale = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        w = (m[2, 1] - m[1, 2]) / scale
        x = 0.25 * scale
        y = (m[0, 1] + m[1, 0]) / scale
        z = (m[0, 2] + m[2, 0]) / scale
    elif m[1, 1] > m[2, 2]:
        scale = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        w = (m[0, 2] - m[2, 0]) / scale
        x = (m[0, 1] + m[1, 0]) / scale
        y = 0.25 * scale
        z = (m[1, 2] + m[2, 1]) / scale
    else:
        scale = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
        w = (m[1, 0] - m[0, 1]) / scale
        x = (m[0, 2] + m[2, 0]) / scale
        y = (m[1, 2] + m[2, 1]) / scale
        z = 0.25 * scale
    return _normalize_quat((float(x), float(y), float(z), float(w)))


def quat_rotate(
    quaternion: tuple[float, float, float, float],
    vector: tuple[float, float, float],
) -> tuple[float, float, float]:
    """Rotate a vector by a [x, y, z, w] quaternion."""
    x, y, z, w = quaternion
    vx, vy, vz = vector
    qx, qy, qz = x, y, z
    tx = 2.0 * (qy * vz - qz * vy)
    ty = 2.0 * (qz * vx - qx * vz)
    tz = 2.0 * (qx * vy - qy * vx)
    return (
        vx + w * tx + (qy * tz - qz * ty),
        vy + w * ty + (qz * tx - qx * tz),
        vz + w * tz + (qx * ty - qy * tx),
    )


def camera_forward(quaternion: tuple[float, float, float, float]) -> tuple[float, float, float]:
    """World direction the camera looks, which is local −Z."""
    return quat_rotate(quaternion, (0.0, 0.0, -1.0))


def _normalize_quat(q: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    norm = math.sqrt(sum(c * c for c in q))
    if norm < 1e-12:
        raise ValueError("zero quaternion")
    return tuple(c / norm for c in q)  # type: ignore[return-value]
