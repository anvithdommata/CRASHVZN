"""Metric scale from a known lane width.

The schematic scene is authored in meters, so one scene unit is one meter.
A later step can pass the lane width in pixels and get meters per pixel.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from reconstruct.steps.cache import write_step_cache


@dataclass(frozen=True)
class MetricScale:
    lane_width_m: float
    meters_per_unit: float
    meters_per_pixel: float | None
    method: str


def scale_from_lane_width(
    lane_width_m: float = 3.5,
    lane_width_px: float | None = None,
) -> MetricScale:
    """Meters from the configured lane width. Default lane is 3.5 m."""
    if lane_width_m <= 0:
        raise ValueError("lane width must be positive")
    meters_per_pixel = None
    if lane_width_px is not None:
        if lane_width_px <= 0:
            raise ValueError("lane width in pixels must be positive")
        meters_per_pixel = lane_width_m / lane_width_px
    return MetricScale(
        lane_width_m=lane_width_m,
        meters_per_unit=1.0,
        meters_per_pixel=meters_per_pixel,
        method="lane_width",
    )


def cache_scale(cache_dir: Path, scale: MetricScale) -> None:
    write_step_cache(
        cache_dir,
        "scale",
        {
            "method": scale.method,
            "lane_width_m": scale.lane_width_m,
            "meters_per_unit": scale.meters_per_unit,
            "meters_per_pixel": scale.meters_per_pixel,
        },
    )
