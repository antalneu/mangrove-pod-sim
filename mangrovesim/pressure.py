"""
pressure.py
===========
Turn a grown root system into time-resolved pressure on the pod's inner wall,
accumulate stress, and decide when each perforation "break site" tears through.

Model (reduced-order, not FEA - a transparent engineering surrogate)
--------------------------------------------------------------------
Over `n_time_steps` the root network *inflates*: every node was born at a growth
step; as it ages its radius grows toward its pipe-model value and then keeps
swelling. At each step a node whose swollen body reaches the inner wall exerts a
radial contact pressure

    pressure_node = contact_stiffness * penetration
    penetration   = (r_node + radius_node) - r_inner(z_node)      [>0 only]

plus, in the conical base, a wedging term (the root ball splaying the feet). Each
node's pressure lands on the nearest inner-wall face. Per face we track the
instantaneous pressure and the time-integral (cumulative stress ~ fatigue/creep).

Failure. Every face has a capacity `strength` and a concentration factor `scf`
from the perforation pattern (perforation.py). A break site (a slot->foot
ligament or a base split-line) *activates* when the stress driving it exceeds its
summed capacity:

    drive_site(t)  = sum_faces( cumulative_stress * scf )
    activate when  drive_site >= capacity_site = sum_faces( strength )

"First crack" = first site to activate. "Breakthrough" = when a configurable
fraction of the slot->foot ligaments have activated (the pod can split into
petals / fall away). A `pull_assist` term adds a steady external stress to model
a planting team pulling the pod apart.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np
from scipy.spatial import cKDTree

from .perforation import WallFields


@dataclass
class SimParams:
    n_time_steps: int = 120
    growth_fraction: float = 0.6      # roots finish appearing after this frac of time
    maturation: float = 30.0          # steps for a root to reach full pipe radius
    swell_rate: float = 0.012         # continued girth swelling per step after maturity
    max_swell: float = 2.6            # cap on swelling multiplier
    contact_stiffness: float = 20.0   # pressure per unit radial penetration
    base_wedge: float = 0.6           # extra outward push from the base root ball
    contact_patch_factor: float = 1.6  # wall contact radius as multiple of root girth
    min_patch_radius: float = 7.0     # floor on the contact-patch radius
    dt: float = 1.0
    span_frac: float = 0.6            # frac of ligament z-bands cracked -> it tears
    hoop_factor: float = 0.9          # feet-splaying tension delivered to split-lines
    breakthrough_frac: float = 0.75   # frac of slot->foot ligaments that must tear
    pull_assist: float = 0.0          # steady external stress (planting-team pull)


class WallModel:
    """Precomputed inner-wall bookkeeping for a (pod, perforation) pair.
    Reusable across many randomized growth runs."""

    def __init__(self, pod, wall: WallFields):
        self.pod = pod
        self.wall = wall
        self.inner_idx = np.where(pod.inner_mask)[0]
        self.Cin = pod.face_centers[self.inner_idx]
        self.tree = cKDTree(self.Cin)
        self.strength_in = wall.strength[self.inner_idx]
        self.scf_in = wall.scf[self.inner_idx]
        self.z_in = pod.z_face[self.inner_idx]
        self.r_in = pod.r_face[self.inner_idx]
        lig = wall.ligament[self.inner_idx]
        split = wall.split_site[self.inner_idx]
        self.n_slots = wall.n_slots
        self.n_splits = wall.n_splits
        self.n_sites = wall.n_slots + wall.n_splits
        self.labels = wall.site_labels()
        # face membership per break site (list of local inner-face indices)
        self.site_faces = []
        self.is_ligament = []
        for si in range(wall.n_slots):
            self.site_faces.append(np.where(lig == si)[0])
            self.is_ligament.append(True)
        for spi in range(wall.n_splits):
            self.site_faces.append(np.where(split == spi)[0])
            self.is_ligament.append(False)
        self.is_ligament = np.array(self.is_ligament)

        # For ligaments: bin faces into constant-height z-bands. A ligament tears
        # only when a crack SPANS the bridge (a failed face in ~every band), so a
        # taller bridge (shorter slot) is genuinely harder to sever than a short
        # one (longer slot). Band count therefore encodes slot length.
        band_h = 12.0
        self.site_band = [None] * self.n_sites
        self.site_nbands = np.ones(self.n_sites, int)
        for si in range(self.n_sites):
            fs = self.site_faces[si]
            if not self.is_ligament[si] or len(fs) == 0:
                continue
            zf = self.z_in[fs]
            zlo, zhi = zf.min(), zf.max()
            K = max(3, int(round((zhi - zlo) / band_h)))
            b = np.clip(((zf - zlo) / max(zhi - zlo, 1e-6) * K).astype(int), 0, K - 1)
            self.site_band[si] = b
            self.site_nbands[si] = K

        # For split-lines: capacity = summed strength of the (possibly scored)
        # split faces; driven by feet-splaying hoop tension (see run_simulation).
        self.split_capacity = np.full(self.n_sites, np.inf)
        for si in range(self.n_sites):
            if self.is_ligament[si]:
                continue
            fs = self.site_faces[si]
            if len(fs):
                cap = np.sum(np.where(np.isfinite(self.strength_in[fs]),
                                      self.strength_in[fs], 0.0))
                self.split_capacity[si] = cap if cap > 0 else np.inf

    def map_nodes(self, positions):
        _, loc = self.tree.query(positions, k=1)
        return loc


@dataclass
class SimResult:
    cum_stress_in: np.ndarray            # cumulative stress per inner face
    peak_pressure_in: np.ndarray
    inner_idx: np.ndarray
    n_faces: int
    site_labels: List[str]
    site_activation_step: np.ndarray     # step each site activated (inf if never)
    site_ratio_history: np.ndarray       # [n_steps, n_sites] drive/capacity
    first_crack_step: float
    first_crack_site: int
    breakthrough_step: float
    activation_order: List[int]
    roots: object = None

    def cum_stress_faces(self):
        """Scatter inner-face cumulative stress back to a full per-face array."""
        v = np.zeros(self.n_faces)
        v[self.inner_idx] = self.cum_stress_in
        return v

    def peak_pressure_faces(self):
        v = np.zeros(self.n_faces)
        v[self.inner_idx] = self.peak_pressure_in
        return v


def _node_radius(pipe_r, age, sp: SimParams):
    """Radius of a root node of given pipe radius at a given age (in steps)."""
    mature = np.clip(age / sp.maturation, 0.05, 1.0)
    swell = np.clip(1.0 + sp.swell_rate * np.maximum(age - sp.maturation, 0.0),
                    1.0, sp.max_swell)
    return pipe_r * mature * swell


def run_simulation(pod, wallmodel: WallModel, roots, sparams: Optional[SimParams] = None,
                   phys=None):
    """Run the time-stepped pressure/failure simulation.

    `phys` (optional physical.PhysicalContext) applies *relative* per-step
    multipliers derived from the chosen material/species/root-pressure:
        drive    scales the applied wall pressure (root pressure x growth ramp)
        capacity scales the wall strength (material strength x wet degradation)
    With phys=None both default to 1.0 and the engine behaves exactly as before.
    """
    sp = sparams or SimParams()
    wm = wallmodel
    T = sp.n_time_steps

    if phys is not None:
        drive_mult, cap_mult, _months = phys.per_step(T)
    else:
        drive_mult = np.ones(T)
        cap_mult = np.ones(T)

    P = roots.positions()
    pipe = roots.radius
    birth = roots.birth_arr.astype(float)
    # map growth steps onto the first `growth_fraction` of the time axis
    max_birth = max(birth.max(), 1.0)
    birth_time = birth / max_birth * (sp.growth_fraction * T)

    r_node = np.hypot(P[:, 0], P[:, 1])
    r_inner_here = pod.r_inner_at(P[:, 2])
    z_base = pod.features.z_base_top
    base_node = P[:, 2] < z_base * 1.25

    # precompute each node's wall contact patch (the faces its swollen body
    # touches) as a sparse node->face weight matrix, so pressure spreads over an
    # area instead of a single face.
    import scipy.sparse as spr
    patch_r = np.maximum(sp.contact_patch_factor * pipe, sp.min_patch_radius)
    patches = wm.tree.query_ball_point(P, patch_r)
    rows, cols, data = [], [], []
    for j, fs in enumerate(patches):
        if len(fs) == 0:
            fs = [int(wm.tree.query(P[j], k=1)[1])]
        d = np.linalg.norm(wm.Cin[fs] - P[j], axis=1)
        w = np.maximum(1.0 - d / max(patch_r[j], 1e-6), 0.05)
        w = w / w.sum()
        rows.extend(fs)
        cols.extend([j] * len(fs))
        data.extend(w.tolist())
    n_in = len(wm.inner_idx)
    M = spr.csr_matrix((data, (rows, cols)), shape=(n_in, len(P)))

    cum = np.zeros(n_in)
    peak = np.zeros(n_in)
    ratio_hist = np.zeros((T, wm.n_sites))
    activation_step = np.full(wm.n_sites, np.inf)
    activation_order = []
    base_wedge_cum = 0.0

    n_lig = wm.n_slots
    breakthrough_needed = max(1, int(np.ceil(n_lig * sp.breakthrough_frac)))
    breakthrough_step = np.inf

    for t in range(1, T + 1):
        alive = birth_time <= t
        if not np.any(alive):
            ratio_hist[t - 1] = 0
            continue
        age = t - birth_time
        rad = _node_radius(pipe, age, sp)
        # radial penetration of the swollen root into the wall
        pen = (r_node + rad) - r_inner_here
        radial_press = sp.contact_stiffness * np.maximum(pen, 0.0)
        # base wedging: root ball splaying the conical base / feet
        wedge = np.where(base_node, sp.base_wedge * rad, 0.0)
        # per-step drive multiplier: root pressure (MPa/reference) x growth ramp
        dmult = drive_mult[t - 1]
        press_node = np.where(alive, radial_press + wedge, 0.0) * dmult
        # spread each node's pressure over its wall contact patch
        step_press = M.dot(press_node)
        # optional external pull assist (planting team) on the upper wall
        if sp.pull_assist > 0:
            step_press = step_press + sp.pull_assist * (wm.z_in < pod.features.z_waist_hi)

        peak = np.maximum(peak, step_press)
        cum += step_press * sp.dt
        # cumulative feet-splaying wedge load -> hoop tension at the split-lines
        base_wedge_cum += float(np.where(alive, wedge, 0.0).sum()) * dmult * sp.dt

        # per-step capacity multiplier: material strength x wet/tidal degradation
        cmult = cap_mult[t - 1]
        eff_strength = wm.strength_in * cmult
        # per-face failure: local stress (x concentration) exceeds local capacity.
        face_failed = (cum * wm.scf_in) >= eff_strength
        for si in range(wm.n_sites):
            fs = wm.site_faces[si]
            if len(fs) == 0:
                continue
            if wm.is_ligament[si]:
                # crack must span the bridge: a failed face in a fraction of bands
                bands = wm.site_band[si]
                failed_bands = np.unique(bands[face_failed[fs]])
                ratio = len(failed_bands) / wm.site_nbands[si]
            else:
                # split-line: feet-splaying hoop tension vs (scored, degraded) capacity
                ratio = (sp.hoop_factor * base_wedge_cum) / (wm.split_capacity[si] * cmult)
            ratio_hist[t - 1, si] = ratio
            thresh = sp.span_frac if wm.is_ligament[si] else 1.0
            if ratio >= thresh and not np.isfinite(activation_step[si]):
                activation_step[si] = t
                activation_order.append(si)
        # breakthrough when enough slot->foot ligaments have torn
        n_lig_active = np.sum(np.isfinite(activation_step[:n_lig]))
        if n_lig_active >= breakthrough_needed and not np.isfinite(breakthrough_step):
            breakthrough_step = t

    finite = np.isfinite(activation_step)
    if finite.any():
        first_site = int(np.argmin(np.where(finite, activation_step, np.inf)))
        first_step = float(activation_step[first_site])
    else:
        first_site, first_step = -1, np.inf

    return SimResult(
        cum_stress_in=cum,
        peak_pressure_in=peak,
        inner_idx=wm.inner_idx,
        n_faces=len(pod.F),
        site_labels=wm.labels,
        site_activation_step=activation_step,
        site_ratio_history=ratio_hist,
        first_crack_step=first_step,
        first_crack_site=first_site,
        breakthrough_step=float(breakthrough_step),
        activation_order=activation_order,
        roots=roots,
    )
