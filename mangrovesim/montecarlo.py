"""
montecarlo.py
=============
Run many randomized root-growth simulations for one perforation pattern and
aggregate the statistics that matter for a break-away pod design:

    - mean / spread of first-crack and breakthrough time
    - reliability (what fraction of runs actually break within the window)
    - which break site activates first, and how often (consistency)
    - the typical activation order
    - an averaged wall-stress field in MPa (for a representative heatmap)

Every run resamples the uncertainties that actually matter: the root
architecture, the material fracture strength across its PUBLISHED range
(triangular), the root growth pressure across its 0.5-1.0 MPa working range
(skipped when Calibration Mode supplies a measured value), and a wall-thickness
moulding tolerance. "Reliability" is therefore a real probability of release, not
an artefact of one deterministic run.

Also `compare_patterns` runs the same Monte-Carlo batch over several patterns so
you can see which perforation layout breaks earliest and most consistently.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from collections import Counter
from typing import List, Dict, Optional

import numpy as np

from . import growth, proproots, hypocotyl
from .growth import GrowthParams
from .perforation import PerforationPattern
from .pressure import (WallModel, SimParams, run_simulation,
                       governing_seam_stress)


def _triangular(rng, lo, mode, hi):
    """Triangular draw from a published (min, best-estimate, max) — the standard
    choice when a range and a nominal are all the literature gives you."""
    lo, hi = min(lo, mode), max(hi, mode)
    if hi - lo < 1e-9:
        return mode
    return float(rng.triangular(lo, mode, hi))


@dataclass
class MCResult:
    pattern_name: str
    n_runs: int
    site_labels: List[str]
    first_crack: np.ndarray            # per run (may be inf)
    breakthrough: np.ndarray           # per run (may be inf)
    first_site: List[int]              # per run first-activating site (-1 none)
    activation_orders: List[List[int]]
    mean_stress_faces: np.ndarray      # averaged full per-face wall stress, MPa
    site_activation_steps: np.ndarray  # [n_runs, n_sites]
    seam_stress: np.ndarray            # governing seam stress per run, MPa
    safety_factor: np.ndarray          # remaining strength / seam stress, per run
    sampled_strength: np.ndarray       # sigma_f drawn per run, MPa
    sampled_pressure: np.ndarray       # root pressure drawn per run, MPa

    # ---- summary helpers ----
    def reliability(self):
        return float(np.mean(np.isfinite(self.breakthrough)))

    def mean_breakthrough(self):
        v = self.breakthrough[np.isfinite(self.breakthrough)]
        return float(v.mean()) if len(v) else float("inf")

    def std_breakthrough(self):
        v = self.breakthrough[np.isfinite(self.breakthrough)]
        return float(v.std()) if len(v) else float("nan")

    def mean_first_crack(self):
        v = self.first_crack[np.isfinite(self.first_crack)]
        return float(v.mean()) if len(v) else float("inf")

    def first_site_counts(self):
        c = Counter(s for s in self.first_site if s >= 0)
        return {self.site_labels[k]: v for k, v in c.most_common()}

    def site_activation_rate(self):
        rate = np.mean(np.isfinite(self.site_activation_steps), axis=0)
        return {self.site_labels[i]: float(rate[i]) for i in range(len(self.site_labels))}

    def mean_site_activation_step(self):
        out = {}
        for i, lab in enumerate(self.site_labels):
            col = self.site_activation_steps[:, i]
            col = col[np.isfinite(col)]
            out[lab] = float(col.mean()) if len(col) else float("inf")
        return out

    def summary(self):
        lines = [f"Pattern: {self.pattern_name}   (runs={self.n_runs})"]
        lines.append(f"  reliability (broke within window): {self.reliability()*100:.0f}%")
        lines.append(f"  first-crack step : mean {self.mean_first_crack():.1f}")
        lines.append(f"  breakthrough step: mean {self.mean_breakthrough():.1f}"
                     f"  std {self.std_breakthrough():.1f}")
        fs = self.first_site_counts()
        lines.append("  first site to crack (count): "
                     + ", ".join(f"{k}={v}" for k, v in fs.items()))
        lines.append("  per-site activation rate: "
                     + ", ".join(f"{k}={v*100:.0f}%"
                                 for k, v in self.site_activation_rate().items()))
        lines.append(f"  governing seam stress: mean {self.seam_stress.mean():.2f} MPa"
                     f"  (range {self.seam_stress.min():.2f}-{self.seam_stress.max():.2f})")
        lines.append(f"  sampled strength : {self.sampled_strength.min():.1f}"
                     f"-{self.sampled_strength.max():.1f} MPa"
                     f"   root pressure: {self.sampled_pressure.min():.2f}"
                     f"-{self.sampled_pressure.max():.2f} MPa")
        return "\n".join(lines)


def run_montecarlo(pod, pattern: PerforationPattern, n_runs=40,
                   gparams: Optional[GrowthParams] = None,
                   sparams: Optional[SimParams] = None,
                   base_seed=0, growth_jitter_scale=0.0, verbose=False,
                   phys=None) -> MCResult:
    """Monte-Carlo over randomized growth (each run a different RNG seed).

    growth_jitter_scale > 0 also perturbs a couple of growth parameters run to
    run, to represent biological variability beyond the growth RNG.
    """
    gparams = gparams or GrowthParams()
    sparams = sparams or SimParams()
    if phys is None:
        from .physical import PhysicalContext
        phys = PhysicalContext.default()
    wm = WallModel(pod, pattern.build_fields(pod))

    n_sites = wm.n_sites
    first_crack = np.full(n_runs, np.inf)
    breakthrough = np.full(n_runs, np.inf)
    first_site = [-1] * n_runs
    orders = []
    act_steps = np.full((n_runs, n_sites), np.inf)
    stress_accum = np.zeros(len(pod.F))
    seam_stress = np.zeros(n_runs)
    safety = np.zeros(n_runs)
    drawn_strength = np.zeros(n_runs)
    drawn_pressure = np.zeros(n_runs)

    mat = phys.material
    lo, hi = getattr(mat, "fracture_range_mpa",
                     (mat.fracture_strength_mpa, mat.fracture_strength_mpa))

    rng = np.random.default_rng(base_seed)
    for k in range(n_runs):
        gp = gparams
        if growth_jitter_scale > 0:
            gp = GrowthParams(**{**gparams.__dict__})
            gp.slot_bias = max(0.2, gparams.slot_bias * (1 + growth_jitter_scale *
                                                         rng.normal(0, 0.3)))
            gp.down_bias = float(np.clip(gparams.down_bias *
                                 (1 + growth_jitter_scale * rng.normal(0, 0.3)), 0.1, 1.0))
        # physical uncertainty for this draw
        ph = replace(phys,
                     sigma_f_mpa=_triangular(rng, lo, mat.fracture_strength_mpa, hi),
                     thickness_factor=float(np.clip(1 + 0.05 * rng.normal(), 0.85, 1.15)))
        if not phys.calibration_active:
            ph.root_pressure_mpa = _triangular(rng, 0.5, phys.root_pressure_mpa, 1.0)
        drawn_strength[k] = ph.sigma_f_mpa
        drawn_pressure[k] = ph.root_pressure_mpa

        # Load source: the propagule's HYPOCOTYL thickening in the bore. At the
        # pod's true scale (197 mm, 25.6 mm bore) a 20-36 mm propagule is an
        # interference fit from planting, so the stem - not the roots, which
        # leave through the open base - is what loads the wall. Propagule
        # diameter is resampled across the species range, since that is what
        # decides when contact starts.
        hp = hypocotyl.HypocotylParams(
            initial_diameter_mm=float(np.clip(rng.normal(24.0, 3.5), 18.0, 34.0)))
        rs = hypocotyl.grow_hypocotyl(
            pod, hp, window_months=(phys.window_months or phys.species.window_months))
        res = run_simulation(pod, wm, rs, sparams, phys=ph)
        first_crack[k] = res.first_crack_step
        breakthrough[k] = res.breakthrough_step
        first_site[k] = res.first_crack_site
        orders.append(list(res.activation_order))
        act_steps[k] = res.site_activation_step
        stress_accum += res.stress_faces()
        # same metric the single-run report quotes, so the two agree
        gov = governing_seam_stress(wm, res, sparams)
        seam_stress[k] = gov
        safety[k] = res.sigma_f_end_mpa / gov if gov > 0 else np.inf
        if verbose:
            print(f"  run {k:3d}: first-crack {res.first_crack_step}"
                  f"  breakthrough {res.breakthrough_step}"
                  f"  seam {gov:.2f} MPa"
                  f"  order {[wm.labels[s] for s in res.activation_order]}")

    return MCResult(
        pattern_name=pattern.name,
        n_runs=n_runs,
        site_labels=wm.labels,
        first_crack=first_crack,
        breakthrough=breakthrough,
        first_site=first_site,
        activation_orders=orders,
        mean_stress_faces=stress_accum / n_runs,
        site_activation_steps=act_steps,
        seam_stress=seam_stress,
        safety_factor=safety,
        sampled_strength=drawn_strength,
        sampled_pressure=drawn_pressure,
    )


def compare_patterns(pod, patterns: List[PerforationPattern], n_runs=30,
                     gparams=None, sparams=None, verbose=True, phys=None) -> Dict[str, MCResult]:
    results = {}
    for p in patterns:
        if verbose:
            print(f"[compare] {p.name} ...")
        results[p.name] = run_montecarlo(pod, p, n_runs=n_runs,
                                         gparams=gparams, sparams=sparams, phys=phys)
    return results
