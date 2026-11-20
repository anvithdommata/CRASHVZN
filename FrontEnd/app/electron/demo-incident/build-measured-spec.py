"""
Builds incident-spec.json (the app's measured reconstruction of demo.mp4 / demo_32s.mp4, 0-32 s)
from the frame-by-frame measurements in measure/data/:

  br_camera.json    road geometry in the world frame W (lane centres, median)
  tracks_world.json every vehicle, one sample per video frame, in W
  crash_pair.json   the white van and the yellow car, per frame, plus contacts (overrides the
                    crash-flagged tracks in tracks_world.json)
  divider.json      measured fixed median verge, barrier and uncertain far hedge

Writes <output>.build.json with the actual transform, source SHA-256s and stable track-ID map.

World frame W (measure/README.md): X along the road AWAY from the camera, Y to the camera's RIGHT,
heading 0 = +X, 90 = +Y. The crash carriageway is at negative Y with traffic moving -X.

App plan frame (src/incident/spec.ts): x along the road with the crash carriageway's traffic moving
+x; y to the LEFT when facing +x; heading 0 = +x, 90 = +y. A vehicle driving toward the camera
(-X) faces +x, and its left is the camera's right (+Y), so

    plan_x = -(X - X_ref)        plan_y = Y - Y_median
    plan direction (cos h, sin h) = (-cos hW, sin hW)  =>  h = 180 - hW
    forces/velocities: (fx, fy)_plan = (-fx, fy)_W

Usage (from anywhere):  python build-measured-spec.py [--data DIR] [--out FILE] [--check]
"""
import argparse, hashlib, json, math, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
FPS = 12.5
DURATION = 32.0
LAST_FRAME = 399

# The road is drawn from the measured painted lines (spec.road.lane_lines_*_m, engine.ts measuredDividedRoad).

FORCE_CAUSES = {"braking", "accelerating", "steering", "impact", "sliding", "rolling_resistance", "drag", "coasting", "other"}
CATEGORY_DEFAULTS = {  # src/incident/spec.ts
    "sedan": (4.7, 1.82, 1500), "hatchback": (4.2, 1.78, 1250), "suv": (4.8, 1.92, 1900), "pickup": (5.6, 2.0, 2300),
    "van": (5.2, 2.0, 2200), "truck": (8.5, 2.5, 9000), "bus": (12, 2.55, 12000), "motorcycle": (2.1, 0.8, 250),
    "bicycle": (1.8, 0.6, 95), "pedestrian": (0.5, 0.5, 75), "other": (4.5, 1.8, 1500),
}


def wrap(deg):
    return (deg + 180.0) % 360.0 - 180.0


def to_plan_heading(h_w):
    return wrap(180.0 - h_w)


def category_of(cls, length):
    c = (cls or "").lower()
    for key, cat in (("hatch", "hatchback"), ("suv", "suv"), ("pickup", "pickup"), ("van", "van"), ("bus", "bus"),
                     ("truck", "truck"), ("lorry", "truck"), ("semi", "truck"), ("trailer", "truck"), ("motor", "motorcycle"),
                     ("bike", "bicycle"), ("bicycle", "bicycle"), ("person", "pedestrian"), ("pedestrian", "pedestrian"),
                     ("sedan", "sedan"), ("car", "sedan")):
        if key in c:
            if cat == "sedan" and length and length < 4.3:
                return "hatchback"
            return cat
    return "other"


def fnum(v, default=None):
    try:
        v = float(v)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# Road geometry from A1


def road_geometry(cam):
    """Painted lines from A1 -> (Y of plan y = 0, crash-side line offsets, right-side line offsets, all lines).

    Plan y = 0 is the median barrier (or, without one, midway between the inner edge lines). Offsets
    are distances from it, inner edge line first, outer edge last."""
    lines = cam.get("lines_Y") or cam.get("lines") or {}
    if isinstance(lines, list):  # [{"name", "Y"}]
        lines = {l.get("name", str(i)): l.get("Y") for i, l in enumerate(lines)}
    lines = {k: (fnum(v.get("Y")) if isinstance(v, dict) else fnum(v)) for k, v in lines.items()}
    lines = {k: v for k, v in lines.items() if v is not None}
    barrier = next((v for k, v in lines.items() if "barrier" in k.lower()), None)
    paint = {k: v for k, v in lines.items() if "barrier" not in k.lower()}
    crash_side = sorted((v for k, v in paint.items() if k.upper().startswith("L")), reverse=True)
    right_side = sorted(v for k, v in paint.items() if k.upper().startswith("R"))
    if len(crash_side) < 2 or len(right_side) < 2:
        raise SystemExit(f"br_camera.json: need the painted lines of both carriageways (got {lines})")
    y0 = barrier if barrier is not None and right_side[0] > barrier > crash_side[0] else (crash_side[0] + right_side[0]) / 2
    return y0, [y0 - y for y in crash_side], [y - y0 for y in right_side], lines


# ---------------------------------------------------------------------------


# Matches measuredDividedRoad in engine.ts: 200 m maximum site half-width + 650 m extension.
ROAD_ENDS_PLAN = (-850.0, 850.0)
SAMPLE_SOURCES = {"measured", "interpolated", "occluded-rest", "out-of-view-extrapolated", "edge-extrapolated"}


def plan_point(point, x_ref, y_med):
    if isinstance(point, dict):
        point = [point.get("x", point.get("X")), point.get("y", point.get("Y"))]
    return [round(x_ref - float(point[0]), 3), round(float(point[1]) - y_med, 3)]


def polygon_area(poly):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(poly, poly[1:] + poly[:1])) / 2


def static_objects(divider, x_ref, y_med):
    result = []
    for raw in ([divider] + divider.get("related_objects", [])) if divider else []:
        poly = [plan_point(p, x_ref, y_med) for p in raw["footprint_W"]]
        if poly[0] == poly[-1]:
            poly.pop()
        # Reflecting X reverses winding. Restore the schema's CCW plan-frame convention.
        if polygon_area(poly) < 0:
            poly.reverse()
        if len(poly) < 3 or polygon_area(poly) <= 0:
            raise ValueError(f"invalid static footprint: {raw['id']}")
        result.append({"id": raw["id"], "kind": raw.get("kind", "other"), "label": raw.get("label", raw["id"]),
                       "footprint_m": poly, "height_m": float(raw["height_m"]), "material": raw["material"],
                       "friction": float(raw["friction"]), "restitution": float(raw["restitution"]),
                       "stiffness_n_per_m": float(raw["stiffness_n_per_m"]), "immovable": True,
                       "source": raw.get("source", "inferred"), "sigma_m": float(raw.get("sigma_m", 0.3)),
                       "note": raw.get("note", "") + " " + raw.get("contact_params_source", "Contact parameters assumed.")})
    return result


def convert_contact(raw, x_ref, y_med, vehicle_ids, static_ids):
    frame = fnum(raw.get("frame", raw.get("f")))
    time = frame / FPS if frame is not None else fnum(raw.get("t_s", raw.get("t")))
    if time is None or not 0 <= time <= LAST_FRAME / FPS:
        raise ValueError(f"invalid contact time: {raw}")
    a, b = raw.get("a", "yellow-car"), raw.get("b", "white-van")
    if a not in vehicle_ids or b not in vehicle_ids | static_ids or a == b:
        raise ValueError(f"unknown contact participants: {a}, {b}")
    point = raw.get("W", raw.get("point_W", raw.get("point")))
    if point is None:
        raise ValueError("Contact needs a measured/inferred W point; no fallback contact is fabricated")
    px, py = plan_point(point, x_ref, y_med)
    normal = raw.get("normal_W")
    if normal is not None:
        if isinstance(normal, dict):
            normal = [normal.get("x", normal.get("X")), normal.get("y", normal.get("Y"))]
        nx, ny = -float(normal[0]), float(normal[1])
        if not math.isfinite(nx + ny) or math.hypot(nx, ny) < 1e-9:
            raise ValueError("Contact normal_W must be a finite nonzero vector from a to b")
        deg = wrap(math.degrees(math.atan2(ny, nx)))
    elif fnum(raw.get("normal_deg")) is not None:
        deg = to_plan_heading(float(raw["normal_deg"]))
    else:
        raise ValueError("Contact needs normal_W or legacy world normal_deg")
    result = {"a": a, "b": b, "t_s": round(time, 4), "x_m": px, "y_m": py, "normal_deg": round(deg, 5),
              "kind": "vehicle-static" if b in static_ids else "vehicle-vehicle",
              "source": "measured" if raw.get("source") == "measured" else "inferred",
              "note": str(raw.get("note", "Contact inferred from footage and fitted geometry; not instrumented."))}
    if frame is not None:
        if frame != int(frame):
            raise ValueError("Contact frame must be an integer source-video frame")
        result["frame"] = int(frame)
    for key in ("impulse_ns", "sigma_s"):
        value = fnum(raw.get(key))
        if value is not None:
            result[key] = max(0.0, value)
    return result


def edge_keyframes(kfs, samples):
    """Extend background endpoints at constant along-lane velocity, never changing observed samples.

    Stop at a drawn road end or the clip boundary. Lateral velocity is deliberately discarded;
    endpoint Y stays fixed even if the observed vehicle was changing lanes at that endpoint.
    """
    before, after = [], []
    for first, target in ((True, before), (False, after)):
        k, sample = (kfs[0], samples[0]) if first else (kfs[-1], samples[-1])
        vx = fnum(sample.get("vx"))
        if vx is None:
            a, b = (kfs[0], kfs[1]) if first else (kfs[-2], kfs[-1])
            v_plan = (b["x_m"] - a["x_m"]) / (b["t_s"] - a["t_s"])
        else:
            v_plan = -vx
        if abs(v_plan) < 0.3:
            continue
        # Generate on the source frame grid; also retain the exact road-edge crossing.
        edge = ROAD_ENDS_PLAN[0 if (v_plan > 0) == first else 1]
        t_edge = k["t_s"] + (edge - k["x_m"]) / v_plan
        lo, hi = (max(0.0, t_edge), k["t_s"]) if first else (k["t_s"], min(LAST_FRAME / FPS, t_edge))
        if hi <= lo + 1e-6:
            continue
        times = {round(f / FPS, 6) for f in range(math.ceil(lo * FPS), math.floor(hi * FPS) + 1)}
        times.add(round(lo if first else hi, 6))
        # Keep the exact outer crossing and drop a nearby frame-grid extrapolation if needed.
        ordered = sorted(times, reverse=not first)
        spaced = []
        for t in ordered:
            if not spaced or abs(t - spaced[-1]) >= 0.02:
                spaced.append(t)
        for t in sorted(spaced):
            if (first and t >= k["t_s"] - 1e-6) or (not first and t <= k["t_s"] + 1e-6):
                continue
            dt = t - k["t_s"]
            target.append({"t_s": t, "x_m": round(k["x_m"] + v_plan * dt, 3), "y_m": k["y_m"],
                           "heading_deg": 0.0 if v_plan > 0 else -180.0, "speed_mps": round(abs(v_plan), 3),
                           "src": "edge-extrapolated", "sigma_m": round(k.get("sigma_m", 0.5) + abs(dt) * 0.5, 3)})
    # Do not emit an almost-coincident edge/frame pair that replay would deduplicate.
    if before and kfs[0]["t_s"] - before[-1]["t_s"] < 0.02:
        before.pop()
    if after and after[0]["t_s"] - kfs[-1]["t_s"] < 0.02:
        after.pop(0)
    return before + kfs + after


def source_info(path, data=None):
    if data is None:
        with open(path, "rb") as fh:
            data = fh.read()
    return {"path": os.path.abspath(path), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default=os.path.join(HERE, "measure", "data"))
    ap.add_argument("--out", default=os.path.join(HERE, "incident-spec.json"))
    ap.add_argument("--check", action="store_true", help="only run coordinate and static geometry checks")
    ap.add_argument("--omit-opposing", action="store_true", help="omit background traffic above the median in W")
    ap.add_argument("--extend-background-edges", action="store_true", help="diagnostic only: extend background endpoints to road ends; can create unsupported in-camera traffic")
    args = ap.parse_args()
    check_mapping()
    if args.check:
        return
    paths = {k: os.path.join(args.data, k + ".json") for k in ("br_camera", "tracks_world", "crash_pair", "divider")}
    # Hash the bytes actually parsed, even when another worker replaces a source during a build.
    loaded_sources = {}
    def load_source(key, default=None):
        path = paths[key]
        if default is not None and not os.path.exists(path):
            return default
        with open(path, "rb") as fh:
            data = fh.read()
        loaded_sources[key] = source_info(path, data)
        return json.loads(data)
    cam = load_source("br_camera")
    tw = load_source("tracks_world")
    cp = load_source("crash_pair", {})
    div = load_source("divider", {})
    synthetic = bool(tw.get("synthetic") or cp.get("synthetic"))
    extend_edges = synthetic or args.extend_background_edges
    y_med, lines_fwd, lines_bwd, _ = road_geometry(cam)
    centres_fwd = [-(a + b) / 2 for a, b in zip(lines_fwd, lines_fwd[1:])]
    centres_bwd = [(a + b) / 2 for a, b in zip(lines_bwd, lines_bwd[1:])]
    crash_src = dict(cp.get("vehicles", {}))
    if not crash_src:
        for track in tw["tracks"]:
            if track.get("crash"):
                cat = category_of(track.get("class"), fnum(track.get("length_m")))
                crash_src["white-van" if cat == "van" else "yellow-car"] = track
    contacts_raw = cp.get("contacts")
    if contacts_raw is None:
        contacts_raw = [cp["contact"]] if cp.get("contact") else []
    primary = next((c for c in contacts_raw if c.get("b", "white-van") in crash_src), None)
    anchor = primary or next(iter(contacts_raw), None)
    anchor_point = anchor.get("W", anchor.get("point_W", anchor.get("point"))) if anchor else None
    if anchor_point is not None:
        x_contact_w = float(anchor_point.get("x", anchor_point.get("X"))) if isinstance(anchor_point, dict) else float(anchor_point[0])
    else:
        van = crash_src.get("white-van") or next(iter(crash_src.values()), None)
        xs = sorted(float(s["x"]) for s in (van or {}).get("samples", []) if fnum(s.get("x")) is not None)
        x_contact_w = xs[len(xs) // 2] if xs else 80.0
    x_ref = round(x_contact_w + 12.0, 2)
    fixed = static_objects(div, x_ref, y_med)
    objects, dropped, mapping = [], [], {}
    used = {o["id"] for o in fixed} | set(crash_src)

    def make_object(oid, track, involvement):
        samples = sorted((s for s in track.get("samples", []) if fnum(s.get("f")) is not None), key=lambda s: s["f"])
        uniq = {}
        for sample in samples:
            f = int(sample["f"])
            if 0 <= f <= LAST_FRAME and fnum(sample.get("x")) is not None and fnum(sample.get("y")) is not None:
                uniq.setdefault(f, sample)
        samples = list(uniq.values())
        if len(samples) < 2:
            dropped.append({"id": str(track.get("id", oid)), "reason": "fewer than two usable samples"})
            return None
        cat = category_of(track.get("class"), fnum(track.get("length_m")))
        dl, dw, dm = CATEGORY_DEFAULTS[cat]
        length = min(dl * 1.4, max(dl * 0.6, round(fnum(track.get("length_m")) or dl, 3)))
        width = min(dw * 1.4, max(dw * 0.6, round(fnum(track.get("width_m")) or dw, 3)))
        mass = min(dm * 2, max(dm * 0.5, round(fnum(track.get("mass_kg")) or dm, 1)))
        kfs, forces = [], []
        for s in samples:
            x, y = plan_point([s["x"], s["y"]], x_ref, y_med)
            speed = fnum(s.get("speed_mps"), math.hypot(fnum(s.get("vx"), 0.0), fnum(s.get("vy"), 0.0)))
            hw = fnum(s.get("heading_deg"), math.degrees(math.atan2(fnum(s.get("vy"), 0.0), fnum(s.get("vx"), 0.0))))
            k = {"t_s": round(int(s["f"]) / FPS, 4), "x_m": x, "y_m": y,
                 "heading_deg": round(to_plan_heading(hw), 3), "speed_mps": round(min(70.0, max(0.0, speed)), 3),
                 "src": s.get("src") if s.get("src") in SAMPLE_SOURCES else "measured"}
            if fnum(s.get("sigma_m")) is not None:
                k["sigma_m"] = max(0.0, float(s["sigma_m"]))
            kfs.append(k)
            if involvement == "crash":
                cause = s.get("cause", "other")
                forces.append({"t_s": k["t_s"], "fx_n": round(max(-2e6, min(2e6, -fnum(s.get("fx_n"), 0.0))), 1),
                               "fy_n": round(max(-2e6, min(2e6, fnum(s.get("fy_n"), 0.0))), 1),
                               "cause": cause if cause in FORCE_CAUSES else "other", "note": f"Derived from track ({k['src']}); not instrumented."})
        if involvement == "background" and extend_edges:
            kfs = edge_keyframes(kfs, samples)
        last = kfs[-1]
        rest = {key: last[key] for key in ("x_m", "y_m", "heading_deg")} if involvement == "crash" and last["speed_mps"] < 0.3 and last["src"] != "out-of-view-extrapolated" else None
        paint = str(track.get("paint") or "grey").strip().lower()
        hexv = track.get("paint_hex") or "#8a8f98"
        if not isinstance(hexv, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", hexv):
            hexv = "#8a8f98"
        return {"id": oid, "label": f"{paint} {cat}", "category": cat, "color_name": paint, "color_hex": hexv.lower(),
                "make": None, "model": None, "involvement": involvement, "length_m": length, "width_m": width, "mass_kg": mass,
                **({"height_m": min(6.0, max(0.3, fnum(track.get("height_m"))))} if fnum(track.get("height_m")) else {}),
                "visible_from_s": kfs[0]["t_s"], "visible_to_s": kfs[-1]["t_s"], "keyframes": kfs,
                "forces": forces, "rest": rest, "confidence": fnum(track.get("confidence"), 0.9 if involvement == "crash" else 0.75)}

    for oid, track in crash_src.items():
        obj = make_object(oid, track, "crash")
        if obj:
            objects.append(obj)
            mapping[str(track.get("id", oid))] = oid
    n_bg = 0
    for i, track in enumerate(tw["tracks"]):
        if track.get("crash"):
            # Crash-pair measurements supersede these, but keep their identity mapping auditable.
            cat = category_of(track.get("class"), fnum(track.get("length_m")))
            mapping[str(track.get("id", i))] = "white-van" if cat == "van" else "yellow-car"
            continue
        ys = [float(s["y"]) for s in track.get("samples", []) if fnum(s.get("y")) is not None]
        if args.omit_opposing and ys and sorted(ys)[len(ys) // 2] > y_med:
            continue
        original = str(track.get("id", f"veh-{i + 1:03d}"))
        oid = original
        suffix = 2
        while oid in used:
            oid = f"{original}-{suffix}"
            suffix += 1
        obj = make_object(oid, track, "background")
        if obj:
            used.add(oid)
            objects.append(obj)
            mapping[original] = oid
            n_bg += 1
    by_id = {o["id"]: o for o in objects}
    contacts = sorted((convert_contact(c, x_ref, y_med, set(by_id), {o["id"] for o in fixed}) for c in contacts_raw), key=lambda c: c["t_s"])
    crash = None
    if contacts:
        participants = list(dict.fromkeys(oid for c in contacts for oid in (c["a"], c["b"]) if oid in by_id))
        end = fnum(cp.get("end_s"), max(by_id[oid]["keyframes"][-1]["t_s"] for oid in participants))
        # Soft-verge encroachment may precede the main vehicle impact. Preserve its own contact
        # time, while the viewer's main impact marker follows the first vehicle-vehicle contact.
        primary_contact = next((c for c in contacts if c["kind"] == "vehicle-vehicle"), contacts[0])
        crash = {"start_s": primary_contact["t_s"], "end_s": round(min(DURATION, max(contacts[-1]["t_s"], end)), 4),
                 "kind": cp.get("kind", "car strikes stopped van near median verge"),
                 "description": "Frame-timed contacts from crash_pair.json. Inferred geometry and impulses are labeled individually. Moving or out-of-view vehicles are not assumed to be at rest.",
                 "participants": participants, "contacts": contacts}
    tracking_caveats = [str(tw["kinematics_assumptions"])] if tw.get("kinematics_assumptions") else []
    caveat_ids = {}
    for track in tw["tracks"]:
        oid = mapping.get(str(track.get("id")))
        if oid not in by_id:
            continue
        for note in track.get("kinematics_caveats", []):
            caveat_ids.setdefault(str(note), []).append(oid)
    tracking_caveats += [f"{note} Affected track IDs: {', '.join(ids)}." for note, ids in caveat_ids.items()]
    review_path = os.path.join(args.data, "..", "review_tracks", "REVIEW-COMPLETE.md")
    if not synthetic and os.path.isfile(review_path):
        with open(review_path, "rb") as fh:
            review_bytes = fh.read()
        loaded_sources["tracking_review"] = source_info(review_path, review_bytes)
        review_text = review_bytes.decode("utf-8")
        heading = "## Residual issues to carry into production caveats"
        if heading in review_text:
            residuals = review_text.split(heading, 1)[1].split("\n## ", 1)[0]
            tracking_caveats += ["Tracking audit: " + re.sub(r"^\d+\.\s*", "", line).replace("**", "").replace("`", "")
                                 for line in residuals.splitlines() if re.match(r"^\d+\.\s+", line)]
    spec = {
        "prompt_version": "measured-a9-v2", "title": ("SYNTHETIC CHECK: " if synthetic else "") + "A9 motorway: car strikes stopped van",
        "location_guess": "A9 motorway near Munich, Germany (TUM Traffic gantry cameras)",
        "summary": "First 32 seconds at 12.5 fps. Calibrated crash-side trajectories, asymmetric measured lane lines and fixed median geometry. " + f"{n_bg} background tracks; " + ("diagnostic endpoint extrapolations are labeled." if extend_edges else "background visibility follows audited source spans."),
        "duration_s": DURATION,
        "views": [{"video_index": 1, "description": "Bottom-right crash camera; calibrated 479x300 tile, crop x=481 y=304; 12.5 fps.",
                   "camera_kind": "fixed gantry traffic camera", "moving": False, "time_offset_s": 0, "plus_x_traffic": "toward_camera"}],
        "environment_preset": "snowy",
        "road": {"kind": "divided_highway", "region": "DE", "road_class": "motorway", "lanes_each_way": len(centres_fwd),
                 "cross_lanes_each_way": 1, "surface": "dry", "grade_percent": 0, "speed_limit_mps": None,
                 "lane_lines_forward_m": [round(v, 3) for v in lines_fwd], "lane_lines_backward_m": [round(v, 3) for v in lines_bwd]},
        "wind": {"toward_deg": 0, "speed_mps": 0}, "crash": crash, "objects": objects, "static_objects": fixed,
        "caveats": (["SYNTHETIC integration fixture: trajectories and contacts do not describe the source footage."] if synthetic else []) + [
            "Frame measurements use a calibrated pinhole camera; dash spacing and assumed van width set scale. Uncertainty is retained per sample.",
            f"Measured road has {len(centres_fwd)} crash-side strips and {len(centres_bwd)} opposing strips; no symmetric lane fit or lateral shift.",
            ("Diagnostic background endpoint extension uses constant along-road velocity and fixed lateral position to the road/clip bounds. It can create unsupported visible traffic and does not establish observed presence." if extend_edges else
             "Background visibility follows the supplied audited measured/interpolated spans. Run-in/run-out identity outside those spans is unknown; a track can first appear inside the image where its first reliable fit occurs."),
            "Manual lane census retains residual differences: inferred/occluded tracks can remain without a visible source body, and horizon/edge identities are uncertain. Complete one-to-one visible-traffic coverage has not been established.",
            "The crash-side median near the crash is a low snow-covered verge, separate from its far-side barrier and the uncertain far-section hedge band. Heights and contact parameters are estimates; see static-object notes.",
            "Contact times/points, normals and impulses retain their inferred/measured labels; forces derived from fitted motion are not instrumented.",
            "Vehicle dimensions are clamped to viewer class ranges; pedestrians and debris are omitted."]
            + [str(note) for note in cp.get("evidence_notes", []) if note] + tracking_caveats}
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(spec, fh, separators=(",", ":"), allow_nan=False)
        fh.write("\n")
    metadata = {"version": "measured-a9-v2", "synthetic": synthetic, "fps": FPS, "duration_s": DURATION,
                "X_REF": x_ref, "Y_median": y_med, "road_ends_plan_m": list(ROAD_ENDS_PLAN),
                "frame_transform": {"x_m": "X_REF - X_W", "y_m": "Y_W - Y_median", "normal_plan": "(-nx_W, ny_W)", "three": "(x_plan, height, -y_plan)"},
                "sources": loaded_sources,
                "builder": source_info(__file__), "output": source_info(args.out), "source_track_to_spec_id": mapping,
                "dropped": dropped, "omit_opposing": args.omit_opposing, "background_edge_extrapolation": extend_edges}
    video_path = os.path.abspath(os.path.join(HERE, "..", "..", "..", "..", "demo_32s.mp4"))
    if os.path.exists(video_path):
        metadata["source_video"] = source_info(video_path)
    with open(args.out + ".build.json", "w", encoding="utf-8") as fh:
        json.dump(metadata, fh, indent=2, allow_nan=False)
        fh.write("\n")
    print(f"wrote {args.out} + .build.json: {len(objects)} vehicles ({n_bg} background), {len(fixed)} static objects, {len(contacts)} contacts")
    print(f"X_REF={x_ref:.3f}; Y_median={y_med:.3f}; forward lines={spec['road']['lane_lines_forward_m']}; backward lines={spec['road']['lane_lines_backward_m']}")
    print(f"keyframes={sum(len(o['keyframes']) for o in objects)}; edge-extrapolated={sum(k['src'] == 'edge-extrapolated' for o in objects for k in o['keyframes'])}; dropped={len(dropped)}")


def check_mapping():
    """Unit check of the W -> plan transform: right-hand traffic on the crash carriageway."""
    # A vehicle on the crash carriageway (Y below the median), driving toward the camera (-X, hW = 180).
    y_med = -4.8
    X, Y, hW = 50.0, y_med - 2.9, 180.0
    x_p, y_p = -(X - 40.0), Y - y_med
    h_p = to_plan_heading(hW)
    assert abs(h_p) < 1e-9, h_p                      # faces +x
    assert y_p < 0, y_p                              # right of +x: right-hand traffic
    # It moves -X; one second later it is at larger plan x.
    assert -((X - 25.0) - 40.0) > x_p
    # Heading vs. motion: plan direction from hW must equal the mapped W velocity direction.
    for hw in (0.0, 30.0, 90.0, 135.0, 180.0, -100.0):
        vx, vy = math.cos(math.radians(hw)), math.sin(math.radians(hw))
        px, py = -vx, vy
        hp = math.radians(to_plan_heading(hw))
        assert abs(math.cos(hp) - px) < 1e-9 and abs(math.sin(hp) - py) < 1e-9, hw
    # A vehicle drifting toward the camera's right (+Y, toward the median from the crash side) moves to plan +y (its left).
    assert to_plan_heading(180.0 - 10.0) > 0
    # Other carriageway: moving +X (hW = 0) at Y above the median -> plan heading 180, plan y > 0.
    assert abs(abs(to_plan_heading(0.0)) - 180.0) < 1e-9 and (y_med + 2.9) - y_med > 0
    fixture = {"id": "synthetic-wall", "footprint_W": [[0, -8], [10, -8], [10, -7], [0, -7]],
               "height_m": 0.5, "material": "concrete", "friction": 0.5, "restitution": 0.1,
               "stiffness_n_per_m": 1e6, "source": "inferred"}
    fixed = static_objects(fixture, 20, -5)[0]
    assert polygon_area(fixed["footprint_m"]) > 0 and fixed["immovable"]
    for nw in ([1, 0], [-1, 0], [0, 1], [0, -1], [3, 4]):
        c = convert_contact({"a": "car", "b": "synthetic-wall", "frame": 290, "W": [5, -8], "normal_W": nw},
                            20, -5, {"car"}, {"synthetic-wall"})
        h = math.radians(c["normal_deg"])
        length = math.hypot(*nw)
        assert abs(math.cos(h) + nw[0] / length) < 1e-6
        assert abs(math.sin(h) - nw[1] / length) < 1e-6
        assert c["kind"] == "vehicle-static" and c["frame"] / FPS == c["t_s"]
        assert "impulse_ns" not in c
        with_null = convert_contact({"a": "car", "b": "synthetic-wall", "frame": 290,
                                    "W": [5, -8], "normal_W": nw, "impulse_ns": None},
                                   20, -5, {"car"}, {"synthetic-wall"})
        assert "impulse_ns" not in with_null
    print("frame mapping/static winding/contact normal checks: PASS")


if __name__ == "__main__":
    main()
