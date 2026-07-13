"""
growth.py
=========
Branching root-system growth inside the pod cavity, using a space-colonization
algorithm (Runions et al.). Roots are seeded near the top opening (where the
sapling emerges) and grow *downward* through the waist and *outward* toward the
base feet, with a configurable directional bias toward the existing waist slots
and the base split-lines - the geometric weak points.

The result is a `RootSystem`: a tree of nodes (each with a birth time-step and a
pipe-model radius) that the pressure model later "inflates" over time to push on
the inner wall.

Configurable knobs (GrowthParams)
---------------------------------
step_size           advance per growth step (governs growth *rate*)
influence_radius    how far an attractor can pull a tip (branch spread)
kill_radius         attractor consumed when a tip gets this close
n_attractors        number of auxin sources -> density / branch frequency
jitter              random perturbation of growth direction (irregularity)
down_bias           extra pull downward (toward base)
slot_bias           extra attractor density in the slot / foot angular sectors
wall_bias           push attractors toward the inner wall (more wall contact)
tip_radius, pipe_exponent, radius_gain   root-thickening (pipe model)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np
from scipy.spatial import cKDTree


@dataclass
class GrowthParams:
    step_size: float = 7.0
    influence_radius: float = 45.0
    kill_radius: float = 10.0
    n_attractors: int = 2600
    max_steps: int = 200
    n_seeds: int = 3
    jitter: float = 0.35
    down_bias: float = 0.55
    slot_bias: float = 2.2          # attractor over-density toward slots/feet
    wall_bias: float = 0.75         # 0=fill volume, 1=hug the inner wall
    seed_depth_frac: float = 0.92   # seeds start just below the top opening
    # thickening (pipe model)
    tip_radius: float = 1.4
    pipe_exponent: float = 2.3
    radius_gain: float = 1.7        # multiplies pipe radius (overall roots girth)


class RootSystem:
    """A grown root tree. Nodes are 3-D points; edges connect child->parent."""

    def __init__(self):
        self.nodes = []          # list of xyz
        self.parent = []         # parent index (-1 for seeds)
        self.birth = []          # growth step at which the node was created
        self.radius = None       # np.array pipe-model radius per node (set later)

    def add(self, xyz, parent, step):
        self.nodes.append(np.asarray(xyz, float))
        self.parent.append(parent)
        self.birth.append(step)
        return len(self.nodes) - 1

    def finalize(self, tip_radius, pipe_exponent, radius_gain):
        """Assign radii by the pipe model: r_parent^p = sum(r_child^p)."""
        n = len(self.nodes)
        P = np.array(self.nodes)
        parent = np.array(self.parent)
        children = [[] for _ in range(n)]
        for i, p in enumerate(parent):
            if p >= 0:
                children[p].append(i)
        rp = pipe_exponent
        rad = np.full(n, float(tip_radius))
        # process leaves -> root (reverse birth order is a safe topological order)
        order = np.argsort(self.birth)[::-1]
        for i in order:
            if children[i]:
                s = sum(rad[c] ** rp for c in children[i])
                rad[i] = max(tip_radius, s ** (1.0 / rp))
        self.radius = rad * radius_gain
        self.P = P
        self.parent_arr = parent
        self.birth_arr = np.array(self.birth)
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


def _sample_attractors(pod, params: GrowthParams, rng) -> np.ndarray:
    """Auxin sources inside the cavity, biased downward, toward the inner wall,
    and toward the slot / foot angular sectors."""
    f = pod.features
    H = f.height
    zc, ri = pod.inner_radius_profile()
    slot_th = np.radians([s.theta_deg for s in f.slots]) if f.slots else np.array([])

    n = params.n_attractors
    pts = []
    tries = 0
    while len(pts) < n and tries < n * 60:
        tries += 1
        z = rng.uniform(0.04 * H, 0.98 * H)
        # downward bias: weight rises toward the base (z->0)
        w = 1.0 - 0.7 * params.down_bias * (z / H)
        if rng.random() > w:
            continue
        r_in = max(float(np.interp(z, zc, ri)), 2.0)
        # radial position: wall_bias -> concentrate near the inner wall
        u = rng.random()
        frac = u ** (1.0 - 0.85 * params.wall_bias)   # ->1 hugs the wall
        rad = frac * 0.95 * r_in
        # angular position: slot_bias -> over-density in slot / foot sectors
        if len(slot_th) and rng.random() < params.slot_bias / (params.slot_bias + 1):
            th = slot_th[rng.integers(len(slot_th))] + rng.normal(0, np.radians(20))
        else:
            th = rng.uniform(-np.pi, np.pi)
        x, y = rad * np.cos(th), rad * np.sin(th)
        pts.append((x, y, z))
    return np.array(pts) if pts else np.zeros((0, 3))


def grow(pod, params: Optional[GrowthParams] = None, seed: int = 0) -> RootSystem:
    """Run space-colonization growth and return a finalized RootSystem."""
    params = params or GrowthParams()
    rng = np.random.default_rng(seed)
    f = pod.features
    H = f.height

    attractors = _sample_attractors(pod, params, rng)
    rs = RootSystem()

    # seeds near the top opening, pointing down and slightly spread
    top = np.array(f.top_center, float)
    z_seed = params.seed_depth_frac * H
    r_seed = max(pod.r_inner_at(z_seed) * 0.4, 3.0)
    for k in range(params.n_seeds):
        th = 2 * np.pi * k / params.n_seeds + rng.uniform(0, 1)
        p = np.array([r_seed * np.cos(th) * 0.3, r_seed * np.sin(th) * 0.3, z_seed])
        rs.add(p, -1, 0)

    down = np.array([0, 0, -1.0])
    for step in range(1, params.max_steps + 1):
        if len(attractors) == 0:
            break
        P = np.array(rs.nodes)
        tree = cKDTree(P)
        # each attractor -> nearest node (if within influence radius)
        dist, idx = tree.query(attractors, k=1)
        within = dist < params.influence_radius
        if not np.any(within):
            # nothing in reach: advance the single tip nearest to the closest
            # remaining attractor so growth can bridge gaps instead of stalling
            a_near = int(np.argmin(dist))
            within = np.zeros_like(within)
            within[a_near] = True
        # accumulate growth direction per influenced node
        grow_dir = {}
        for a_i in np.where(within)[0]:
            ni = idx[a_i]
            d = attractors[a_i] - P[ni]
            nrm = np.linalg.norm(d)
            if nrm < 1e-6:
                continue
            grow_dir.setdefault(ni, []).append(d / nrm)
        new_nodes = []
        for ni, dirs in grow_dir.items():
            v = np.mean(dirs, axis=0)
            v = v + params.down_bias * 0.5 * down
            v = v + params.jitter * rng.normal(0, 1, 3)
            nv = np.linalg.norm(v)
            if nv < 1e-6:
                continue
            v /= nv
            newp = P[ni] + v * params.step_size
            # keep inside the cavity (clamp radius)
            r_here = pod.r_inner_at(newp[2])
            rr = np.hypot(newp[0], newp[1])
            if rr > 0.98 * r_here and rr > 1e-6:
                newp[0] *= 0.98 * r_here / rr
                newp[1] *= 0.98 * r_here / rr
            newp[2] = np.clip(newp[2], 0.02 * H, 0.99 * H)
            new_nodes.append((ni, newp, step))
        if not new_nodes:
            break
        for ni, newp, st in new_nodes:
            rs.add(newp, ni, st)
        # consume attractors near any (new) node
        P2 = np.array(rs.nodes)
        tree2 = cKDTree(P2)
        d2, _ = tree2.query(attractors, k=1)
        attractors = attractors[d2 > params.kill_radius]

    rs.finalize(params.tip_radius, params.pipe_exponent, params.radius_gain)
    return rs
