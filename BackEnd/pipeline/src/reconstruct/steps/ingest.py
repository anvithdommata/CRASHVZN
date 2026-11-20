"""Hash and probe the mosaic. The four quadrants already share one clock."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from reconstruct.geometry import crops_avoid_gutters, quadrant_crops
from reconstruct.models import Crop
from reconstruct.steps.cache import write_step_cache


@dataclass(frozen=True)
class IngestResult:
    sha256: str
    codec: str
    width: int
    height: int
    fps: float
    duration_s: float
    frame_count: int
    has_audio: bool
    crops: dict[str, Crop]
    sync_offset_s: None = None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_media(path: Path) -> dict:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def ingest_mosaic(path: Path, config: dict, cache_dir: Path) -> IngestResult:
    """SHA-256 and ffprobe. Crop rects come from the gutter layout, not from a detector.

    No sync offset is estimated. The mosaic is already a single clock.
    """
    if not path.is_file():
        raise FileNotFoundError(f"mosaic not found: {path}")

    probed = _video_facts(probe_media(path))
    _expect_close("fps", probed["fps"], float(config["fps"]), 0.01)
    _expect_close("duration_s", probed["duration_s"], float(config["duration_s"]), 0.01)
    _expect_equal("width", probed["width"], int(config["width"]))
    _expect_equal("height", probed["height"], int(config["height"]))
    _expect_equal("frame_count", probed["frame_count"], int(config["frame_count"]))
    _expect_equal("has_audio", probed["has_audio"], bool(config["has_audio"]))

    gutters = config["gutters"]
    column = (int(gutters["column_x"][0]), int(gutters["column_x"][1]))
    row = (int(gutters["row_y"][0]), int(gutters["row_y"][1]))
    letterbox = (int(gutters["letterbox_y"][0]), int(gutters["letterbox_y"][1]))
    crops = quadrant_crops(probed["width"], probed["height"], column, row, letterbox)
    crops_avoid_gutters(
        crops,
        column_gutter_x=column,
        row_gutter_y=row,
        letterbox_y=letterbox,
    )
    _expect_config_crops(crops, config["crops"])

    result = IngestResult(
        sha256=sha256_file(path),
        codec=probed["codec"],
        width=probed["width"],
        height=probed["height"],
        fps=probed["fps"],
        duration_s=probed["duration_s"],
        frame_count=probed["frame_count"],
        has_audio=probed["has_audio"],
        crops=crops,
        sync_offset_s=None,
    )
    write_step_cache(
        cache_dir,
        "ingest",
        {
            "sha256": result.sha256,
            "codec": result.codec,
            "width": result.width,
            "height": result.height,
            "fps": result.fps,
            "duration_s": result.duration_s,
            "frame_count": result.frame_count,
            "has_audio": result.has_audio,
            "sync_offset_s": None,
            "sync_note": "The mosaic is one clock. No inter-video offset is estimated.",
            "crops": {cam_id: crop.model_dump() for cam_id, crop in crops.items()},
        },
    )
    return result


def _video_facts(probe: dict) -> dict:
    streams = probe.get("streams", [])
    video = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if len(video) != 1:
        raise ValueError(f"expected one video stream, found {len(video)}")
    stream = video[0]
    fps = _parse_rate(str(stream.get("avg_frame_rate") or stream.get("r_frame_rate")))
    duration = float(stream.get("duration") or probe["format"]["duration"])
    if stream.get("nb_frames"):
        frame_count = int(stream["nb_frames"])
    else:
        frame_count = int(round(duration * fps))
    return {
        "codec": str(stream.get("codec_name")),
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": fps,
        "duration_s": duration,
        "frame_count": frame_count,
        "has_audio": bool(audio),
    }


def _parse_rate(text: str) -> float:
    if "/" in text:
        numerator, denominator = text.split("/", 1)
        return float(numerator) / float(denominator)
    return float(text)


def _expect_config_crops(crops: dict[str, Crop], configured: dict) -> None:
    if set(crops) != set(configured):
        raise ValueError(
            f"config crops {sorted(configured)} do not match the four quadrant ids {sorted(crops)}"
        )
    for cam_id, crop in crops.items():
        raw = configured[cam_id]
        stated = Crop(
            x=int(raw["x"]),
            y=int(raw["y"]),
            width=int(raw["width"]),
            height=int(raw["height"]),
        )
        if stated != crop:
            raise ValueError(
                f"{cam_id} crop {stated.model_dump()} does not tile the gutters "
                f"(expected {crop.model_dump()})"
            )


def _expect_equal(name: str, actual, expected) -> None:
    if actual != expected:
        raise ValueError(f"{name}: probe says {actual}, config says {expected}")


def _expect_close(name: str, actual: float, expected: float, tolerance: float) -> None:
    if abs(actual - expected) > tolerance:
        raise ValueError(f"{name}: probe says {actual}, config says {expected}")
