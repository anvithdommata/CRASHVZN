"""Flat-road homography from the lane dashes in one camera.

Lane lines on the ground meet at a vanishing point. Their image spacing grows
linearly below that point. The configured lane width turns that spacing into
meters across the road. The configured focal length turns it into meters along
the road. Longitudinal scale therefore follows the intrinsics until a measured
focal length replaces them.

Traffic on carriageway A heads −X and sits at positive Z. Carriageway B heads
+X and sits at negative Z. ``depth_sign`` flips if a camera is looking along
traffic instead of at oncoming vehicles.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

from reconstruct.models import CarriagewayId


@dataclass(frozen=True)
class GroundPlane:
    camera_id: str
    carriageway: CarriagewayId
    u_h: float
    v_h: float
    s0: float
    outer_to_the_right: bool
    camera_x: float
    heading_sign: float
    depth_sign: float
    fy: float
    lane_width_m: float
    median_half_width_m: float
    lane_count: int
    score: float


def pixel_to_xz(plane: GroundPlane, u: float, v: float) -> tuple[float, float] | None:
    """Road (x, z) for a pixel in the camera crop. None when the ray misses the lanes."""
    denom = float(v) - plane.v_h
    if denom < 12.0:
        return None
    spacing = plane.s0 * denom
    if spacing < 6.0:
        return None
    depth = plane.fy * plane.lane_width_m / spacing
    if not 4.0 <= depth <= 250.0:
        return None
    inner_u = plane.u_h - (plane.lane_count / 2.0) * spacing
    lateral_px = float(u) - inner_u if plane.outer_to_the_right else inner_u - float(u)
    lateral_m = lateral_px / spacing * plane.lane_width_m
    outer_limit = plane.lane_width_m * (plane.lane_count + 1.2)
    if lateral_m < 0.0 or lateral_m > outer_limit:
        return None
    z_magnitude = plane.median_half_width_m + lateral_m
    z = z_magnitude if plane.heading_sign < 0 else -z_magnitude
    x = plane.camera_x - plane.heading_sign * plane.depth_sign * depth
    return (float(x), float(z))


def fit_ground(
    crop: np.ndarray,
    *,
    camera_id: str,
    carriageway: CarriagewayId,
    camera_x: float,
    heading_sign: float,
    fy: float,
    lane_width_m: float,
    median_half_width_m: float,
    lane_count: int,
) -> GroundPlane:
    """Fit the lane fan on a median image of one crop. The road is static; vehicles are not."""
    peaks = _lane_peaks(crop)
    points = [(y, x) for y, xs in peaks.items() for x in xs]
    if len(points) < 20:
        raise RuntimeError(f"{camera_id}: not enough lane-mark peaks to fit a ground plane")
    best: tuple[float, float, float, float] | None = None
    for v_h in np.arange(-120.0, 70.0, 5.0):
        for s0 in np.arange(0.12, 0.95, 0.04):
            usable = [(y, x) for y, x in points if y - v_h >= 16.0]
            if len(usable) < 12:
                continue
            score, u_h = _best_center(usable, v_h, float(s0), lane_count)
            if best is None or score > best[0]:
                best = (score, float(u_h), float(v_h), float(s0))
    if best is None:
        raise RuntimeError(f"{camera_id}: the lane fan did not fit")
    score, u_h, v_h, s0 = best
    score, u_h, v_h, s0 = _refine(points, score, u_h, v_h, s0, lane_count)
    if score < 25:
        raise RuntimeError(f"{camera_id}: lane fan score {score:.0f} is too low to trust")
    value = crop.mean(axis=2)
    outer_to_the_right = float(value[:, -70:].mean()) > float(value[:, :70].mean())
    return GroundPlane(
        camera_id=camera_id,
        carriageway=carriageway,
        u_h=u_h,
        v_h=v_h,
        s0=s0,
        outer_to_the_right=outer_to_the_right,
        camera_x=camera_x,
        heading_sign=heading_sign,
        depth_sign=1.0,
        fy=fy,
        lane_width_m=lane_width_m,
        median_half_width_m=median_half_width_m,
        lane_count=lane_count,
        score=score,
    )


def _refine(
    points: list[tuple[int, int]],
    score: float,
    u_h: float,
    v_h: float,
    s0: float,
    lane_count: int,
) -> tuple[float, float, float, float]:
    best = (score, u_h, v_h, s0)
    for v_try in np.arange(v_h - 8.0, v_h + 8.1, 2.0):
        for s_try in np.arange(s0 - 0.06, s0 + 0.061, 0.015):
            if s_try <= 0.05:
                continue
            usable = [(y, x) for y, x in points if y - v_try >= 16.0]
            if len(usable) < 12:
                continue
            found, u_try = _best_center(usable, float(v_try), float(s_try), lane_count, u_hint=u_h)
            if found > best[0]:
                best = (found, u_try, float(v_try), float(s_try))
    return best


def _best_center(
    points: list[tuple[int, int]],
    v_h: float,
    s0: float,
    lane_count: int,
    u_hint: float | None = None,
) -> tuple[float, float]:
    by_row: dict[int, list[int]] = {}
    for y, x in points:
        by_row.setdefault(y, []).append(x)
    rows = []
    for y, xs in by_row.items():
        spacing = s0 * (y - v_h)
        if spacing < 6.0:
            continue
        rows.append((y, spacing, xs))
    if not rows:
        return (0.0, 0.0 if u_hint is None else u_hint)
    if u_hint is None:
        centers = np.arange(30.0, 450.0, 6.0)
    else:
        centers = np.arange(u_hint - 36.0, u_hint + 36.1, 3.0)
    best_score = -1.0
    best_u = float(centers[0])
    last_line = lane_count  # k = 0..lane_count inclusive, the lane edges
    for u_h in centers:
        hits = 0.0
        rows_used = 0
        for _y, spacing, xs in rows:
            matched: set[int] = set()
            for x in xs:
                k = int(round((x - u_h) / spacing + lane_count / 2.0))
                if 0 <= k <= last_line and abs((k - lane_count / 2.0) * spacing - (x - u_h)) <= 7.0:
                    matched.add(k)
            if len(matched) >= 2:
                hits += len(matched)
                rows_used += 1
        score = hits + 0.25 * rows_used
        if score > best_score:
            best_score = score
            best_u = float(u_h)
    return (best_score, best_u)


def _lane_peaks(crop: np.ndarray) -> dict[int, list[int]]:
    """Bright thin ridges on each sampled row. Wide snow banks do not peak."""
    value = crop.mean(axis=2)
    peaks: dict[int, list[int]] = {}
    kernel = np.ones(31) / 31.0
    for y in range(30, value.shape[0] - 10, 6):
        row = value[y]
        blur = np.convolve(row, kernel, mode="same")
        high = row - blur
        found: list[int] = []
        for x in range(10, len(row) - 10):
            if high[x] < 14 or row[x] < 135:
                continue
            if high[x] >= high[x - 1] and high[x] > high[x + 1]:
                if found and x - found[-1] < 12:
                    if high[x] > high[found[-1]]:
                        found[-1] = x
                else:
                    found.append(x)
        if found:
            peaks[y] = found
    return peaks


def flipped_lateral(plane: GroundPlane) -> GroundPlane:
    return replace(plane, outer_to_the_right=not plane.outer_to_the_right)


def flipped_depth(plane: GroundPlane) -> GroundPlane:
    return replace(plane, depth_sign=-plane.depth_sign)
