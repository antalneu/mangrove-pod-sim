"""
montecarlo.py
=============
Run many randomized root-growth simulations for one perforation pattern and
aggregate the statistics that matter for a break-away pod design:

    - mean / spread of first-crack and breakthrough time
    - reliability (what fraction of runs actually break within the window)
    - which break site activates first, and how often (consistency)
    - the typical activation order
    - an averaged cumulative-stress field (for a representative heatmap)

Also `compare_patterns` runs the same Monte-Carlo batch over several patterns so
you can see which perforation layout breaks earliest and most consistently.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from collections import Counter
from typing import List, Dict, Optional

import numpy as np

from . import growth
from .growth import GrowthParams
from .perforation import PerforationPattern
from .pressure import WallModel, SimParams, run_simulation


@dataclass
class MCResult:
    pattern_name: str
    n_runs: int
    site_labels: List[str]
    first_crack: np.ndarray            # per run (may be inf)
    breakthrough: np.ndarray           # per run (may be inf)
    first_site: List[int]              # per run first-activating site (-1 none)
    activation_orders: List[List[int]]
    mean_cum_stress_faces: np.ndarray  # averaged full per-face field
    site_activation_steps: np.ndarray  # [n_runs, n_sites]

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
        return "\n".join(lines)


def run_montecarlo(pod, pattern: PerforationPattern, n_runs=40,
                   gparams: Optional[GrowthParams] = None,
                   sparams: Optional[SimParams] = None,
                   base_seed=0, growth_jitter_scale=0.0, verbose=False) -> MCResult:
    """Monte-Carlo over randomized growth (each run a different RNG seed).

    growth_jitter_scale > 0 also perturbs a couple of growth parameters run to
    run, to represent biological variability beyond the growth RNG.
    """
    gparams = gparams or GrowthParams()
    sparams = sparams or SimParams()
    wm = WallModel(pod, pattern.build_fields(pod))

    n_sites = wm.n_sites
    first_crack = np.full(n_runs, np.inf)
    breakthrough = np.full(n_runs, np.inf)
    first_site = [-1] * n_runs
    orders = []
    act_steps = np.full((n_runs, n_sites), np.inf)
    cum_accum = np.zeros(len(pod.F))

    rng = np.random.default_rng(base_seed)
    for k in range(n_runs):
        gp = gparams
        if growth_jitter_scale > 0:
            gp = GrowthParams(**{**gparams.__dict__})
            gp.slot_bias = max(0.2, gparams.slot_bias * (1 + growth_jitter_scale *
                                                         rng.normal(0, 0.3)))
            gp.down_bias = float(np.clip(gparams.down_bias *
                                 (1 + growth_jitter_scale * rng.normal(0, 0.3)), 0.1, 1.0))
        rs = growth.grow(pod, gp, seed=base_seed * 1000 + k)
        res = run_simulation(pod, wm, rs, sparams)
        first_crack[k] = res.first_crack_step
        breakthrough[k] = res.breakthrough_step
        first_site[k] = res.first_crack_site
        orders.append(list(res.activation_order))
        act_steps[k] = res.site_activation_step
        cum_accum += res.cum_stress_faces()
        if verbose:
            print(f"  run {k:3d}: first-crack {res.first_crack_step}"
                  f"  breakthrough {res.breakthrough_step}"
                  f"  order {[wm.labels[s] for s in res.activation_order]}")

    return MCResult(
        pattern_name=pattern.name,
        n_runs=n_runs,
        site_labels=wm.labels,
        first_crack=first_crack,
        breakthrough=breakthrough,
        first_site=first_site,
        activation_orders=orders,
        mean_cum_stress_faces=cum_accum / n_runs,
        site_activation_steps=act_steps,
    )


def compare_patterns(pod, patterns: List[PerforationPattern], n_runs=30,
                     gparams=None, sparams=None, verbose=True) -> Dict[str, MCResult]:
    results = {}
    for p in patterns:
        if verbose:
            print(f"[compare] {p.name} ...")
        results[p.name] = run_montecarlo(pod, p, n_runs=n_runs,
                                         gparams=gparams, sparams=sparams)
    return results
