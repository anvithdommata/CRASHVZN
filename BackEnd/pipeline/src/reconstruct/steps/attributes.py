"""Paint color and vehicle type, then make and model when a crop supports it.

Type is only ``car``, ``van``, or ``truck``. Make and model stay null until a
VLM sees a clean crop. A yaml override replaces the model value for that field.
Class overlay colors (cyan / yellow / green) are the manifest legend, not paint.
``paint_name`` buckets the median color sampled inside a tracked box.
"""

from __future__ import annotations

from reconstruct.models import Dims, Entity

LABEL_FIELDS = (
    "label",
    "color",
    "color_hex",
    "type",
    "make",
    "model",
    "carriageway",
    "confidence",
    "label_source",
    "aliases",
    "dims_m",
    "splat",
)

CLASS_LEGEND = {
    "car": {"name": "cyan", "hex": "#00E5FF"},
    "van": {"name": "yellow", "hex": "#FFD600"},
    "truck": {"name": "green", "hex": "#00C853"},
}

_VEHICLE_TYPES = ("car", "van", "truck")


def resolve_entities(
    model_labels: list[dict],
    overrides: dict[str, dict],
    default_dims: dict[str, dict],
) -> list[Entity]:
    """Merge detector labels with yaml overrides. Override keys win, including null.

    Ids that exist only in the overrides are kept, so a hand label can name a
    vehicle the tracker did not emit. Tracker labels are the default.
    """
    model_by_id = {item["id"]: item for item in model_labels}
    ordered_ids: list[str] = []
    for item in model_labels:
        if item["id"] not in ordered_ids:
            ordered_ids.append(item["id"])
    for entity_id in overrides:
        if entity_id not in ordered_ids:
            ordered_ids.append(entity_id)

    entities: list[Entity] = []
    for entity_id in ordered_ids:
        merged = {
            key: value
            for key, value in model_by_id.get(entity_id, {}).items()
            if key in LABEL_FIELDS
        }
        for key, value in overrides.get(entity_id, {}).items():
            if key not in LABEL_FIELDS:
                raise ValueError(f"{entity_id}: {key} is not an entity label field")
            merged[key] = value
        vehicle_type = merged.get("type")
        if vehicle_type not in _VEHICLE_TYPES:
            raise ValueError(
                f"{entity_id}: type must be car, van, or truck (got {vehicle_type!r})"
            )
        merged.setdefault("splat", f"vehicles/{vehicle_type}.ply")
        if "dims_m" not in merged or merged["dims_m"] is None:
            merged["dims_m"] = default_dims[vehicle_type]
        merged.setdefault("make", None)
        merged.setdefault("model", None)
        merged.setdefault("label_source", "manual")
        merged.setdefault("aliases", [merged["label"]])
        entities.append(Entity(id=entity_id, **_coerce(merged)))
    return entities


def paint_name(rgb: tuple[int, int, int]) -> tuple[str, str]:
    """Bucket a measured paint color. Returns ``(name, hex)``."""
    red, green, blue = (int(channel) for channel in rgb)
    saturation = max(red, green, blue) - min(red, green, blue)
    value = (red + green + blue) / 3.0
    if saturation < 42:
        if value >= 185:
            name = "white"
        elif value >= 145:
            name = "silver"
        elif value >= 75:
            name = "gray"
        else:
            name = "black"
    elif red > green + 25 and red > blue + 25 and green < 150:
        name = "red"
    elif red > 150 and green > 110 and blue < 120:
        name = "yellow" if green >= 150 else "orange"
    elif blue > red + 12 and blue >= green:
        name = "blue"
    elif green > red + 12 and green >= blue:
        name = "green"
    else:
        name = "gray"
    return name, f"#{red:02X}{green:02X}{blue:02X}"


def _coerce(merged: dict) -> dict:
    dims = merged["dims_m"]
    merged = dict(merged)
    merged["dims_m"] = dims if isinstance(dims, Dims) else Dims(**dims)
    return merged
