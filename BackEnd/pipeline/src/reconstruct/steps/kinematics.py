"""Ground-plane constant-acceleration Kalman filter, RTS smoother, and impact test.

Position measurements on X and Z are filtered independently. Y is the vehicle
center height and is not part of the filter. Published ``sigma`` is a fixed
MVP uncertainty; it is not the filter covariance.

Heading is the direction of the horizontal velocity. 0° faces +X and positive
yaw turns toward −Z. ``yaw_rate`` is radians per second. Longitudinal
acceleration is ``dot(acc, forward)`` and is not a separate sample field.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from reconstruct.geometry import heading_forward, wrap_heading_deg, yaw_quaternion
from reconstruct.models import Event, Sample, Sigma, Track, Visibility

# Defaults suit a clean constant-velocity series. Video lifts pass a larger
# measurement sigma so the smoother can reject box jitter. The values written
# into the package are the fixed sigmas passed to `samples_from_states`.
MEAS_SIGMA_M = 0.05
JERK_SIGMA = 3.0
VIDEO_MEAS_SIGMA_M = 1.25
VIDEO_JERK_SIGMA = 5.0


@dataclass(frozen=True)
class Impact:
    t: float
    vehicles: tuple[str, str]
    separation_m: float
    closing_mps: float


def kalman_rts(
    times: np.ndarray,
    measurements: np.ndarray,
    *,
    meas_sigma: float = MEAS_SIGMA_M,
    jerk_sigma: float = JERK_SIGMA,
) -> np.ndarray:
    """Smooth one axis. Returns an (n, 3) array of position, velocity, acceleration."""
    meas = np.asarray(measurements, dtype=float)
    ts = np.asarray(times, dtype=float)
    n = int(meas.shape[0])
    if n < 2:
        raise ValueError("the smoother needs at least two samples")
    dt = float(ts[1] - ts[0])
    if dt <= 0:
        raise ValueError("sample times must increase")
    state_transition, process_noise = _constant_accel(dt, jerk_sigma)
    meas_var = meas_sigma ** 2
    identity = np.eye(3)

    state = np.array([meas[0], (meas[1] - meas[0]) / dt, 0.0])
    covariance = np.diag([meas_var, 0.25, 1.0])

    predicted = np.zeros((n, 3))
    predicted_cov = np.zeros((n, 3, 3))
    filtered = np.zeros((n, 3))
    filtered_cov = np.zeros((n, 3, 3))

    for index in range(n):
        if index > 0:
            step = float(ts[index] - ts[index - 1])
            if abs(step - dt) > 1e-6:
                raise ValueError("the smoother expects a uniform sample period")
            state = state_transition @ state
            covariance = state_transition @ covariance @ state_transition.T + process_noise
        predicted[index] = state
        predicted_cov[index] = covariance

        innovation = float(meas[index] - state[0])
        innovation_var = float(covariance[0, 0] + meas_var)
        gain = covariance[:, 0] / innovation_var
        state = state + gain * innovation
        joseph = identity.copy()
        joseph[:, 0] -= gain
        covariance = joseph @ covariance @ joseph.T + np.outer(gain, gain) * meas_var
        covariance = 0.5 * (covariance + covariance.T)
        filtered[index] = state
        filtered_cov[index] = covariance

    smoothed = np.zeros((n, 3))
    smoothed[-1] = filtered[-1]
    for index in range(n - 2, -1, -1):
        gain = np.linalg.solve(
            predicted_cov[index + 1].T,
            (filtered_cov[index] @ state_transition.T).T,
        ).T
        smoothed[index] = filtered[index] + gain @ (smoothed[index + 1] - predicted[index + 1])
    return smoothed


def samples_from_states(
    times: np.ndarray,
    x_state: np.ndarray,
    z_state: np.ndarray,
    *,
    center_y: float,
    sigma: Sigma,
    min_heading_speed_mps: float = 1.5,
) -> list[Sample]:
    """Build package samples from smoothed X and Z states.

    Below ``min_heading_speed_mps`` the velocity direction is unreliable, so
    heading holds the last trusted value (important for stopped crash vehicles).
    """
    count = int(len(times))
    raw_headings = np.array(
        [math.atan2(-float(z_state[i, 1]), float(x_state[i, 1])) for i in range(count)]
    )
    speeds = np.array(
        [math.hypot(float(x_state[i, 1]), float(z_state[i, 1])) for i in range(count)]
    )
    headings = np.zeros(count)
    held: float | None = None
    for index in range(count):
        if speeds[index] >= min_heading_speed_mps or held is None:
            held = float(raw_headings[index])
        headings[index] = held
    unwrapped = np.unwrap(headings)
    yaw_rate = np.zeros(count)
    for index in range(count):
        if index == 0:
            yaw_rate[index] = (unwrapped[1] - unwrapped[0]) / (times[1] - times[0])
        elif index == count - 1:
            yaw_rate[index] = (unwrapped[-1] - unwrapped[-2]) / (times[-1] - times[-2])
        else:
            span = times[index + 1] - times[index - 1]
            yaw_rate[index] = (unwrapped[index + 1] - unwrapped[index - 1]) / span

    samples: list[Sample] = []
    for index in range(count):
        vx = float(x_state[index, 1])
        vz = float(z_state[index, 1])
        ax = float(x_state[index, 2])
        az = float(z_state[index, 2])
        vel = (round(vx, 4), 0.0, round(vz, 4))
        acc = (round(ax, 4), 0.0, round(az, 4))
        speed = round(float(speeds[index]), 4)
        heading = round(wrap_heading_deg(math.degrees(float(headings[index]))), 3)
        if heading == -180.0:
            heading = 180.0
        quat = tuple(round(c, 6) for c in yaw_quaternion(math.radians(heading)))
        samples.append(
            Sample(
                t=round(float(times[index]), 2),
                pos=(
                    round(float(x_state[index, 0]), 4),
                    round(center_y, 4),
                    round(float(z_state[index, 0]), 4),
                ),
                quat=quat,  # type: ignore[arg-type]
                vel=vel,
                acc=acc,
                speed_mps=speed,
                heading_deg=heading,
                yaw_rate=round(float(yaw_rate[index]), 5),
                sigma=sigma,
            )
        )
    return samples


def smooth_track(
    entity_id: str,
    carriageway: str,
    times: list[float],
    x_m: list[float],
    z_m: list[float],
    *,
    center_y: float,
    sigma: Sigma,
    meas_sigma: float = MEAS_SIGMA_M,
    jerk_sigma: float = JERK_SIGMA,
) -> Track:
    ts = np.asarray(times, dtype=float)
    x_state = kalman_rts(ts, np.asarray(x_m, dtype=float), meas_sigma=meas_sigma, jerk_sigma=jerk_sigma)
    z_state = kalman_rts(ts, np.asarray(z_m, dtype=float), meas_sigma=meas_sigma, jerk_sigma=jerk_sigma)
    samples = samples_from_states(ts, x_state, z_state, center_y=center_y, sigma=sigma)
    return Track(
        entity_id=entity_id,
        carriageway=carriageway,  # type: ignore[arg-type]
        visibility=Visibility(t_start=samples[0].t, t_end=samples[-1].t),
        samples=samples,
    )


def longitudinal_accel_mps2(sample: Sample) -> float:
    """Acceleration along the published heading."""
    forward = heading_forward(sample.heading_deg)
    return sample.acc[0] * forward[0] + sample.acc[2] * forward[2]


def detect_impacts(
    tracks: list[Track],
    *,
    separation_m: float,
    min_closing_mps: float,
    hold_s: float = 0.4,
    rest_speed_mps: float = 3.0,
) -> list[Impact]:
    """Collect crash contacts from closing pairs, already-close rests, and hard stops.

    Burned-in boxes often miss one spun-out participant, so a pure center-closing
    test is not enough. Hard brake-to-rest next to another vehicle marks the
    primary incident even when the partner track is incomplete.
    """
    impacts = _closing_impacts(
        tracks,
        separation_m=separation_m,
        min_closing_mps=min_closing_mps,
        hold_s=hold_s,
        rest_speed_mps=rest_speed_mps,
    )
    impacts.extend(
        _already_close_impacts(
            tracks,
            separation_m=separation_m,
            hold_s=hold_s,
            rest_speed_mps=rest_speed_mps,
        )
    )
    impacts.extend(
        _brake_to_rest_impacts(
            tracks,
            neighbor_m=max(8.0, 2.5 * separation_m),
            rest_speed_mps=rest_speed_mps,
        )
    )
    return _unique_impacts(impacts)


def rest_onset_s(track: Track, *, speed_mps: float = 2.0, min_duration_s: float = 0.8) -> float | None:
    """First time this track stays nearly stopped for ``min_duration_s``."""
    run_start: float | None = None
    for sample in track.samples:
        if sample.speed_mps <= speed_mps:
            if run_start is None:
                run_start = sample.t
            if sample.t - run_start >= min_duration_s:
                return round(run_start, 2)
        else:
            run_start = None
    return None


def crash_rest_onset_s(track: Track) -> float | None:
    """Rest onset that looks like crash aftermath, not startup lift noise."""
    onset = rest_onset_s(track)
    if onset is None:
        return None
    prior = [sample for sample in track.samples if sample.t < onset]
    if prior and max(sample.speed_mps for sample in prior) >= 4.0:
        return onset
    # Already-slow wreck pieces that appear after traffic is established.
    if onset >= 15.0:
        return onset
    return None


def incident_onset_s(tracks: list[Track]) -> float | None:
    """Time of the primary crash wave: hard-stop contact with strong rest support.

    Secondary hits into an already-stopped pile-up can look like stronger
    closing contacts later. Prefer the earliest impact that sits inside a dense
    same-carriageway rest cluster.
    """
    impacts = detect_impacts(tracks, separation_m=2.5, min_closing_mps=0.3)
    if not impacts:
        return None
    by_id = {track.entity_id: track for track in tracks}
    rests = [
        (onset, track.carriageway)
        for track in tracks
        for onset in [crash_rest_onset_s(track)]
        if onset is not None
    ]
    if not rests:
        return round(min(impact.t for impact in impacts), 2)

    def support(impact: Impact) -> int:
        carriageway = by_id[impact.vehicles[0]].carriageway
        return sum(
            1
            for onset, other_carriageway in rests
            if other_carriageway == carriageway and impact.t - 2.0 <= onset <= impact.t + 10.0
        )

    scored = [(support(impact), impact) for impact in impacts]
    best_support = max(score for score, _impact in scored)
    if best_support < 3:
        return round(min(impact.t for impact in impacts), 2)
    bar = max(4, int(0.7 * best_support + 0.999))
    wave = [impact for score, impact in scored if score >= bar]
    if not wave:
        wave = [impact for score, impact in scored if score == best_support]
    return round(min(impact.t for impact in wave), 2)


def _closing_impacts(
    tracks: list[Track],
    *,
    separation_m: float,
    min_closing_mps: float,
    hold_s: float,
    rest_speed_mps: float,
) -> list[Impact]:
    by_id = {track.entity_id: track for track in tracks}
    impacts: list[Impact] = []
    for left_index, left in enumerate(tracks):
        left_at = {round(sample.t, 2): sample for sample in left.samples}
        for right in tracks[left_index + 1 :]:
            if left.carriageway != right.carriageway:
                continue
            shared: list[tuple[float, Sample, Sample]] = []
            for sample in right.samples:
                other = left_at.get(round(sample.t, 2))
                if other is not None:
                    shared.append((round(sample.t, 2), other, sample))
            if len(shared) < 3:
                continue
            previous: tuple[float, float] | None = None
            streak = 0
            entry: tuple[float, float, float] | None = None
            entry_index = -1
            for index, (t, left_sample, right_sample) in enumerate(shared):
                distance = math.dist(left_sample.pos, right_sample.pos)
                if previous is not None:
                    distance_prev = previous[1]
                    dt = t - previous[0]
                    closing = (distance_prev - distance) / dt if dt > 0 else 0.0
                    lateral = abs(left_sample.pos[2] - right_sample.pos[2])
                    if distance < separation_m and lateral < 1.25 * separation_m:
                        if streak == 0 and distance_prev > separation_m and closing >= min_closing_mps:
                            streak = 1
                            entry = (t, distance, closing)
                            entry_index = index
                        elif streak > 0:
                            streak += 1
                        if streak >= 3 and entry is not None:
                            if _impact_confirmed(
                                shared,
                                entry_index=entry_index,
                                left=by_id[left.entity_id],
                                right=by_id[right.entity_id],
                                separation_m=separation_m,
                                hold_s=hold_s,
                                rest_speed_mps=rest_speed_mps,
                            ):
                                pair = tuple(sorted((left.entity_id, right.entity_id)))
                                impacts.append(
                                    Impact(
                                        t=entry[0],
                                        vehicles=pair,  # type: ignore[arg-type]
                                        separation_m=entry[1],
                                        closing_mps=entry[2],
                                    )
                                )
                                break
                            streak = 0
                            entry = None
                            entry_index = -1
                    else:
                        streak = 0
                        entry = None
                        entry_index = -1
                previous = (t, distance)
    return impacts


def _already_close_impacts(
    tracks: list[Track],
    *,
    separation_m: float,
    hold_s: float,
    rest_speed_mps: float,
) -> list[Impact]:
    """Pairs that are already under the threshold and both nearly stopped."""
    impacts: list[Impact] = []
    for left_index, left in enumerate(tracks):
        left_at = {round(sample.t, 2): sample for sample in left.samples}
        for right in tracks[left_index + 1 :]:
            if left.carriageway != right.carriageway:
                continue
            run_start: float | None = None
            last_t: float | None = None
            last_distance = separation_m
            for sample in right.samples:
                other = left_at.get(round(sample.t, 2))
                if other is None:
                    run_start = None
                    continue
                distance = math.dist(other.pos, sample.pos)
                slow = other.speed_mps <= rest_speed_mps and sample.speed_mps <= rest_speed_mps
                if distance < separation_m and slow:
                    if run_start is None:
                        run_start = round(sample.t, 2)
                        last_distance = distance
                    last_t = round(sample.t, 2)
                    last_distance = min(last_distance, distance)
                    continue
                if run_start is not None and last_t is not None and last_t - run_start >= hold_s:
                    pair = tuple(sorted((left.entity_id, right.entity_id)))
                    impacts.append(
                        Impact(
                            t=run_start,
                            vehicles=pair,  # type: ignore[arg-type]
                            separation_m=last_distance,
                            closing_mps=0.0,
                        )
                    )
                    break
                run_start = None
            if run_start is not None and last_t is not None and last_t - run_start >= hold_s:
                pair = tuple(sorted((left.entity_id, right.entity_id)))
                impacts.append(
                    Impact(
                        t=run_start,
                        vehicles=pair,  # type: ignore[arg-type]
                        separation_m=last_distance,
                        closing_mps=0.0,
                    )
                )
    return impacts


def _brake_to_rest_impacts(
    tracks: list[Track],
    *,
    neighbor_m: float,
    rest_speed_mps: float,
    min_long_acc: float = -5.0,
) -> list[Impact]:
    """Hard stop beside another vehicle — proxy when one crash box is missing."""
    impacts: list[Impact] = []
    by_time: dict[tuple[str, float], list[tuple[Track, Sample]]] = {}
    for track in tracks:
        for sample in track.samples:
            by_time.setdefault((track.carriageway, round(sample.t, 2)), []).append((track, sample))

    for track in tracks:
        for index, sample in enumerate(track.samples):
            if longitudinal_accel_mps2(sample) > min_long_acc:
                continue
            later = track.samples[index : index + max(5, len(track.samples) // 6)]
            if not later or min(item.speed_mps for item in later) > rest_speed_mps:
                continue
            # Require that speed actually drops into the rest band.
            if sample.speed_mps <= rest_speed_mps + 0.5:
                continue
            neighbors = by_time.get((track.carriageway, round(sample.t, 2)), [])
            best: tuple[float, Track, Sample] | None = None
            for other, other_sample in neighbors:
                if other.entity_id == track.entity_id:
                    continue
                distance = math.dist(sample.pos, other_sample.pos)
                if distance > neighbor_m:
                    continue
                if best is None or distance < best[0]:
                    best = (distance, other, other_sample)
            if best is None:
                continue
            distance, other, other_sample = best
            pair = tuple(sorted((track.entity_id, other.entity_id)))
            closing = max(0.0, sample.speed_mps - other_sample.speed_mps)
            impacts.append(
                Impact(
                    t=round(sample.t, 2),
                    vehicles=pair,  # type: ignore[arg-type]
                    separation_m=distance,
                    closing_mps=closing,
                )
            )
            break
    return impacts


def _unique_impacts(impacts: list[Impact]) -> list[Impact]:
    best: dict[tuple[str, str], Impact] = {}
    for impact in impacts:
        key = impact.vehicles
        previous = best.get(key)
        if previous is None or (impact.t, -impact.closing_mps) < (previous.t, -previous.closing_mps):
            best[key] = impact
    return sorted(best.values(), key=lambda item: (item.t, item.vehicles))


def _impact_confirmed(
    shared: list[tuple[float, Sample, Sample]],
    *,
    entry_index: int,
    left: Track,
    right: Track,
    separation_m: float,
    hold_s: float,
    rest_speed_mps: float,
) -> bool:
    later = shared[entry_index:]
    if not later:
        return False
    entry_t = later[0][0]
    held = 0.0
    for index, (t, left_sample, right_sample) in enumerate(later):
        distance = math.dist(left_sample.pos, right_sample.pos)
        if distance < separation_m:
            if index + 1 < len(later):
                held = later[index + 1][0] - entry_t
            else:
                held = t - entry_t
            # Still close when either track ends → pile-up / lost box after crash.
            if t >= left.visibility.t_end - 1e-6 or t >= right.visibility.t_end - 1e-6:
                return True
            if min(left_sample.speed_mps, right_sample.speed_mps) <= rest_speed_mps:
                return True
            if held >= hold_s:
                return True
            continue
        # Cleared while both still moving quickly → overtake / near-miss, not impact.
        if left_sample.speed_mps > rest_speed_mps and right_sample.speed_mps > rest_speed_mps:
            return False
        return held >= hold_s or min(left_sample.speed_mps, right_sample.speed_mps) <= rest_speed_mps
    # Shared window ended while centers were still under the threshold.
    return True


def brake_events(tracks: list[Track], *, min_drop_mps: float = 6.0, window_s: float = 2.0) -> list[Event]:
    """Hard slowdowns: speed falls by ``min_drop_mps`` inside ``window_s``."""
    events: list[Event] = []
    for track in tracks:
        samples = track.samples
        if len(samples) < 4:
            continue
        best: tuple[float, float, float] | None = None
        for index, sample in enumerate(samples):
            for later in samples[index + 1 :]:
                dt = later.t - sample.t
                if dt <= 0 or dt > window_s:
                    break
                drop = sample.speed_mps - later.speed_mps
                if drop < min_drop_mps:
                    continue
                if best is None or drop > best[2]:
                    best = (later.t, sample.speed_mps, drop)
        if best is None:
            continue
        events.append(
            Event(
                id=f"brake-{track.entity_id}",
                t=best[0],
                type="brake",
                vehicles=[track.entity_id],
                note=(
                    f"{track.entity_id} slows by {best[2]:.1f} m/s "
                    f"from {best[1]:.1f} m/s on carriageway {track.carriageway}."
                ),
            )
        )
    return events


def rest_events(
    tracks: list[Track],
    *,
    speed_mps: float = 2.0,
    min_duration_s: float = 1.2,
) -> list[Event]:
    """Vehicles that stay nearly stopped — typical after a crash."""
    events: list[Event] = []
    for track in tracks:
        run_start: float | None = None
        last_t = track.samples[0].t
        for sample in track.samples:
            if sample.speed_mps <= speed_mps:
                if run_start is None:
                    run_start = sample.t
                last_t = sample.t
                continue
            if run_start is not None and last_t - run_start >= min_duration_s:
                events.append(
                    Event(
                        id=f"rest-{track.entity_id}",
                        t=run_start,
                        type="rest",
                        vehicles=[track.entity_id],
                        note=(
                            f"{track.entity_id} is nearly stopped on carriageway "
                            f"{track.carriageway} from t={run_start:.2f} s."
                        ),
                    )
                )
                break
            run_start = None
        if run_start is not None and last_t - run_start >= min_duration_s:
            events.append(
                Event(
                    id=f"rest-{track.entity_id}",
                    t=run_start,
                    type="rest",
                    vehicles=[track.entity_id],
                    note=(
                        f"{track.entity_id} is nearly stopped on carriageway "
                        f"{track.carriageway} from t={run_start:.2f} s."
                    ),
                )
            )
    return events


def lane_change_events(tracks: list[Track], lane_width_m: float) -> list[Event]:
    """One event for a track whose smoothed path moves at least one lane."""
    events: list[Event] = []
    for track in tracks:
        count = len(track.samples)
        third = max(2, count // 3)
        start_z = float(np.median([sample.pos[2] for sample in track.samples[:third]]))
        end_z = float(np.median([sample.pos[2] for sample in track.samples[-third:]]))
        moved = abs(end_z - start_z)
        if moved < 0.7 * lane_width_m:
            continue
        midpoint = 0.5 * (start_z + end_z)
        crossing = min(track.samples, key=lambda sample: abs(sample.pos[2] - midpoint))
        events.append(
            Event(
                id=f"lane-change-{track.entity_id}",
                t=crossing.t,
                type="lane_change",
                vehicles=[track.entity_id],
                note=(
                    f"{track.entity_id} changes lane on carriageway "
                    f"{track.carriageway} ({moved:.1f} m laterally)."
                ),
            )
        )
    return events


def pass_events(
    tracks: list[Track],
    lane_width_m: float,
    *,
    min_separation_m: float,
) -> list[Event]:
    """Same-carriageway pairs whose order along the road reverses one lane apart."""
    events: list[Event] = []
    for left_index, left in enumerate(tracks):
        left_at = {round(sample.t, 2): sample for sample in left.samples}
        for right in tracks[left_index + 1 :]:
            if left.carriageway != right.carriageway:
                continue
            shared: list[tuple[Sample, Sample]] = []
            for sample in right.samples:
                other = left_at.get(round(sample.t, 2))
                if other is not None:
                    shared.append((other, sample))
            if len(shared) < 4:
                continue
            heading = -1.0 if left.carriageway == "a" else 1.0
            previous_dx: float | None = None
            for earlier, later in shared:
                delta_x = earlier.pos[0] - later.pos[0]
                crossed = previous_dx is not None and previous_dx * delta_x < 0
                previous_dx = delta_x
                if not crossed:
                    continue
                lateral = abs(earlier.pos[2] - later.pos[2])
                gap = math.hypot(earlier.pos[0] - later.pos[0], earlier.pos[2] - later.pos[2])
                if not (0.55 * lane_width_m <= lateral <= 1.45 * lane_width_m):
                    continue
                if gap < min_separation_m:
                    continue
                left_along = heading * earlier.vel[0]
                right_along = heading * later.vel[0]
                if left_along >= right_along:
                    overtaker, passed = left, right
                else:
                    overtaker, passed = right, left
                events.append(
                    Event(
                        id=f"pass-{overtaker.entity_id}-{passed.entity_id}",
                        t=earlier.t,
                        type="pass",
                        vehicles=[overtaker.entity_id, passed.entity_id],
                        note=(
                            f"{overtaker.entity_id} overtakes {passed.entity_id} "
                            f"on carriageway {left.carriageway}."
                        ),
                    )
                )
                break
    return events


def _constant_accel(dt: float, jerk_sigma: float) -> tuple[np.ndarray, np.ndarray]:
    transition = np.array(
        [
            [1.0, dt, 0.5 * dt * dt],
            [0.0, 1.0, dt],
            [0.0, 0.0, 1.0],
        ]
    )
    dt2 = dt * dt
    dt3 = dt2 * dt
    dt4 = dt2 * dt2
    dt5 = dt4 * dt
    spectral = jerk_sigma ** 2
    process = spectral * np.array(
        [
            [dt5 / 20.0, dt4 / 8.0, dt3 / 6.0],
            [dt4 / 8.0, dt3 / 3.0, dt2 / 2.0],
            [dt3 / 6.0, dt2 / 2.0, dt],
        ]
    )
    return transition, process
