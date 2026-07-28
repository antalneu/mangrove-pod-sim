"""
proproots.py
============
The **real** root system of a young *Rhizophora* growing out of the propagule —
the prop-root (stilt-root) cage — and the wall load it produces.

This is the root system the tool draws and the one the mechanics now run on.
Previously the physics ran on a separate, invisible node tree while the visible
roots were "rendering only"; the two disagreed about what the plant was doing.

Why prop roots crack the pod
----------------------------
The propagule sits in the bore. Its stilt roots emerge from a collar on the lower
stem (z ~ 0.18-0.32 x H, at a stem radius of ~6 mm, i.e. *inside* the cavity),
arch OUTWARD to their widest point, then curve DOWN into the mud a foot-radius
away. Their intended path therefore crosses the pod wall at z ~ 60-85 mm — which
is exactly the **slot -> foot ligament** band (z_base_top ~ 50 up to the slot
bottom ~ 147). The pod is designed to release there, and that is precisely where
the roots drive through it.

So the load is not diffuse swelling: it is ~8 directed structural beams, each
bearing outward on one patch of wall, at known azimuths set by the cage. Whether
those azimuths line up with the scored seams is now a real design question.

The contact model
-----------------
A root cannot pass through an intact wall. Each arch has an *intended* path; the
wall blocks it at the bore. The indentation driving contact pressure is how far
past the bore that intended path has grown:

    delta(t) = r_intended(u(t)) - r_inner(z)        [>0 only, capped at the wall]

and the bearing pressure is the same turgor-bounded law the rest of the model
uses, p = p_root * (1 - exp(-delta/delta0)). Points still inside the bore, and
points already beyond the outer wall (they have left the pod, through the gaps
between the feet), carry no load.

Growth in time
--------------
Each strand carries `birth_p` (when it emerges) and `span` (its growth window),
both in the normalised growth parameter p in [0,1]. The tip EXTENDS first, then
the root THICKENS, the thickening lagging the extension by ~35% - so a node at
normalised arc length u exists once (p - birth_p)/span >= u.

Determinism
-----------
The cage is generated with the same mulberry32 PRNG the browser uses, consumed in
the same order, so `docs/static/engine.js` and this module build a
**bit-identical** cage for a given seed. Root architecture is therefore not a
source of divergence between the two engines.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

# --------------------------------------------------------------------------- #
#  mulberry32 — byte-for-byte the browser's PRNG, so both engines agree
# --------------------------------------------------------------------------- #
_U32 = 0xFFFFFFFF


def mulberry32(seed: int):
    a = (int(seed) & _U32) or 1

    def rnd():
        nonlocal a
        a = (a + 0x6D2B79F5) & _U32
        t = a
        t = (t ^ (t >> 15)) * (1 | a) & _U32
        t = (t + ((t ^ (t >> 7)) * (61 | t) & _U32)) & _U32 ^ t
        return ((t ^ (t >> 14)) & _U32) / 4294967296.0

    return rnd


# --------------------------------------------------------------------------- #
#  architecture parameters (mirror of _rzParams in engine.js)
# --------------------------------------------------------------------------- #
@dataclass
class PropRootParams:
    seed: int = 6
    levels: tuple = (0.18, 0.25, 0.32)   # emergence collar heights (x H)
    roots_per_level: tuple = (2, 3)
    min_roots: int = 7
    max_roots: int = 9
    stem_r_low: float = 6.5
    stem_r_high: float = 5.5
    reach: tuple = (0.85, 1.15)          # ground landing radius (x foot radius)
    over_arch: tuple = (1.00, 1.05)
    apex_z: tuple = (0.40, 0.52)
    base_r: tuple = (2.9, 3.7)           # near-stem tube radius
    older_thick: float = 0.6
    taper_mid: float = 0.72
    taper_tip: float = 0.32
    twist: float = 0.06
    sway_amp: float = 0.02
    short_frac: float = 0.12
    gen_delay: float = 0.42
    grow_span: float = 0.55
    seg: int = 8
    ug_depth: float = 0.05
    ug_run: float = 0.14


def _clip(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def _lerp(a, b, t):
    return a + (b - a) * t


def _smoother(t):
    t = _clip(t, 0.0, 1.0)
    return t * t * t * (t * (t * 6 - 15) + 10)


def _rand(rng, ab):
    return ab[0] + (ab[1] - ab[0]) * rng()


def _pol(r, az, z):
    return [r * np.cos(az), r * np.sin(az), z]


def _dist(a, b):
    return float(np.hypot(np.hypot(a[0] - b[0], a[1] - b[1]), a[2] - b[2]))


def _taper(t, p: PropRootParams):
    if t < 0.5:
        return _lerp(1.0, p.taper_mid, _smoother(t / 0.5))
    return _lerp(p.taper_mid, p.taper_tip, _smoother((t - 0.5) / 0.5))


def _catmull(W, seg):
    """Uniform Catmull-Rom through waypoints, clamped ends."""
    n = len(W)
    out = []

    def pt(i):
        return W[max(0, min(n - 1, i))]

    for i in range(n - 1):
        p0, p1, p2, p3 = pt(i - 1), pt(i), pt(i + 1), pt(i + 2)
        last = (i == n - 2)
        for s in range(seg + (1 if last else 0)):
            t = s / seg
            t2, t3 = t * t, t * t * t
            o = [0.0, 0.0, 0.0]
            for d in range(3):
                o[d] = 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t +
                              (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 +
                              (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)
            out.append(o)
    return out


@dataclass
class Strand:
    """One root: a polyline of [x, y, z, radius, u] samples plus its growth window."""
    pts: np.ndarray            # (n, 5)
    birth_p: float
    span: float
    underground: bool = False


def _arch_strand(o, p: PropRootParams, rng):
    """One aerial prop-root arch: attach -> rise out -> MAX horizontal -> curve
    down -> enter mud, as a Catmull-Rom spline through five waypoints."""
    hz, gz, reach = o["hz"], o["gz"], o["reach"]
    drop = hz - gz
    over = reach * _rand(rng, p.over_arch)
    apex_z = gz + drop * _rand(rng, p.apex_z)
    tw = p.twist * o["twist_sign"]

    def az_at(f):
        return o["az"] + tw * f + (rng() - 0.5) * 0.05

    short = o["short"]
    land_r = reach * _lerp(0.45, 0.72, rng()) if short else reach
    land_z = gz + drop * _lerp(0.14, 0.42, rng()) if short else gz
    stem_r = o["stem_r"]
    W = [
        _pol(stem_r, az_at(0.00), hz),
        _pol(stem_r + 0.28 * (reach - stem_r), az_at(0.15), hz - drop * 0.03),
        _pol(over, az_at(0.45), apex_z),
        _pol(land_r * 1.02 if short else reach * 0.99, az_at(0.76),
             _lerp(apex_z, land_z, 0.55)),
        _pol(land_r, az_at(1.00), land_z),
    ]
    raw = _catmull(W, p.seg)
    n = len(raw)
    cum = [0.0]
    for i in range(1, n):
        cum.append(cum[i - 1] + _dist(raw[i], raw[i - 1]))
    L = cum[n - 1] or 1.0
    pts = np.zeros((n, 5))
    for i in range(n):
        u = cum[i] / L
        q = raw[i]
        env = np.sin(np.pi * u)
        sway = o["sway"] * p.sway_amp * reach * env * np.sin(2.4 * np.pi * u + o["phase"])
        rr = np.hypot(q[0], q[1]) or 1.0
        pts[i] = (q[0] - (q[1] / rr) * sway, q[1] + (q[0] / rr) * sway, q[2],
                  o["base_r"] * _taper(u, p), u)
    land = None if short else (pts[n - 1, 0], pts[n - 1, 1])
    a, b = pts[n - 2], pts[n - 1]
    dx, dy = b[0] - a[0], b[1] - a[1]
    l = np.hypot(dx, dy) or 1.0
    return pts, land, (dx / l, dy / l), o["base_r"] * p.taper_tip


def _ug_plunge(land, direction, r0, rng, reach, gz, height, p: PropRootParams):
    """Short underground planting root below the landing point."""
    depth = p.ug_depth * height
    run = p.ug_run * reach * (0.7 + 0.5 * rng())
    dx, dy = direction[0], direction[1]
    W = [
        [land[0], land[1], gz],
        [land[0] + dx * run * 0.55, land[1] + dy * run * 0.55, gz - depth * 0.5],
        [land[0] + dx * run, land[1] + dy * run, gz - depth],
    ]
    raw = _catmull(W, 5)
    n = len(raw)
    pts = np.zeros((n, 5))
    for i in range(n):
        u = i / (n - 1)
        pts[i] = (raw[i][0], raw[i][1], raw[i][2], _lerp(r0, r0 * 0.4, u), u)
    return pts


def ground_z(pod) -> float:
    return 0.03 * pod.features.height


def build_cage(pod, params: Optional[PropRootParams] = None,
               seed: Optional[int] = None) -> List[Strand]:
    """Build the prop-root cage. Deterministic, and identical to the browser's."""
    p = params or PropRootParams()
    if seed is not None:
        p = PropRootParams(**{**p.__dict__, "seed": int(seed)})
    from .render3d import _outer_r_at
    H = pod.features.height
    foot_r = float(_outer_r_at(pod, 0.05 * H))
    gz = ground_z(pod)
    rng = mulberry32(p.seed)
    n_levels = len(p.levels)

    counts = [p.roots_per_level[0]
              + int(rng() * (p.roots_per_level[1] - p.roots_per_level[0] + 1))
              for _ in p.levels]
    total = sum(counts)
    while total < p.min_roots:
        counts[int(rng() * n_levels)] += 1
        total += 1
    while total > p.max_roots:
        k = int(rng() * n_levels)
        if counts[k] > 1:
            counts[k] -= 1
            total -= 1

    az = rng() * np.pi * 2
    step = np.pi * 2 / total
    strands: List[Strand] = []
    for li in range(n_levels):
        gen = li / (n_levels - 1) if n_levels > 1 else 0.0
        older = 1.0 - gen
        hz = p.levels[li] * H
        stem_r = _lerp(p.stem_r_low, p.stem_r_high, gen)
        for _ in range(counts[li]):
            az += step * (0.82 + 0.36 * rng())
            reach = foot_r * _rand(rng, p.reach) * (1 + older * 0.14)
            base_r = _rand(rng, p.base_r) + older * p.older_thick
            short = (rng() < p.short_frac) and li >= 1
            phase = rng() * 6.283
            rng()                                   # tint draw (colour only)
            birth_p = _clip(gen * p.gen_delay + (rng() - 0.5) * 0.06, 0, 0.9)
            span = p.grow_span * (0.85 + 0.3 * rng())
            twist_sign = -1 if rng() < 0.5 else 1
            sway = 0.6 + 0.8 * rng()
            pts, land, land_dir, tip_r = _arch_strand(
                dict(hz=hz, az=az + (rng() - 0.5) * 0.12, stem_r=stem_r, reach=reach,
                     base_r=base_r, gz=gz, twist_sign=twist_sign, sway=sway,
                     phase=phase, short=short), p, rng)
            strands.append(Strand(pts=pts, birth_p=birth_p, span=span * 0.62))
            if land is not None:
                strands.append(Strand(
                    pts=_ug_plunge(land, land_dir, tip_r, rng, reach, gz, H, p),
                    birth_p=_clip(birth_p + span * 0.55, 0, 0.95),
                    span=span * 0.5, underground=True))
    return strands


# --------------------------------------------------------------------------- #
#  cage -> wall contact stations
# --------------------------------------------------------------------------- #
@dataclass
class ContactStations:
    """Where the prop roots bear on the wall, and when.

    Each station is one sampled point of an arch whose intended path lies inside
    the wall band. `delta_max` is how far past the bore that point sits (the
    indentation available once it has grown), `birth_frac` when it appears in the
    normalised growth parameter p, and `radius0` its untapered contact radius."""
    xyz: np.ndarray          # (n, 3) contact point on the wall
    delta_max: np.ndarray    # (n,) radial advance past the bore, mm
    birth_frac: np.ndarray   # (n,) p at which this point has grown
    thicken_p: np.ndarray    # (n,) p at which thickening is complete
    radius: np.ndarray       # (n,) full-grown radius at that station
    strand: np.ndarray       # (n,) which strand it belongs to

    def __len__(self):
        return len(self.delta_max)


def contact_stations(pod, strands: List[Strand]) -> ContactStations:
    """Reduce the cage to the points that actually load the wall.

    A point loads the wall when its intended path lies between the bore and the
    outer surface. Inside the bore it has not reached the wall; beyond the outer
    surface it has left the pod (through the gaps between the feet) and is no
    longer pressing on anything."""
    from .render3d import _outer_r_at
    xyz, dmax, bfrac, tp, rad, sid = [], [], [], [], [], []
    for si, st in enumerate(strands):
        if st.underground:
            continue                       # below the mud, outside the pod
        P = st.pts
        r = np.hypot(P[:, 0], P[:, 1])
        r_in = pod.r_inner_at(P[:, 2])
        r_out = _outer_r_at(pod, P[:, 2])
        inside_wall = (r > r_in) & (r <= r_out)
        for i in np.where(inside_wall)[0]:
            u = P[i, 4]
            xyz.append((P[i, 0], P[i, 1], P[i, 2]))
            dmax.append(float(r[i] - r_in[i]))
            bfrac.append(st.birth_p + st.span * u)
            tp.append(st.birth_p + st.span * 1.35)
            rad.append(float(P[i, 3]))
            sid.append(si)
    n = len(dmax)
    return ContactStations(
        xyz=np.array(xyz).reshape(n, 3), delta_max=np.array(dmax),
        birth_frac=np.array(bfrac), thicken_p=np.array(tp),
        radius=np.array(rad), strand=np.array(sid, int))


# --------------------------------------------------------------------------- #
#  adapter: the cage as the load source pressure.py already knows how to drive
# --------------------------------------------------------------------------- #
class PropRootSystem:
    """The prop-root cage presented as the node set `pressure.run_simulation`
    consumes, so the whole v2 wall-mechanics chain runs on it unchanged.

    Each node is a wall contact station. `radius_at` overrides the generic
    swelling law with the prop root's own growth: the tip EXTENDS to the station
    first, then the root THICKENS behind it (lagging by ~35%)."""

    def __init__(self, pod, strands: List[Strand], stations: ContactStations):
        self.strands = strands
        self.stations = stations
        self.nodes = list(stations.xyz)
        self.P = stations.xyz
        self.radius = stations.radius.copy()
        self.parent_arr = np.full(len(stations), -1, int)
        self.order = np.zeros(len(stations), int)
        # birth STEP on the sim's own axis: pressure.py renormalises birth by its
        # max, so store the growth fraction scaled onto a convenient integer axis
        self.birth_arr = np.round(stations.birth_frac * 1000).astype(int)
        self._birth_frac = stations.birth_frac
        self._thicken_p = stations.thicken_p
        self._full_r = stations.radius.copy()

    def positions(self):
        return self.P

    def segments(self):
        return []

    def birth_time(self, T):
        """Real step at which each station's root tip actually reaches it. The
        cage's growth fractions are already on the window's own time axis, so
        they must NOT be renormalised - doing so pulls the late-emerging roots
        forward and loads the wall before they exist."""
        return self._birth_frac * T

    def radius_at(self, t, T):
        """Contact radius at step t. Zero before the tip arrives; then the root
        thickens from half to full girth over its thickening window."""
        p = t / max(T, 1)
        grown = p >= self._birth_frac
        span = np.maximum(self._thicken_p - self._birth_frac, 1e-6)
        thicken = 0.5 + 0.5 * np.clip((p - self._birth_frac) / span, 0.0, 1.0)
        return np.where(grown, self._full_r * thicken, 0.0)


class _CageRenderTree:
    """The cage as a node/parent tree, so the existing tapered-tube renderers
    draw the actual prop roots. Physics uses the contact stations; this is only
    geometry for the figures."""

    def __init__(self, strands: List[Strand]):
        nodes, parent, radius, birth = [], [], [], []
        for st in strands:
            first = len(nodes)
            for i, q in enumerate(st.pts):
                nodes.append(np.array([q[0], q[1], q[2]]))
                parent.append(-1 if i == 0 else first + i - 1)
                radius.append(q[3])
                birth.append(st.birth_p + st.span * q[4])
        self.nodes = nodes
        self.parent_arr = np.array(parent, int)
        self.parent = list(parent)
        self.radius = np.array(radius)
        self.birth_arr = np.array(birth)

    def positions(self):
        return np.array(self.nodes)

    def segments(self):
        return [(self.nodes[p], self.nodes[i])
                for i, p in enumerate(self.parent_arr) if p >= 0]


def cage_render_tree(strands: List[Strand]) -> "_CageRenderTree":
    """Geometry of the prop-root cage for rendering."""
    return _CageRenderTree(strands)


def grow_prop_roots(pod, params: Optional[PropRootParams] = None,
                    seed: Optional[int] = None) -> PropRootSystem:
    """Build the propagule's prop-root cage and reduce it to the wall load it
    applies. This is the load source the failure model runs on."""
    strands = build_cage(pod, params, seed)
    return PropRootSystem(pod, strands, contact_stations(pod, strands))
