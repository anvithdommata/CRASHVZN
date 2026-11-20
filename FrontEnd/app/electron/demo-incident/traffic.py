"""
Background traffic for the hand-authored demo incident (demo.mp4, 59.92 s).

A deterministic per-lane car-following simulation (IDM) on a 3+3 lane German motorway,
sampled into SpecObject dicts (see FrontEnd/app/src/incident/spec.ts). Standard library only.

    from traffic import background_objects
    objs = background_objects(seed=7)

Plan frame: x along the road, y to the LEFT of +x. Forward (+x) carriageway lanes at
y = -2.925 / -6.675 / -10.425 (lane 1 = median side); backward (-x) at +2.925 / +6.675 / +10.425.

Crash constraints honoured (shared with build-spec.py):
  * white van stopped in forward lane 1 at x=15 until IMPACT_T=22.3; lane-1 traffic merges out
    well before it, nobody queues behind it, and lane 1 behind it is empty during 18-22.3 s;
  * the yellow crash car drives lane 2 at 13 m/s (x = 10 - 13*(22.3 - t)); lane-2 traffic keeps
    >= 2.5 s headway and >= 35 m ahead / 30 m behind it during 15-22.3 s;
  * after impact lane 1 is blocked x in [6, 28]; lane-1 traffic merges out before x ~ -10, lane 2
    behind the crash brakes hard (<= 7 m/s^2) and queues, then creeps past; lane 3 slows to ~60 %
    near the crash; the backward carriageway is unaffected.

Run `python traffic.py` for a self-check and summary.
"""

import math
import random
import sys

# ---------------------------------------------------------------------------------------------
# Shared crash constants (keep identical to build-spec.py)
VAN_X = 15.0
VAN_Y = -2.925
VAN_LENGTH = 5.4
VAN_WIDTH = 2.05
IMPACT_T = 22.3
YELLOW_SPEED = 13.0
YELLOW_LANE_CHANGE_T = 21.0
YELLOW_LENGTH = 4.5  # assumed, only for spacing


def yellow_x(t):
    """The crash car's centre x while it drives lane 2 (extrapolated past 21.0 s for spacing)."""
    return 10.0 - YELLOW_SPEED * (IMPACT_T - t)


# ---------------------------------------------------------------------------------------------
# Road / simulation set-up
CLIP_END = 59.92
DT = 0.04  # 25 Hz; keyframe steps of 0.24 / 0.48 / 0.96 s land on this grid
T_START = -25.0  # warm-up so the road is already populated at t = 0
X_ENTER = 140.0
LANE_OFFSET = {1: 2.925, 2: 6.675, 3: 10.425}
LANE1_BAND = (-4.8, -1.05)  # forward lane 1, y range
LANE2_BAND = (-8.55, -4.8)

BLOCK_X0, BLOCK_X1 = 6.0, 28.0  # forward lane 1 blocked after impact
X_STOP1_PRE = -40.0  # lane-1 vehicles that have not merged yet stop here (pre impact)
X_STOP1_POST = -24.0  # ... and here after impact
LC_DONE_PRE = -20.0  # lane changes out of lane 1 finish by here
LC_DONE_POST = -12.0
LANE1_SPAWN_CUTOFF = 4.0  # no lane-1 spawns in [cutoff, IMPACT_T] (lane 1 empty 18-22.3 s)
LANE2_BLACKOUT = (5.0, 10.8)  # no lane-2 spawns just ahead of the yellow car
LANE2_STOP_X = 2.0  # lane-2 traffic stops behind this after impact
T_RELEASE = 30.0  # lane-2 queue starts creeping past
CREEP_SPEED = 6.0

MAX_DECEL = 7.0  # hard limit (checked)
SIM_MAX_DECEL = 6.5  # what the simulation actually allows


def lane_y(direction, lane):
    return -LANE_OFFSET[lane] if direction > 0 else LANE_OFFSET[lane]


def smooth(p):
    return p * p * (3.0 - 2.0 * p)


def idm(v, v0, gap, dv, a, b, T, s0):
    if v0 < 0.1:
        free = -b
    else:
        r = (v / v0) ** 4
        free = a * (1.0 - r)
        if v > v0:
            free = max(-3.0, free)
    if gap is None:
        return free
    s_star = s0 + max(0.0, v * T + v * dv / (2.0 * math.sqrt(a * b)))
    return free - a * (s_star / max(gap, 0.05)) ** 2


# ---------------------------------------------------------------------------------------------
# Vehicle mix (sampled to look like the gantry footage)
COLORS_CAR = [
    ("white", "#e8e8e6", 24), ("black", "#1c1c1e", 18), ("grey", "#6e7174", 15),
    ("silver", "#b7babd", 15), ("dark blue", "#1f2f4f", 10), ("red", "#a51e22", 6),
    ("blue", "#2f5fa8", 6), ("dark green", "#28402f", 3), ("beige", "#c9b994", 3),
]
COLORS_VAN = [("white", "#f0f0ee", 75), ("silver", "#b7babd", 12), ("dark blue", "#1f2f4f", 7), ("black", "#1c1c1e", 6)]
COLORS_TRUCK = [("white", "#eeeeec", 50), ("grey", "#808386", 15), ("blue", "#2c4f8c", 12), ("red", "#9c2424", 10), ("dark green", "#2e4a36", 8), ("yellow", "#d8b23a", 5)]


def pick(rng, table):
    total = sum(w for *_, w in table)
    x = rng.uniform(0, total)
    for row in table:
        x -= row[-1]
        if x <= 0:
            return row[:-1]
    return table[-1][:-1]


def draw_profile(rng, direction, lane):
    """Category, dimensions, mass, colour and driving parameters for one vehicle."""
    u = rng.random()
    if direction > 0:
        mix = {1: (0.04, 0.0), 2: (0.09, 0.05), 3: (0.15, 0.40)}[lane]
    else:
        mix = {1: (0.04, 0.0), 2: (0.08, 0.06), 3: (0.12, 0.42)}[lane]
    if u < mix[1]:
        cat = "truck"
    elif u < mix[0] + mix[1]:
        cat = "van"
    else:
        cat = pick(rng, [("sedan", 40), ("hatchback", 28), ("suv", 32)])[0]
    if cat == "sedan":
        L, W, m = rng.uniform(4.55, 4.95), rng.uniform(1.79, 1.86), rng.uniform(1420, 1680)
    elif cat == "hatchback":
        L, W, m = rng.uniform(4.0, 4.35), rng.uniform(1.74, 1.80), rng.uniform(1150, 1380)
    elif cat == "suv":
        L, W, m = rng.uniform(4.45, 4.95), rng.uniform(1.84, 1.95), rng.uniform(1750, 2250)
    elif cat == "van":
        L, W, m = rng.uniform(5.0, 5.95), rng.uniform(1.95, 2.05), rng.uniform(2200, 3100)
    else:
        if rng.random() < 0.55:
            L, W, m = 16.5, 2.55, rng.uniform(24000, 38000)  # tractor + semitrailer
        else:
            L, W, m = rng.uniform(9.5, 12.0), 2.5, rng.uniform(11000, 18000)  # rigid truck
    table = COLORS_TRUCK if cat == "truck" else COLORS_VAN if cat == "van" else COLORS_CAR
    color_name, color_hex = pick(rng, table)

    if direction > 0:
        if lane == 1:
            v0 = rng.uniform(14.5, 17.0)
        elif lane == 2:
            v0 = rng.uniform(13.2, 15.5)
        else:
            v0 = rng.uniform(10.5, 12.0) if cat == "truck" else rng.uniform(11.5, 13.5)
        T = 1.5 if cat == "truck" else 1.2
    else:
        if lane == 1:
            v0 = rng.uniform(27.0, 31.0)
        elif lane == 2:
            v0 = rng.uniform(24.0, 28.0)
        else:
            v0 = rng.uniform(21.0, 23.0) if cat == "truck" else rng.uniform(22.0, 25.0)
        T = 1.6 if cat == "truck" else 1.4
    a = {"truck": 0.8, "van": 1.2}.get(cat, 1.5)
    b = 1.6 if cat == "truck" else 2.0
    return dict(cat=cat, L=L, W=W, m=m, color_name=color_name, color_hex=color_hex, v0=v0, a=a, b=b, T=T)


class Veh:
    def __init__(self, uid, direction, lane, prof, t, v, rng):
        self.uid = uid
        self.dir = direction
        self.lane = lane
        self.target = None
        self.p = 0.0
        self.Llc = 30.0
        self.s = -X_ENTER
        self.v = v
        self.acc = 0.0
        self.cat = prof["cat"]
        self.L = prof["L"]
        self.W = prof["W"]
        self.m = prof["m"]
        self.color_name = prof["color_name"]
        self.color_hex = prof["color_hex"]
        self.v0 = prof["v0"]
        self.a = prof["a"]
        self.b = prof["b"]
        self.T = prof["T"]
        self.s0 = 2.0
        self.react = rng.uniform(0.6, 0.95)
        self.aff = None  # affected by the crash (decided at reaction time)
        self.desire_x = rng.uniform(-132.0, -112.0)
        self.spawn_t = t
        self.rec = []
        self.done = False
        self.min_v_after_impact = None
        self.lc_count = 0

    def lanes(self):
        return (self.lane,) if self.target is None else (self.lane, self.target)

    def y(self):
        y0 = lane_y(self.dir, self.lane)
        if self.target is None:
            return y0
        y1 = lane_y(self.dir, self.target)
        return y0 + (y1 - y0) * smooth(self.p)

    def slope(self):
        if self.target is None:
            return 0.0
        y0 = lane_y(self.dir, self.lane)
        y1 = lane_y(self.dir, self.target)
        return (y1 - y0) * 6.0 * self.p * (1.0 - self.p) / self.Llc

    def front(self):
        return self.s + self.L / 2.0


class Sim:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.active = []
        self.finished = []
        self.uid = 0
        self.pending = {}
        self.arrivals = {}
        self._gen_arrivals()

    # -- arrivals --------------------------------------------------------------------------
    def _gen_arrivals(self):
        rng = self.rng
        means = {(1, 1): 6.0, (1, 2): 3.8, (1, 3): 3.6, (-1, 1): 9.5, (-1, 2): 7.5, (-1, 3): 8.5}
        # after the impact upstream drivers have mostly moved over / are held back: thinner inflow
        after = {(1, 1): 11.0, (1, 2): 5.5, (1, 3): 6.0}
        for key, mean0 in means.items():
            mean = mean0
            hmin = 1.6 if key[0] > 0 else 2.2
            t = T_START + rng.uniform(0, mean)
            lst = []
            while t < CLIP_END - 1.0:
                keep = True
                if key == (1, 1) and LANE1_SPAWN_CUTOFF <= t < IMPACT_T:
                    keep = False
                if keep:
                    lst.append([t, draw_profile(rng, key[0], key[1])])
                mean = after.get(key, mean0) if t >= IMPACT_T else mean0
                t += hmin + rng.expovariate(1.0 / (mean - hmin))
            self.arrivals[key] = lst
            self.pending[key] = []

    def members(self):
        mem = {(d, l): [] for d in (1, -1) for l in (1, 2, 3)}
        for v in self.active:
            for l in v.lanes():
                mem[(v.dir, l)].append(v)
        return mem

    def _try_spawn(self, t, key, mem):
        direction, lane = key
        arr = self.arrivals[key]
        while arr and arr[0][0] <= t + 1e-9:
            self.pending[key].append(arr.pop(0))
        pend = self.pending[key]
        if not pend:
            return
        prof = dict(pend[0][1])
        # make the vehicles that will run ahead of the yellow car quick enough to stay ahead
        if direction > 0 and lane in (1, 2) and -8.0 <= t < IMPACT_T:
            prof["v0"] = max(prof["v0"], 14.6 if lane == 2 else 15.2)
        L = prof["L"]
        v_new = prof["v0"]
        lasts = [o for o in mem[key] if o.s - o.L / 2 < -X_ENTER + 120]
        last = min(lasts, key=lambda o: o.s) if lasts else None
        if last is not None:
            gap = last.s - (-X_ENTER) - (last.L + L) / 2.0
            v_try = min(v_new, last.v + 1.5)
            if gap < 2.0 + 1.5 * v_try:
                v_try = min(v_new, last.v)
                if gap < 2.0 + 1.1 * v_try or gap < 4.0:
                    return
            v_new = v_try
        if direction > 0 and lane == 2 and t < IMPACT_T + 1.5:
            yx = yellow_x(t)
            if yx >= -X_ENTER:
                g = yx - YELLOW_LENGTH / 2 - (-X_ENTER + L / 2)
                if g < 2.6 * YELLOW_SPEED + 6.0:
                    return
                v_new = min(v_new, YELLOW_SPEED + 0.5)
            else:
                t_arrive = (-X_ENTER - yx) / YELLOW_SPEED
                if v_new * t_arrive < 50.0:
                    return
        if direction > 0 and lane == 1 and LANE1_SPAWN_CUTOFF <= t < IMPACT_T:
            return
        if direction > 0 and lane == 2 and LANE2_BLACKOUT[0] <= t < LANE2_BLACKOUT[1]:
            return
        merge_now = False
        if direction > 0 and lane == 1 and t < IMPACT_T:
            # before the impact lane 1 is dead-ended by the van: only let a car in when lane 2 has
            # a real gap next to the entry, and have it move over straight away
            lead = None
            for o in mem[(1, 2)]:
                if o.s >= -X_ENTER - 5.0 and (lead is None or o.s < lead.s):
                    lead = o
            if lead is not None:
                g = lead.s - lead.L / 2 - (-X_ENTER + L / 2)
                if g < 28.0:
                    return
                v_new = min(v_new, lead.v + 1.0)
            merge_now = True
        pend.pop(0)
        self.uid += 1
        veh = Veh(self.uid, direction, lane, prof, t, v_new, self.rng)
        if merge_now:
            veh.desire_x = -X_ENTER - 1.0
        elif t >= IMPACT_T:
            veh.desire_x = self.rng.uniform(-120.0, -100.0)
        self.active.append(veh)
        mem[key].append(veh)

    # -- dynamics --------------------------------------------------------------------------
    def crash_affected(self, v, t):
        if v.dir < 0 or t < IMPACT_T + v.react:
            return False
        if v.aff is None:
            v.aff = v.s < 30.0
        return v.aff

    def v0_eff(self, v, t):
        v0 = v.v0
        if not self.crash_affected(v, t):
            return v0
        x = v.s
        lanes = v.lanes()
        if 3 in lanes:
            if x < -90:
                zf = 1.0
            elif x < -50:
                zf = 1.0 - 0.38 * (x + 90) / 40.0
            elif x < 30:
                zf = 0.62
            elif x < 55:
                zf = 0.62 + 0.38 * (x - 30) / 25.0
            else:
                zf = 1.0
            ft = min(1.0, (t - IMPACT_T - v.react) / 2.0)
            v0 = v0 * (1.0 - (1.0 - zf) * ft)
        if (2 in lanes or 1 in lanes) and t >= T_RELEASE:
            if x < -60:
                cz = v0
            elif x < -20:
                cz = v0 + (CREEP_SPEED - v0) * (x + 60) / 40.0
            elif x < 32:
                cz = CREEP_SPEED
            else:
                cz = v0
            v0 = min(v0, cz)
        return v0

    def is_waiting(self, o, t):
        """A lane-1 vehicle close to its stop line that still has to get into lane 2."""
        if o.dir < 0 or o.lane != 1 or o.target is not None or o.s < o.desire_x:
            return False
        stop = X_STOP1_PRE if t < IMPACT_T else X_STOP1_POST
        return stop - o.front() < 40.0

    def leader_accels(self, v, t, mem, v0):
        """IDM accelerations against every relevant leader (vehicles + virtual obstacles)."""
        out = []
        front = v.front()
        # nearest vehicle per lane
        for l in v.lanes():
            best = None
            for o in mem[(v.dir, l)]:
                if o is v or o.s <= v.s:
                    continue
                if best is None or o.s < best.s:
                    best = o
            if best is not None:
                gap = best.s - v.s - (best.L + v.L) / 2.0
                out.append(idm(v.v, v0, gap, v.v - best.v, v.a, v.b, v.T, v.s0))
        if v.dir < 0:
            return out
        lanes = v.lanes()
        # lane 1: stop line for not-yet-merged vehicles, then the van / crash zone
        stop = X_STOP1_PRE if t < IMPACT_T else X_STOP1_POST
        if v.lane == 1 and v.target is None and front > stop - 60.0:
            out.append(idm(v.v, v0, stop - front, v.v, v.a, 3.0, v.T, v.s0))
        if v.lane == 1 and v.target is None and v.s >= v.desire_x - 30.0:
            # line up behind a lane-2 vehicle so a gap opens
            best = None
            for o in mem[(1, 2)]:
                if o is v:
                    continue
                g = o.s - o.L / 2 - front
                if g > 0 and (best is None or g < best[0]):
                    best = (g, o)
            if best is not None:
                out.append(idm(v.v, v0, best[0], v.v - best[1].v, v.a, v.b, 0.5, 1.0))
        if 1 in lanes:
            rear = VAN_X - VAN_LENGTH / 2 if t < IMPACT_T else BLOCK_X0
            if front < rear + 0.5:
                out.append(idm(v.v, v0, rear - front, v.v, v.a, 3.0, v.T, v.s0))
        if 2 in lanes:
            if t < IMPACT_T + v.react:
                yx = yellow_x(t)
                if yx > v.s:
                    gap = yx - YELLOW_LENGTH / 2 - front
                    out.append(idm(v.v, v0, gap, v.v - YELLOW_SPEED, v.a, v.b, 2.6, 4.0))
            elif t < T_RELEASE and self.crash_affected(v, t) and front < LANE2_STOP_X:
                out.append(idm(v.v, v0, LANE2_STOP_X - front, v.v, v.a, 3.0, v.T, v.s0))
            # courtesy: let a waiting lane-1 vehicle in
            for o in mem[(1, 1)]:
                if o is v or o.s <= v.s or not self.is_waiting(o, t):
                    continue
                gap = o.s - v.s - (o.L + v.L) / 2.0
                if gap >= v.v * v.v / 8.0 + 1.5:
                    if t < IMPACT_T + 1.5 and 0.0 < v.s - yellow_x(t) < 160.0:
                        continue  # never slow down just ahead of the yellow car
                    # hang back far enough that the merging vehicle fits in front
                    out.append(idm(v.v, v0, gap, v.v - o.v, v.a, v.b, v.T, 6.0))
        return out

    def accel(self, v, t, mem):
        v0 = self.v0_eff(v, t)
        accs = self.leader_accels(v, t, mem, v0)
        acc = min(accs + [idm(v.v, v0, None, 0, v.a, v.b, v.T, v.s0)])
        acc = max(-SIM_MAX_DECEL, min(v.a, acc))
        if v.v <= 0.0 and acc < 0:
            acc = 0.0
        return acc

    def try_lane_change(self, v, t, mem):
        """Mandatory change out of forward lane 1 into lane 2, gap acceptance only."""
        lead = lag = None
        for o in mem[(1, 2)]:
            if o is v:
                continue
            if o.lane == 1 and o.target == 2 and o.p < 0.5 and o.s < v.s:
                continue  # still mostly in lane 1 behind us: not a lag vehicle yet
            if o.s >= v.s:
                if lead is None or o.s < lead.s:
                    lead = o
            else:
                if lag is None or o.s > lag.s:
                    lag = o
        v0 = self.v0_eff(v, t)
        if lead is not None:
            g = lead.s - v.s - (lead.L + v.L) / 2.0
            if g < max(2.5, 0.4 * v.v):
                return False
            if idm(v.v, v0, g, v.v - lead.v, v.a, v.b, v.T, v.s0) < -3.5:
                return False
        if lag is not None:
            g = v.s - lag.s - (v.L + lag.L) / 2.0
            if g < max(3.0, 0.5 * lag.v):
                return False
            if idm(lag.v, self.v0_eff(lag, t), g, lag.v - v.v, lag.a, lag.b, lag.T, lag.s0) < -4.0:
                return False
        if t < IMPACT_T + 1.5:
            yx = yellow_x(t)
            if yx >= v.s:
                g = yx - YELLOW_LENGTH / 2 - v.front()
                if g < max(36.0, 2.5 * v.v + 6.0):
                    return False
            else:
                g = v.s - v.L / 2 - (yx + YELLOW_LENGTH / 2)
                horizon = max(0.0, min(IMPACT_T, t + 8.0) - t)
                if g < 45.0 + max(0.0, YELLOW_SPEED - v.v) * horizon:
                    return False
        done_x = LC_DONE_PRE if t < IMPACT_T else LC_DONE_POST
        avail = done_x - v.s
        v.Llc = max(15.0, min(60.0, 4.0 * v.v, avail))
        v.target = 2
        v.p = 0.0
        v.lc_count += 1
        mem[(1, 2)].append(v)
        return True

    def run(self):
        n = int(round((CLIP_END - T_START) / DT))
        for k in range(n + 1):
            t = round(T_START + k * DT, 4)
            mem = self.members()
            for key in self.arrivals:
                self._try_spawn(t, key, mem)
            # record state at t, retire vehicles that left the road
            for v in self.active:
                v.rec.append((t, v.s, v.y(), v.v, v.acc, v.target is not None, v.slope()))
                if v.s > X_ENTER:
                    v.done = True
            if k == n:
                break
            still = [v for v in self.active if not v.done]
            self.finished.extend(v for v in self.active if v.done)
            self.active = still
            mem = self.members()
            # lane changes
            for v in self.active:
                if v.dir > 0 and v.lane == 1 and v.target is None and v.s >= v.desire_x:
                    self.try_lane_change(v, t, mem)
            # accelerations
            accs = [self.accel(v, t, mem) for v in self.active]
            for v, acc in zip(self.active, accs):
                nv = v.v + acc * DT
                if nv < 0.0:
                    ds = v.v * v.v / (2.0 * -acc) if acc < 0 else 0.0
                    acc = -v.v / DT
                    nv = 0.0
                else:
                    ds = v.v * DT + 0.5 * acc * DT * DT
                v.acc = acc
                v.s += ds
                v.v = nv
                if v.target is not None:
                    v.p += ds / v.Llc
                    if v.p >= 1.0:
                        v.lane = v.target
                        v.target = None
                        v.p = 0.0
        self.finished.extend(self.active)
        self.active = []
        # the acc stored with a record is the one applied over [t, t+DT]: shift by one
        for v in self.finished:
            rec = v.rec
            for i in range(len(rec) - 1):
                nxt_acc = (rec[i + 1][3] - rec[i][3]) / DT
                r = rec[i]
                rec[i] = (r[0], r[1], r[2], r[3], nxt_acc, r[5] or rec[i + 1][5], r[6])
            if rec:
                r = rec[-1]
                rec[-1] = (r[0], r[1], r[2], r[3], 0.0, r[5], r[6])
        return self.finished


# ---------------------------------------------------------------------------------------------
# Keyframes / spec objects


def sample_keyframes(v):
    recs = [r for r in v.rec if r[0] >= -1e-9]
    if len(recs) < 2:
        return []
    idx = [0]
    i = 0
    n = len(recs)
    while i < n - 1:
        chosen = 6
        for h, alim in ((24, 0.3), (12, 1.0)):
            j = min(i + h, n - 1)
            seg = recs[i:j + 1]
            if any(r[5] for r in seg) or any(abs(r[4]) > alim for r in seg[:-1]):
                continue
            chosen = h
            break
        j = min(i + chosen, n - 1)
        idx.append(j)
        i = j
    kfs = []
    for j in idx:
        t, s, y, sp, acc, lc, slope = recs[j]
        x = s if v.dir > 0 else -s
        heading = math.degrees(math.atan(slope)) if v.dir > 0 else 180.0
        kfs.append({
            "t_s": round(t, 2),
            "x_m": round(x, 3),
            "y_m": round(y, 3),
            "heading_deg": round(heading, 2) + 0.0,
            "speed_mps": round(sp * math.sqrt(1.0 + slope * slope), 2),
        })
    return kfs


def _simulate(seed):
    sim = Sim(seed)
    vehicles = sim.run()
    out = []
    for v in vehicles:
        kfs = sample_keyframes(v)
        if len(kfs) < 2:
            continue
        out.append((v, kfs))
    out.sort(key=lambda p: (p[1][0]["t_s"], -p[0].dir, p[0].lane, -p[1][0]["x_m"] * p[0].dir))
    return out


def background_objects(seed: int = 7) -> list:
    objs = []
    for n, (v, kfs) in enumerate(_simulate(seed), start=1):
        objs.append({
            "id": "bg-%03d" % n,
            "label": "%s %s" % (v.color_name, v.cat),
            "category": v.cat,
            "color_name": v.color_name,
            "color_hex": v.color_hex,
            "make": None,
            "model": None,
            "involvement": "background",
            "length_m": round(v.L, 2),
            "width_m": round(v.W, 2),
            "mass_kg": int(round(v.m, -1)),
            "visible_from_s": kfs[0]["t_s"],
            "visible_to_s": kfs[-1]["t_s"],
            "keyframes": kfs,
            "forces": [],
            "rest": None,
            "confidence": 0.85,
        })
    return objs


# ---------------------------------------------------------------------------------------------
# Self-check (on the rendered, linearly interpolated trajectories)


def _interp(kfs, t):
    if t < kfs[0]["t_s"] - 1e-9 or t > kfs[-1]["t_s"] + 1e-9:
        return None
    lo, hi = 0, len(kfs) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if kfs[mid]["t_s"] <= t:
            lo = mid
        else:
            hi = mid
    a, b = kfs[lo], kfs[hi]
    span = b["t_s"] - a["t_s"]
    u = 0.0 if span <= 0 else min(1.0, max(0.0, (t - a["t_s"]) / span))
    return (a["x_m"] + (b["x_m"] - a["x_m"]) * u, a["y_m"] + (b["y_m"] - a["y_m"]) * u,
            a["speed_mps"] + (b["speed_mps"] - a["speed_mps"]) * u)


def _lane_of(y):
    side = 1 if y < 0 else -1
    off = abs(y)
    lane = min((1, 2, 3), key=lambda l: abs(LANE_OFFSET[l] - off))
    return side, lane


def self_check(objs):
    errors = []
    by_id = {o["id"]: o for o in objs}

    def err(msg):
        if len(errors) < 40:
            errors.append(msg)
        else:
            errors.append(None)

    # per-object structure
    max_dec = 0.0
    max_acc = 0.0
    for o in objs:
        k = o["keyframes"]
        if o["visible_from_s"] != k[0]["t_s"] or o["visible_to_s"] != k[-1]["t_s"]:
            err("%s visible window mismatch" % o["id"])
        lane_changing = False
        for a, b in zip(k, k[1:]):
            dt = b["t_s"] - a["t_s"]
            if dt <= 0 or dt > 1.0 + 1e-6:
                err("%s keyframe spacing %.2f at %.2f" % (o["id"], dt, a["t_s"]))
            acc = (b["speed_mps"] - a["speed_mps"]) / dt
            max_dec = max(max_dec, -acc)
            max_acc = max(max_acc, acc)
            if abs(acc) > MAX_DECEL + 0.05:
                err("%s accel %.2f at %.2f" % (o["id"], acc, a["t_s"]))
            if abs(b["y_m"] - a["y_m"]) > 1e-3 and dt > 0.25 + 1e-6:
                err("%s lane change keyframes too sparse at %.2f" % (o["id"], a["t_s"]))
            if acc < -1.05 and dt > 0.25 + 1e-6:
                err("%s braking keyframes too sparse at %.2f" % (o["id"], a["t_s"]))
            dist = math.hypot(b["x_m"] - a["x_m"], b["y_m"] - a["y_m"])
            if dist > max(a["speed_mps"], b["speed_mps"]) * dt + 0.5 * MAX_DECEL * dt * dt + 0.05:
                err("%s teleport %.2f m in %.2f s at %.2f" % (o["id"], dist, dt, a["t_s"]))
            if abs(b["y_m"] - a["y_m"]) > 1e-3:
                lane_changing = True
        for f in k:
            if abs(f["x_m"]) > 145.0:
                err("%s x out of range %.1f" % (o["id"], f["x_m"]))
            direction = 1 if f["y_m"] < 0 else -1
            hd = f["heading_deg"]
            if direction > 0 and abs(hd) > 30 or direction < 0 and abs(hd - 180) > 30:
                err("%s heading %.1f wrong for direction" % (o["id"], hd))
        first, last = k[0], k[-1]
        if first["t_s"] > 0.01 and abs(abs(first["x_m"]) - X_ENTER) > 1.0:
            err("%s does not enter at the road end (x=%.1f)" % (o["id"], first["x_m"]))
        if last["t_s"] < CLIP_END - 0.01 and abs(last["x_m"]) < X_ENTER - 1.0:
            err("%s does not leave at the road end (x=%.1f)" % (o["id"], last["x_m"]))

    # pairwise spacing / crash constraints at 30 Hz
    min_gap = float("inf")
    min_gap_at = None
    yellow_min = {"ahead": float("inf"), "behind": float("inf")}
    lane1_min_speed_pre = float("inf")
    nframes = int(CLIP_END * 30)
    for fi in range(nframes + 1):
        t = round(fi / 30.0, 4)
        present = []
        for o in objs:
            p = _interp(o["keyframes"], t)
            if p is not None:
                present.append((o, p))
        for i in range(len(present)):
            oi, (xi, yi, vi) = present[i]
            for j in range(i + 1, len(present)):
                oj, (xj, yj, vj) = present[j]
                if abs(yi - yj) >= (oi["width_m"] + oj["width_m"]) / 2.0 + 0.2:
                    continue
                gap = abs(xi - xj) - (oi["length_m"] + oj["length_m"]) / 2.0
                if gap < min_gap:
                    min_gap, min_gap_at = gap, (oi["id"], oj["id"], t)
                if gap < 1.0:
                    err("overlap %s/%s gap %.2f at %.2f" % (oi["id"], oj["id"], gap, t))
        for o, (x, y, sp) in present:
            hw = o["width_m"] / 2.0
            half = o["length_m"] / 2.0
            in_lane1 = y - hw < LANE1_BAND[1] and y + hw > LANE1_BAND[0]
            if t < IMPACT_T:
                if in_lane1 and x + half > VAN_X - VAN_LENGTH / 2 - 1.0 and x - half < VAN_X + VAN_LENGTH / 2 + 1.0:
                    err("%s overlaps the van at %.2f" % (o["id"], t))
                if in_lane1 and x < VAN_X and abs(y - VAN_Y) < 0.3:
                    lane1_min_speed_pre = min(lane1_min_speed_pre, sp)
                if 18.0 <= t and in_lane1 and x - half < VAN_X:
                    err("%s in lane 1 behind the van at %.2f (x=%.1f y=%.2f)" % (o["id"], t, x, y))
            else:
                if in_lane1 and x + half > BLOCK_X0 and x - half < BLOCK_X1:
                    err("%s in blocked lane-1 zone at %.2f" % (o["id"], t))
                if y > LANE1_BAND[0] and y < 0 and x > -10.0 and x < BLOCK_X1:
                    err("%s still mostly in lane 1 at x=%.1f t=%.2f" % (o["id"], x, t))
            if 15.0 <= t <= IMPACT_T and LANE2_BAND[0] < y < LANE2_BAND[1]:
                yx = yellow_x(t)
                g = abs(x - yx) - (o["length_m"] + YELLOW_LENGTH) / 2.0
                if x > yx:
                    yellow_min["ahead"] = min(yellow_min["ahead"], g)
                    if g < max(35.0, 2.5 * YELLOW_SPEED):
                        err("%s %.1f m ahead of the yellow car at %.2f" % (o["id"], g, t))
                else:
                    yellow_min["behind"] = min(yellow_min["behind"], g)
                    if g < max(30.0, 2.5 * sp):
                        err("%s %.1f m behind the yellow car at %.2f" % (o["id"], g, t))
    if lane1_min_speed_pre < 3.0:
        err("lane-1 vehicle queued before the van (min speed %.1f)" % lane1_min_speed_pre)

    # lane-2 response after impact
    braking = []
    first_brake = None
    for o in objs:
        k = o["keyframes"]
        p = _interp(k, IMPACT_T)
        if p is None or p[0] > 6.0 or not (LANE2_BAND[0] < p[1] < LANE2_BAND[1]):
            pass
        for a, b in zip(k, k[1:]):
            if a["t_s"] < IMPACT_T - 1e-6 or a["t_s"] > IMPACT_T + 6.0:
                continue
            if not (LANE2_BAND[0] < a["y_m"] < LANE2_BAND[1]) or a["x_m"] > 6.0:
                continue
            acc = (b["speed_mps"] - a["speed_mps"]) / (b["t_s"] - a["t_s"])
            if acc < -2.5:
                if first_brake is None or a["t_s"] < first_brake:
                    first_brake = a["t_s"]
                break
        speeds = [f["speed_mps"] for f in k if f["t_s"] > IMPACT_T and LANE2_BAND[0] < f["y_m"] < LANE2_BAND[1] and f["x_m"] < 6.5]
        before = [f["speed_mps"] for f in k if f["t_s"] <= IMPACT_T + 0.3]
        if speeds and (min(speeds) < 3.0 or (before and before[-1] - min(speeds) > 5.0)):
            braking.append((o["id"], min(speeds)))
    if first_brake is not None and not (IMPACT_T + 0.5 <= first_brake <= IMPACT_T + 1.3):
        err("first lane-2 brake at %.2f s, expected 0.6-1.2 s after impact" % first_brake)

    extra = errors.count(None)
    errors = [e for e in errors if e is not None]
    return dict(errors=errors, extra_errors=extra, min_gap=min_gap, min_gap_at=min_gap_at, max_dec=max_dec,
                max_acc=max_acc, yellow_min=yellow_min, lane1_min_speed_pre=lane1_min_speed_pre,
                braking=braking, first_brake=first_brake)


def _summary(objs, seed):
    sim_vehicles = _simulate(seed)
    sim_max_dec = max((-min(r[4] for r in v.rec) for v, _ in sim_vehicles), default=0.0)
    counts = {}
    cats = {}
    for o in objs:
        side, lane = _lane_of(o["keyframes"][0]["y_m"])
        key = ("forward(+x)" if side > 0 else "backward(-x)", lane)
        counts[key] = counts.get(key, 0) + 1
        cats[o["category"]] = cats.get(o["category"], 0) + 1
    lc = sum(1 for v, _ in sim_vehicles if v.lc_count)
    print("background vehicles: %d" % len(objs))
    for side in ("forward(+x)", "backward(-x)"):
        tot = sum(c for (s, _), c in counts.items() if s == side)
        print("  %-13s %3d   " % (side, tot) + "  ".join("lane %d (entry): %d" % (l, counts.get((side, l), 0)) for l in (1, 2, 3)))
    print("  categories:", ", ".join("%s %d" % kv for kv in sorted(cats.items())))
    print("  lane changes out of forward lane 1: %d" % lc)
    print("  keyframes total: %d" % sum(len(o["keyframes"]) for o in objs))
    res = self_check(objs)
    print("min in-lane bumper gap (rendered, 30 Hz): %.2f m  %s" % (res["min_gap"], res["min_gap_at"]))
    print("max decel: keyframes %.2f m/s^2, simulation %.2f m/s^2; max accel (keyframes) %.2f" % (res["max_dec"], sim_max_dec, res["max_acc"]))
    print("yellow car 15-22.3 s: closest lane-2 vehicle ahead %.1f m, behind %.1f m" % (res["yellow_min"]["ahead"], res["yellow_min"]["behind"]))
    print("lane-1 min speed before the van (pre-impact): %.1f m/s" % res["lane1_min_speed_pre"])
    fb = res["first_brake"]
    print("lane 2 after impact: %d vehicles brake/queue, first hard brake at %s" % (
        len(res["braking"]), "%.2f s (+%.2f)" % (fb, fb - IMPACT_T) if fb is not None else "none"))
    print("  " + ", ".join("%s(min %.1f m/s)" % b for b in res["braking"]))
    if res["errors"]:
        print("FAILED: %d problems%s" % (len(res["errors"]), " (+%d more)" % res["extra_errors"] if res["extra_errors"] else ""))
        for e in res["errors"]:
            print("  -", e)
        return 1
    print("OK: all constraints hold")
    return 0


if __name__ == "__main__":
    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    sys.exit(_summary(background_objects(seed), seed))
