"""
growth.py
=========
Root-system growth inside the pod cavity for a young *Rhizophora* seedling.

This is a **rule-based architectural model**, not a space-filling tangle. Real
seedling roots are strongly structured, and that structure is what decides where
the pod wall gets loaded, so the model reproduces it explicitly:

1. **A dominant taproot.** The radicle emerges from the lower end of the
   hypocotyl and descends the cavity, steeply gravitropic and much thicker than
   anything else. It is one axis, not a spray of equals.
2. **Acropetal lateral emergence.** Laterals appear *behind* the advancing tip,
   at roughly regular intervals along the parent, so the oldest (and longest)
   laterals sit highest up an axis and the youngest cluster near the tip.
3. **Gravitropic set-point angles (GSA).** Each root order holds a characteristic
   angle to the horizontal rather than growing straight: the taproot near
   vertical, first-order laterals spreading obliquely, higher orders nearly
   horizontal and exploratory. A tip's direction *relaxes* toward its GSA each
   step, which is what gives real roots their curve.
4. **Spiral branching.** Successive laterals are rolled around the parent axis by
   the golden angle (~137.5 deg), so they distribute around it instead of
   stacking in a plane.
5. **Tortuosity as a correlated random walk.** Direction persists and turns
   slightly each step, so roots undulate smoothly instead of jittering.
6. **Mechanical deflection at the wall.** A root that reaches the inner wall
   cannot bore through it: it deflects and *slides along* the surface. This is
   real root behaviour against an impenetrable boundary, and it is also what
   keeps sustained contact pressure on the wall.

The result is a `RootSystem`: a tree of nodes (each with a birth time-step, a
branch order and a pipe-model radius) that pressure.py later "inflates" over time
to push on the inner wall. All tips advance one segment per step, so a node's
birth step is a real developmental age.

Configurable knobs (GrowthParams)
---------------------------------
step_size           segment length (governs growth *rate* and node spacing)
max_steps           cap on developmental steps
n_seeds             primary axes from the hypocotyl base (Rhizophora puts down
                    a dominant radicle, often with a couple of near-equals)
n_attractors        overall root DENSITY - scales lateral spacing (name kept for
                    UI/config compatibility with the browser tool)
down_bias           gravitropism strength (how hard tips pull to their GSA)
slot_bias           extra pull of laterals toward the slot / foot sectors
wall_bias           outward pull toward the inner wall (more wall contact)
jitter              tortuosity of the correlated random walk
max_order           deepest branch order (0 = taproot only)
branch_angle_deg    mean insertion angle of a lateral from its parent axis
lateral_spacing     distance along a parent between successive laterals
length_falloff      each order grows this fraction of its parent's length
tip_radius, pipe_exponent, radius_gain   root-thickening (pipe model)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

# Gravitropic set-point angle per branch order, in degrees from HORIZONTAL
# (negative = downward). Taproot near-vertical; first-order laterals oblique;
# higher orders near-horizontal and exploratory.
GSA_BY_ORDER_DEG = (-84.0, -32.0, -12.0, -6.0)
# Golden angle: successive laterals roll around the parent axis by this, which
# spreads them helically instead of stacking them in one plane.
DIVERGENCE_DEG = 137.507


@dataclass
class GrowthParams:
    step_size: float = 7.0
    max_steps: int = 200
    n_seeds: int = 3
    n_attractors: int = 2600        # overall density (see module docstring)
    jitter: float = 0.30            # tortuosity of the correlated random walk
    down_bias: float = 0.55         # gravitropism strength
    slot_bias: float = 2.2          # lateral pull toward slots / feet
    wall_bias: float = 0.75         # 0 = fill volume, 1 = hug the inner wall
    seed_depth_frac: float = 0.92   # radicle starts just below the top opening
    # --- developmental pacing (Rhizophora growth stages) ---
    # A real Rhizophora does NOT have a branched root system in year one. Field
    # growth stages: 0-1 yr the PRIMARY root develops; 1-2 yr lateral roots
    # BEGIN to form; 2-3 yr laterals become numerous; 3-5 yr prop roots start.
    # Branch order therefore has to be gated by the plant's real age, not just
    # by arc length - otherwise a 12-month window grows a 3-year root system and
    # the pod is loaded years before it would be in the ground.
    window_months: float = 12.0
    order_onset_months: tuple = (0.0, 12.0, 24.0, 36.0)
    # --- architecture ---
    max_order: int = 3
    branch_angle_deg: float = 68.0
    branch_angle_sd: float = 13.0
    # Calibrated so the default density (n_attractors = 2600) yields a node
    # count comparable to the space-colonization model this replaced, keeping
    # the density knob's meaning - and the wall loading it produces - stable.
    lateral_spacing: float = 31.0   # along-parent distance between laterals
    length_falloff: float = 0.42    # each order grows this fraction of parent
    apical_unbranched: float = 16.0 # unbranched zone behind each tip
    # --- basal anchoring zone (the root ball that splays the feet) ---
    basal_zone_frac: float = 1.7    # zone reaches this multiple of z_base_top
    basal_flare: float = 0.55       # outward drive once inside that zone
    basal_branch_factor: float = 0.60   # laterals crowd (spacing x this)
    basal_lateral_len: float = 46.0     # basal laterals reach out into the feet
    wall_friction: float = 0.45     # damps sliding along the wall (0 = frictionless)
    wall_seek_frac: float = 0.80    # outward drift stops past this frac of the bore
    # thickening (pipe model)
    tip_radius: float = 1.4
    pipe_exponent: float = 2.3
    radius_gain: float = 1.7
    order_radius_falloff: float = 0.72   # finer tips at higher branch order


class RootSystem:
    """A grown root tree. Nodes are 3-D points; edges connect child->parent."""

    def __init__(self):
        self.nodes = []          # list of xyz
        self.parent = []         # parent index (-1 for seeds)
        self.birth = []          # growth step at which the node was created
        self.order = []          # branch order (0 = taproot)
        self.radius = None       # np.array pipe-model radius per node (set later)

    def add(self, xyz, parent, step, order=0):
        self.nodes.append(np.asarray(xyz, float))
        self.parent.append(parent)
        self.birth.append(step)
        self.order.append(int(order))
        return len(self.nodes) - 1

    def finalize(self, tip_radius, pipe_exponent, radius_gain,
                 order_radius_falloff=1.0):
        """Assign radii by the pipe model: r_parent^p = sum(r_child^p).

        Tip radius tapers with branch order, so fine higher-order roots stay
        fine and the taproot ends up genuinely dominant."""
        n = len(self.nodes)
        P = np.array(self.nodes)
        parent = np.array(self.parent)
        order = np.array(self.order, int)
        children = [[] for _ in range(n)]
        for i, p in enumerate(parent):
            if p >= 0:
                children[p].append(i)
        rp = pipe_exponent
        tip_r = float(tip_radius) * (order_radius_falloff ** order)
        rad = tip_r.copy()
        # process leaves -> root (reverse birth order is a safe topological order)
        ordering = np.argsort(self.birth)[::-1]
        for i in ordering:
            if children[i]:
                s = sum(rad[c] ** rp for c in children[i])
                rad[i] = max(tip_r[i], s ** (1.0 / rp))
        self.radius = rad * radius_gain
        self.P = P
        self.parent_arr = parent
        self.birth_arr = np.array(self.birth)
        self.order_arr = order
        return self

    def segments(self):
        """List of (parent_xyz, node_xyz) for drawing."""
        segs = []
        for i, p in enumerate(self.parent):
            if p >= 0:
                segs.append((self.nodes[p], self.nodes[i]))
        return segs

    def positions(self):
        return np.array(self.nodes)


class _Tip:
    """One growing root apex."""
    __slots__ = ("node", "dir", "order", "remaining", "since_branch", "roll")

    def __init__(self, node, direction, order, remaining, roll=0.0):
        self.node = node
        self.dir = direction
        self.order = order
        self.remaining = remaining
        self.since_branch = 0.0
        self.roll = roll


def _unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else np.array([0.0, 0.0, -1.0])


def _gsa_dir(direction, gsa_deg):
    """The direction this tip is 'trying' to hold: its current horizontal
    heading, tilted to the gravitropic set-point angle from horizontal."""
    h = np.array([direction[0], direction[1], 0.0])
    nh = np.linalg.norm(h)
    if nh < 1e-9:                      # travelling straight up/down: pick any azimuth
        h = np.array([1.0, 0.0, 0.0])
        nh = 1.0
    h /= nh
    a = np.radians(gsa_deg)
    return _unit(np.array([h[0] * np.cos(a), h[1] * np.cos(a), np.sin(a)]))


def _perp_basis(direction):
    """Two unit vectors spanning the plane perpendicular to `direction`."""
    ref = np.array([0.0, 0.0, 1.0])
    if abs(direction[2]) > 0.9:
        ref = np.array([1.0, 0.0, 0.0])
    u = _unit(np.cross(direction, ref))
    v = _unit(np.cross(direction, u))
    return u, v


def _slot_azimuths(pod):
    f = pod.features
    if f.slots:
        return np.radians([s.theta_deg for s in f.slots])
    if f.feet:
        return np.radians([ft.theta_deg for ft in f.feet])
    return np.array([])


def grow(pod, params: Optional[GrowthParams] = None, seed: int = 0) -> RootSystem:
    """Grow a structured seedling root system and return a finalized RootSystem."""
    params = params or GrowthParams()
    p = params
    rng = np.random.default_rng(seed)
    # Only the orders whose developmental onset falls inside the window exist.
    allowed_order = max(0, sum(1 for m in p.order_onset_months
                               if m <= p.window_months) - 1)
    max_order = min(p.max_order, allowed_order)
    f = pod.features
    H = f.height
    z_base = f.z_base_top
    slot_th = _slot_azimuths(pod)

    # Density knob -> lateral spacing. More density = laterals closer together.
    density = max(float(p.n_attractors), 1.0) / 2600.0
    spacing0 = max(p.lateral_spacing / max(density, 0.25), p.step_size)

    rs = RootSystem()

    # ---- primary axes from the hypocotyl base -------------------------------
    # The radicle emerges from the lower end of the propagule and descends. A
    # couple of near-equal companions is normal; they start close to the axis.
    z_seed = p.seed_depth_frac * H
    r_seed = max(pod.r_inner_at(z_seed) * 0.4, 3.0)
    axis_len = 0.95 * (z_seed - 0.02 * H)
    tips: List[_Tip] = []
    for k in range(max(1, p.n_seeds)):
        th = 2 * np.pi * k / max(1, p.n_seeds) + rng.uniform(0, 1)
        pos = np.array([r_seed * np.cos(th) * 0.3, r_seed * np.sin(th) * 0.3, z_seed])
        ni = rs.add(pos, -1, 0, order=0)
        d = _unit(np.array([np.cos(th) * 0.12, np.sin(th) * 0.12, -1.0]))
        tips.append(_Tip(ni, d, 0, axis_len * rng.uniform(0.9, 1.05),
                         roll=rng.uniform(0, 2 * np.pi)))

    P = rs.nodes
    for step in range(1, p.max_steps + 1):
        if not tips:
            break
        spawned: List[_Tip] = []
        for tip in tips:
            if tip.remaining <= 0:
                continue
            here = P[tip.node]
            d = tip.dir

            # --- direction update -------------------------------------------
            # relax toward the gravitropic set-point angle for this order
            gsa = GSA_BY_ORDER_DEG[min(tip.order, len(GSA_BY_ORDER_DEG) - 1)]
            target = _gsa_dir(d, gsa)
            d = d + (0.25 + 0.75 * p.down_bias) * 0.45 * (target - d)
            # laterals steer toward the nearest slot / foot meridian, which is
            # where the pod is designed to open
            if tip.order >= 1 and len(slot_th):
                az = np.arctan2(here[1], here[0])
                k = int(np.argmin(np.abs(np.angle(np.exp(1j * (slot_th - az))))))
                want = slot_th[k]
                pull = 0.12 * p.slot_bias / (1.0 + p.slot_bias)
                d = d + pull * np.array([np.cos(want), np.sin(want), 0.0])
            # Outward drift toward the wall (more contact), for the spreading
            # orders only - the taproot stays central. This is a SEEKING term:
            # it stops once the root has found the wall, because a root already
            # bearing on a surface is not driven further into it. Leaving it on
            # pins every lateral to the bore at full turgor pressure.
            if tip.order >= 1:
                rr = np.hypot(here[0], here[1])
                if rr > 1e-6 and rr < p.wall_seek_frac * pod.r_inner_at(here[2]):
                    d = d + 0.10 * p.wall_bias * np.array([here[0] / rr, here[1] / rr, 0.0])
            # Basal root ball: a stranded propagule anchors by throwing its roots
            # OUT into the feet once they reach the base, and that splaying is
            # what loads the base split-lines. Below the basal zone every order
            # flattens out and drives outward hard.
            in_base = here[2] < z_base * p.basal_zone_frac
            if in_base:
                rr = np.hypot(here[0], here[1])
                if rr > 1e-6:
                    d = d + p.basal_flare * np.array([here[0] / rr, here[1] / rr, 0.0])
                d[2] += 0.25 * p.basal_flare     # flatten out along the base
            # tortuosity: a small correlated turn, not white noise
            d = _unit(d + p.jitter * 0.30 * rng.normal(0, 1, 3))

            newp = here + d * p.step_size

            # --- confinement + mechanical deflection along the wall ----------
            newp[2] = float(np.clip(newp[2], 0.02 * H, 0.99 * H))
            r_here = pod.r_inner_at(newp[2])
            rr = np.hypot(newp[0], newp[1])
            limit = 0.985 * r_here
            if rr > limit and rr > 1e-6:
                newp[0] *= limit / rr
                newp[1] *= limit / rr
                # a root cannot bore through the wall: drop the outward radial
                # component so it slides along the surface instead
                nrad = np.array([newp[0], newp[1], 0.0])
                nn = np.linalg.norm(nrad)
                if nn > 1e-6:
                    nrad /= nn
                    out = float(np.dot(d, nrad))
                    if out > 0:
                        d = d - out * nrad
                    # Friction against the wall: a root pinned to a surface does
                    # not slide freely sideways. Damping the circumferential
                    # component stops tips from spiralling round the bore and
                    # braiding into a rope, which is not how laterals behave.
                    tang = np.array([-nrad[1], nrad[0], 0.0])
                    circ = float(np.dot(d, tang))
                    d = _unit(d - p.wall_friction * circ * tang)

            ni = rs.add(newp, tip.node, step, order=tip.order)
            tip.node = ni
            tip.dir = d
            tip.remaining -= p.step_size
            tip.since_branch += p.step_size

            # --- acropetal lateral emergence ---------------------------------
            # laterals crowd together in the basal anchoring zone
            spacing = spacing0 * (1.0 + 0.35 * tip.order)
            if in_base:
                spacing *= p.basal_branch_factor
            # In the anchoring zone an axis keeps throwing laterals even as it
            # runs out of length - that terminal whorl IS the root ball.
            # Laterals are only just beginning at the end of year one, so they
            # may not appear until the plant is developmentally old enough.
            onset = p.order_onset_months[min(tip.order + 1, len(p.order_onset_months) - 1)]
            mature_enough = (step / max(p.max_steps, 1)) >= min(onset / max(p.window_months, 1e-6), 1.0)
            can_branch = mature_enough and (tip.remaining > p.apical_unbranched
                                            or (in_base and tip.order <= 1))
            if tip.order < max_order and tip.since_branch >= spacing and can_branch:
                tip.since_branch = 0.0
                tip.roll += np.radians(DIVERGENCE_DEG)
                ang = np.radians(max(15.0, rng.normal(p.branch_angle_deg,
                                                      p.branch_angle_sd)))
                u, v = _perp_basis(d)
                side = np.cos(tip.roll) * u + np.sin(tip.roll) * v
                ld = _unit(np.cos(ang) * d + np.sin(ang) * side)
                # a lateral is shorter than what remains of its parent axis,
                # except in the base where it must reach out into the feet
                llen = max(2.0 * p.step_size,
                           p.length_falloff * (tip.remaining + p.step_size)
                           * rng.uniform(0.75, 1.25))
                # Only the main axes throw the long anchoring roots; letting
                # every order do it in the base compounds into a runaway ball.
                if in_base and tip.order <= 1:
                    llen = max(llen, p.basal_lateral_len
                               * (p.length_falloff ** tip.order)
                               * rng.uniform(0.7, 1.3))
                spawned.append(_Tip(ni, ld, tip.order + 1, llen,
                                    roll=rng.uniform(0, 2 * np.pi)))

        tips = [t for t in tips if t.remaining > 0] + spawned

    rs.finalize(p.tip_radius, p.pipe_exponent, p.radius_gain,
                p.order_radius_falloff)
    return rs
