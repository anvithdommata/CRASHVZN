"""SAM 2 masks prompted by the fused boxes. Clean frames only."""

from __future__ import annotations

from collections.abc import Iterable

from pydantic import BaseModel, ConfigDict

from reconstruct.errors import StepNotRun
from reconstruct.steps.associate import GlobalEntity


class MaskTrack(BaseModel):
    """Per-frame masks for one entity. ``mask_png`` paths are cache files."""

    model_config = ConfigDict(extra="forbid")

    entity_id: str
    frames: list[str]


def segment(frames: Iterable[object], entities: list[GlobalEntity]) -> list[MaskTrack]:
    """Prompt SAM 2 with the fused boxes. ``frames`` must be clean, without burned-in boxes."""
    del frames, entities
    raise StepNotRun(
        "segment is not run on demo.mp4. SAM 2 is prompted by fused boxes and "
        "only on clean frames. The burned-in wireframes are not vehicle masks."
    )
