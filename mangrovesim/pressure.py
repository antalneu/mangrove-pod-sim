"""
pressure.py
===========
Turn a grown root system into a time-resolved **wall stress in real MPa**, and
decide when each perforation "break site" tears through.

This is the shell-mechanics model (v2) — the same model the browser engine in
`docs/static/engine.js` runs, so the offline renders and the website agree.

The physical scale
------------------
The Rhino model is authored in MILLIMETRES (see provenance.MM_PER_UNIT): the pod
is 334 mm tall around a ~26 mm bore with a ~21 mm wall. Every pressure and stress
below is therefore a real MPa (N/mm^2), not a surrogate unit.

Pressure — turgor-bounded
-------------------------
Over `n_time_steps` the root network inflates: every node was born at a growth
step; as it ages its radius grows toward its pipe-model value and then keeps
swelling. Radial indentation into the bore is

    delta = (r_node + radius_node) - r_inner(z_node)          [>0 only]

but a root's bearing pressure *saturates* at its turgor-limited growth pressure:

    p_node = p_root * (1 - exp(-delta / delta0))

However far a root swells it can never bear harder than ~1 MPa. `delta0` comes
from the contact-stiffness control (provenance.contact_ref_mm). In the conical
base a wedging term (the root ball splaying the feet) scales this up.

Stress — hoop + plate bending on the net section
------------------------------------------------
Each node's pressure lands on the wall patch its swollen body touches (a sparse
node->face matrix; the kernel is a spatial falloff and is deliberately NOT
normalised — pressure is not divided between the faces a root bears on, it acts
across all of them). Per inner face,

    sigma = SCF * p * [ r_bore / t_eff  +  PLATE_BETA * (span / t_eff)^2 ]
                       ^ membrane hoop     ^ transverse plate bending

with `t_eff`, `span` and `r_bore` the net scored section from perforation.py.

Failure — brittle overload + static fatigue
-------------------------------------------
Two paths, both against the material's *remaining* strength sigma_f(t) (which
decays with wet degradation over the real elapsed months):

    brittle   sigma >= sigma_f                       -> that face cracks now
    fatigue   damage += (sigma/sigma_f)^n * dt / T_REF_MONTHS

so a wall held just under strength still fails eventually and one held well under
it never does. `n` is the material's fatigue_exponent.

Once a fraction phi of a site's z-bands have cracked, the survivors carry the
whole section, so the stress driving further DAMAGE is amplified by 1/(1-phi)
(floored at NET_SECTION_FLOOR). That is what makes a crack initiate at the
slot-tip hot spot and then RUN across the ligament rather than stalling. The
reported/heatmap stress stays the nominal demand on the intact section.

Break sites
-----------
Every site — slot->foot ligament AND base split-line — is banded up its height
and fails by the same physical rule: a crack has to *span* `span_frac` of the
bands, not just nick the section somewhere. "First crack" is the first site to
tear; "breakthrough" is when `breakthrough_frac` of the slot ligaments have torn
(the point the pod can split into petals / fall away). `pull_assist` adds a
steady bearing pressure below the waist to model a planting team helping it open.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import numpy as np
from scipy.spatial import cKDTree

from .perforation import WallFields, _sstep
from .provenance import (MM_PER_UNIT, PLATE_BETA, T_REF_MONTHS, MIN_T_EFF_MM,
                         NET_SECTION_FLOOR, contact_ref_mm)


@dataclass
class SimParams:
    n_time_steps: int = 120
    growth_fraction: float = 0.6      # roots finish appearing after this frac of time
    maturation: float = 30.0          # steps for a root to reach full pipe radius
    swell_rate: float = 0.012         # continued girth swelling per step after maturity
    max_swell: float = 2.6            # cap on swelling multiplier
    contact_stiffness: float = 20.0   # sets delta0, the indentation for full bearing
    base_wedge: float = 0.6           # extra outward push from the base root ball
    contact_patch_factor: float = 1.6  # wall contact radius as multiple of root girth
    min_patch_radius: float = 7.0     # floor on the contact-patch radius
    dt: float = 1.0
    span_frac: float = 0.6            # frac of a site's z-bands cracked -> it tears
    breakthrough_frac: float = 0.75   # frac of slot->foot ligaments that must tear
    pull_assist: float = 0.0          # steady external bearing pressure, MPa


class WallModel:
    """Precomputed inner-wall bookkeeping for a (pod, perforation) pair.
    Reusable across many randomized growth runs."""

    def __init__(self, pod, wall: WallFields):
        self.pod = pod
        self.wall = wall
        self.inner_idx = np.where(pod.inner_mask)[0]
        self.Cin = pod.face_centers[self.inner_idx]
        self.tree = cKDTree(self.Cin)
        self.scf_in = wall.scf[self.inner_idx]
        self.t_in = wall.t_eff[self.inner_idx]          # net section, mm
        self.span_in = wall.span[self.inner_idx]        # bending span, mm
        self.rb_in = wall.r_bore[self.inner_idx]        # bore radius, mm
        self.open_in = wall.open_frac[self.inner_idx]
        self.score_in = wall.weaken[self.inner_idx]
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

        # Every site (slot ligament AND base split) is banded up its height, so
        # both fail by the same physical rule: a crack has to run across the
        # section, not just nick it somewhere. Band count encodes site height, so
        # a taller bridge (shorter slot) is genuinely harder to sever.
        band_h = 12.0
        self.site_band = [None] * self.n_sites
        self.site_nbands = np.ones(self.n_sites, int)
        for si in range(self.n_sites):
            fs = self.site_faces[si]
            if len(fs) == 0:
                continue
            zf = self.z_in[fs]
            zlo, zhi = zf.min(), zf.max()
            K = max(3, int(round((zhi - zlo) / band_h)))
            b = np.clip(((zf - zlo) / max(zhi - zlo, 1e-6) * K).astype(int), 0, K - 1)
            self.site_band[si] = b
            self.site_nbands[si] = K

        # reverse index: which site (if any) each inner face belongs to, so the
        # net-section amplification can be looked up per face in the time loop
        self.face_site = np.full(len(self.inner_idx), -1, int)
        for si in range(self.n_sites):
            self.face_site[self.site_faces[si]] = si

    def map_nodes(self, positions):
        _, loc = self.tree.query(positions, k=1)
        return loc

    def wall_stress(self, p, amp=1.0, thickness_factor=1.0):
        """Wall stress (MPa) per inner face under bearing pressure `p` (MPa):
        membrane hoop on the net section + transverse plate bending over its
        reacting span, amplified by the local stress-concentration factor and by
        `amp` (net-section loss where part of the site has already cracked).
        `thickness_factor` is a moulding tolerance (1 = nominal)."""
        te = np.maximum(self.t_in * thickness_factor, MIN_T_EFF_MM)
        sl = self.span_in / te
        s = self.scf_in * amp * p * (self.rb_in / te + PLATE_BETA * sl * sl)
        return np.where((p > 0) & (self.open_in <= 0.5), s, 0.0)


@dataclass
class SimResult:
    stress_in: np.ndarray                # wall stress per inner face, MPa (final step)
    stress_peak_in: np.ndarray           # peak wall stress ever seen, MPa
    peak_pressure_in: np.ndarray         # peak bearing pressure, MPa
    inner_idx: np.ndarray
    n_faces: int
    site_labels: List[str]
    site_activation_step: np.ndarray     # step each site activated (inf if never)
    site_phi_history: np.ndarray         # [n_steps, n_sites] cracked-band fraction
    first_crack_step: float
    first_crack_site: int
    breakthrough_step: float
    activation_order: List[int]
    # per-step traces, in real units
    stress_series: np.ndarray            # governing seam stress per step, MPa
    strength_series: np.ndarray          # remaining fracture strength per step, MPa
    months: np.ndarray                   # real elapsed months per step
    seam_peak_mpa: float                 # worst stress anywhere on a release seam
    sigma_f_end_mpa: float               # remaining strength at the end of the window
    utilisation: float                   # seam_peak / sigma_f_end
    roots: object = None

    def stress_faces(self):
        """Scatter inner-face wall stress (MPa) back to a full per-face array."""
        v = np.zeros(self.n_faces)
        v[self.inner_idx] = self.stress_in
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
    """Run the time-stepped stress/failure simulation.

    `phys` (a physical.PhysicalContext) supplies the absolute per-step drive
    (MPa of available root bearing pressure) and capacity (MPa of remaining
    fracture strength after wet degradation), plus the real elapsed months each
    step lands on. Without one, a default PHA / Rhizophora context is used, since
    the model has no meaningful dimensionless mode.
    """
    sp = sparams or SimParams()
    wm = wallmodel
    T = sp.n_time_steps

    if phys is None:
        from .physical import PhysicalContext
        phys = PhysicalContext.default()
    drive, cap, months = phys.per_step(T)
    n_exp = phys.fatigue_n
    tf = phys.thickness_factor

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
    wedge_mult = np.where(base_node, 1.0 + sp.base_wedge, 1.0)

    # Contact kernel: each node's wall contact patch (the faces its swollen body
    # touches) as a sparse node->face weight matrix. A spatial falloff, NOT
    # normalised to 1 — pressure is not divided between the faces a root bears
    # on, it acts across all of them.
    import scipy.sparse as spr
    patch_r = np.maximum(sp.contact_patch_factor * pipe, sp.min_patch_radius)
    patches = wm.tree.query_ball_point(P, patch_r)
    rows, cols, data = [], [], []
    for j, fs in enumerate(patches):
        if len(fs) == 0:
            fs = [int(wm.tree.query(P[j], k=1)[1])]
        d = np.linalg.norm(wm.Cin[fs] - P[j], axis=1)
        w = np.clip(1.0 - d / max(patch_r[j], 1e-6), 0.05, 1.0)
        rows.extend(fs)
        cols.extend([j] * len(fs))
        data.extend(w.tolist())
    n_in = len(wm.inner_idx)
    M = spr.csr_matrix((data, (rows, cols)), shape=(n_in, len(P)))

    delta0 = contact_ref_mm(sp.contact_stiffness)   # mm of indentation for full bearing
    pull_mpa = max(sp.pull_assist, 0.0)             # planting-team assist, MPa
    below_waist = wm.z_in < pod.features.z_waist_hi

    sigma = np.zeros(n_in)
    sigma_peak = np.zeros(n_in)
    p_peak = np.zeros(n_in)
    dmg = np.zeros(n_in)
    site_phi = np.zeros(wm.n_sites)
    phi_hist = np.zeros((T, wm.n_sites))
    band_failed = [np.zeros(wm.site_nbands[si], bool) for si in range(wm.n_sites)]
    activation_step = np.full(wm.n_sites, np.inf)
    activation_order = []
    # per-step traces for the results panel: the seam stress that governs release
    # and the remaining strength it is racing against, both in MPa
    stress_series = np.zeros(T)
    strength_series = np.zeros(T)

    n_lig = wm.n_slots
    breakthrough_needed = max(1, int(np.ceil(n_lig * sp.breakthrough_frac)))
    breakthrough_step = np.inf

    for t in range(1, T + 1):
        p_max = drive[t - 1]
        sig_f = cap[t - 1]
        d_months = max(months[t - 1] - (months[t - 2] if t > 1 else 0.0), 0.0)

        # --- 1. bearing pressure per root node (MPa, turgor-bounded) ---
        age = t - birth_time
        rad = _node_radius(pipe, age, sp)
        pen = (r_node + rad) - r_inner_here
        # engagement saturates: once the root has indented the bore by a few
        # delta0 it is bearing at its full growth pressure and can push no harder
        engage = 1.0 - np.exp(-np.maximum(pen, 0.0) * MM_PER_UNIT / delta0)
        press_node = np.where((birth_time <= t) & (pen > 0),
                              p_max * engage * wedge_mult, 0.0)

        # --- 2. face pressure -> stress -> damage ---
        p_face = M.dot(press_node)
        if pull_mpa > 0:
            p_face = p_face + pull_mpa * below_waist
        # overlapping roots still cannot exceed turgor
        np.minimum(p_face, p_max + pull_mpa, out=p_face)
        np.maximum(p_peak, p_face, out=p_peak)

        # NOMINAL stress on the intact section — this is the design demand, and
        # what the heatmap and the reported numbers show.
        sigma = wm.wall_stress(p_face, 1.0, tf)
        np.maximum(sigma_peak, sigma, out=sigma_peak)

        # Damage sees the net-section amplification instead: once bands of this
        # site have cracked, the survivors carry the whole section.
        amp = np.ones(n_in)
        has_site = wm.face_site >= 0
        amp[has_site] = 1.0 / np.maximum(1.0 - site_phi[wm.face_site[has_site]],
                                         NET_SECTION_FLOOR)
        s_amp = sigma * amp
        live = (s_amp > 0) & (dmg < 1.0)
        brittle = live & (s_amp >= sig_f)          # brittle overload
        dmg[brittle] = 1.0
        if d_months > 0:                            # subcritical crack growth
            fat = live & ~brittle
            dmg[fat] += (s_amp[fat] / sig_f) ** n_exp * d_months / T_REF_MONTHS
        strength_series[t - 1] = sig_f

        # --- 3. site state: which bands have cracked, and has the site torn? ---
        gov_now = np.inf
        for si in range(wm.n_sites):
            fs = wm.site_faces[si]
            if len(fs) == 0:
                continue
            bands = wm.site_band[si]
            nb = wm.site_nbands[si]
            # the stress that decides this seam: the span_frac-th highest band stress
            if wm.is_ligament[si]:
                band_max = np.zeros(nb)
                np.maximum.at(band_max, bands, sigma[fs])
                order = np.sort(band_max)[::-1]
                gi = int(np.clip(np.ceil(sp.span_frac * nb) - 1, 0, nb - 1))
                gov_now = min(gov_now, order[gi])
            bf = band_failed[si]
            bf[bands[dmg[fs] >= 1.0]] = True
            site_phi[si] = bf.sum() / nb
            if site_phi[si] >= sp.span_frac and not np.isfinite(activation_step[si]):
                activation_step[si] = t
                activation_order.append(si)
        phi_hist[t - 1] = site_phi
        stress_series[t - 1] = gov_now if np.isfinite(gov_now) else sigma.max()

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

    # headline engineering numbers: worst stress anywhere on a release seam, and
    # how much of the material's remaining strength that uses up
    seam_peak = 0.0
    for si in range(wm.n_sites):
        fs = wm.site_faces[si]
        if len(fs):
            seam_peak = max(seam_peak, float(sigma_peak[fs].max()))
    sig_f_end = float(cap[T - 1])

    return SimResult(
        stress_in=sigma,
        stress_peak_in=sigma_peak,
        peak_pressure_in=p_peak,
        inner_idx=wm.inner_idx,
        n_faces=len(pod.F),
        site_labels=wm.labels,
        site_activation_step=activation_step,
        site_phi_history=phi_hist,
        first_crack_step=first_step,
        first_crack_site=first_site,
        breakthrough_step=float(breakthrough_step),
        activation_order=activation_order,
        stress_series=stress_series,
        strength_series=strength_series,
        months=months,
        seam_peak_mpa=seam_peak,
        sigma_f_end_mpa=sig_f_end,
        utilisation=seam_peak / max(sig_f_end, 1e-9),
        roots=roots,
    )


# --------------------------------------------------------------------------- #
#  reporting: the numbers a designer actually acts on
# --------------------------------------------------------------------------- #
def governing_seam_stress(wm: WallModel, res: SimResult, sp: SimParams) -> float:
    """The stress that GOVERNS release, as opposed to the peak at the slot-tip
    stress raiser. A seam only tears once cracking spans `span_frac` of its
    bands, so the deciding stress is the span_frac-th highest band stress — and
    the pod releases on whichever seam reaches that first. This is the number to
    compare against material strength when asking "will it open?"."""
    out = np.inf
    for si in range(wm.n_sites):
        if not wm.is_ligament[si]:
            continue
        fs = wm.site_faces[si]
        if len(fs) == 0:
            continue
        nb = wm.site_nbands[si]
        band_max = np.zeros(nb)
        np.maximum.at(band_max, wm.site_band[si], res.stress_peak_in[fs])
        order = np.sort(band_max)[::-1]
        idx = int(np.clip(np.ceil(sp.span_frac * nb) - 1, 0, nb - 1))
        out = min(out, order[idx])
    return float(out) if np.isfinite(out) else 0.0


def seam_thickness_at(wm: WallModel, score: float):
    """Net wall left at the release seams for a given scoring depth, in mm — the
    number a designer actually has to draw."""
    tot, n = 0.0, 0
    for si in range(wm.n_sites):
        if not wm.is_ligament[si]:
            continue
        fs = wm.site_faces[si]
        if len(fs) == 0:
            continue
        tot += float((wm.t_in[fs] / np.maximum(1.0 - wm.score_in[fs], 0.02)).sum())
        n += len(fs)
    return (tot / n) * (1.0 - score) if n else None


def seam_score_sweep(wm: WallModel, res: SimResult, sp: SimParams, pattern):
    """How deep would the seams have to be scored?

    Stress scales as 1/t for hoop and 1/t^2 for bending, so scoring is by far the
    strongest lever the designer has. Using the bearing pressure the run actually
    delivered to each ligament face, re-evaluate the section analytically for a
    sweep of candidate scoring depths and report the shallowest one at which
    enough seams would tear. Cheap — no extra simulation."""
    sig_f = res.sigma_f_end_mpa
    n_pieces = max(len(pattern.slots), 2)
    sector_rad = 2.0 * np.pi / n_pieces
    sweep = []
    for s in np.round(np.arange(0.0, 0.9501, 0.05), 2):
        torn = 0
        for si in range(wm.n_sites):
            if not wm.is_ligament[si]:
                continue
            fs = wm.site_faces[si]
            if len(fs) == 0:
                continue
            p = res.peak_pressure_in[fs]
            t0 = wm.t_in[fs] / np.maximum(1.0 - wm.score_in[fs], 0.02)  # gross wall
            te = np.maximum(t0 * (1.0 - s), MIN_T_EFF_MM)
            hinge = _sstep(s / 0.6)
            l_shell = np.sqrt(wm.rb_in[fs] * t0)
            l_sector = sector_rad * (wm.rb_in[fs] + 0.5 * t0)
            sl = (l_shell + (l_sector - l_shell) * hinge) / te
            cracked = (p > 0) & (wm.scf_in[fs] * p *
                                 (wm.rb_in[fs] / te + PLATE_BETA * sl * sl) >= sig_f)
            nb = wm.site_nbands[si]
            bf = np.zeros(nb, bool)
            bf[wm.site_band[si][cracked]] = True
            if bf.sum() / nb >= sp.span_frac:
                torn += 1
        sweep.append({"score": float(s), "seams_torn": torn})
    needed = max(1, int(np.ceil(wm.n_slots * sp.breakthrough_frac)))
    hit = next((o for o in sweep if o["seams_torn"] >= needed), None)
    return {"sweep": sweep, "required_score": hit["score"] if hit else None,
            "seams_needed": needed}


def mechanics_summary(res: SimResult, wm: WallModel, phys, pattern,
                      sp: Optional[SimParams] = None) -> dict:
    """Headline engineering numbers, matching the browser tool's results panel."""
    t_all = []
    for si in range(wm.n_sites):
        if wm.is_ligament[si] and len(wm.site_faces[si]):
            t_all.append(wm.t_in[wm.site_faces[si]] * phys.thickness_factor)
    t_all = np.concatenate(t_all) if t_all else np.array([])
    guide = seam_score_sweep(wm, res, sp, pattern) if sp is not None else None
    gov = governing_seam_stress(wm, res, sp) if sp is not None else res.seam_peak_mpa
    sf = res.sigma_f_end_mpa / gov if gov > 0 else np.inf
    req = guide["required_score"] if guide else None
    return {
        "unit_mm": MM_PER_UNIT,
        "seam_stress_mpa": round(gov, 2),               # governs whether the seam tears
        "peak_stress_mpa": round(res.seam_peak_mpa, 2),  # local peak at the slot tip
        "tip_utilisation": round(res.utilisation, 3),
        "strength_start_mpa": round(phys.sigma_f_mpa, 2),
        "strength_end_mpa": round(res.sigma_f_end_mpa, 2),
        "utilisation": round(gov / max(res.sigma_f_end_mpa, 1e-9), 3),
        "safety_factor": round(sf, 2) if np.isfinite(sf) else None,
        "seam_thickness_mm": round(float(t_all.mean()), 2) if len(t_all) else None,
        "seam_thickness_min_mm": round(float(t_all.min()), 2) if len(t_all) else None,
        "seam_score": pattern.seam_score or 0.0,
        "fatigue_n": phys.fatigue_n,
        "required_score": req,
        "required_seam_thickness_mm": (round(seam_thickness_at(wm, req), 2)
                                       if req is not None else None),
        "seams_needed": guide["seams_needed"] if guide else None,
    }
