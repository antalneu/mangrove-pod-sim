"""
hypocotyl.py
============
The propagule's own stem thickening inside the bore — the load path that can
actually open this pod.

Why this, and not the roots
---------------------------
The propagule runs the FULL length of the pod: shoot out of the top opening,
lower tip at the base. Its radicle emerges from that lower tip and fans straight
out into the mud beneath the feet, so the roots barely touch the wall at all —
with a year-one root system the computed seam stress is essentially zero.

What *is* in contact along the whole bore is the hypocotyl itself. As the
seedling establishes, the stem thickens (secondary growth), and where its radius
exceeds the local bore radius it bears outward on the wall. That is the
mechanism the pod is really designed around: the plant grows into its container.

Why the mechanics are different from root contact
-------------------------------------------------
A root bears on a patch a few millimetres across, which is why the plate-bending
term had to be capped at the loaded width. The hypocotyl does the opposite: it
presses on the **entire circumference over a long axial band**, which is exactly
the uniform-pressure case `beta*(L/t)^2` is derived for. So here the full hinged
sector width is the correct bending span, and the load is a genuine
pressure-vessel action rather than a point poke.

Timing
------
The project's measured propagule is **16 mm** across, against a **25.6 mm** bore
at the waist — **4.8 mm of radial clearance**. It is loose in the bore, not a
press fit. At a seedling stem thickening of 2-5 mm of diameter per year, first
contact lands at **4-10 years**:

    2 mm/yr -> ~9.9 yr    3 mm/yr -> ~6.6 yr
    4 mm/yr -> ~5.0 yr    5 mm/yr -> ~4.0 yr

So the hypocotyl cannot open this pod within the establishment window either,
and the bore may simply be oversized for a 16 mm propagule: a looser fit both
delays contact and holds the seedling less securely, which is the pod's other
job.

The propagule diameter is now MEASURED. The thickening rate is still an estimate
and is what the remaining 4-10 year spread is made of - measuring the stem again
in a year would collapse it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class HypocotylParams:
    """Geometry and growth of the propagule stem inside the bore."""
    # MEASURED on the project's own planted propagule: 16 mm across. (Literature
    # range for R. mangle is ~15-25 mm; this one sits at the slim end.)
    initial_diameter_mm: float = 16.0
    # Secondary thickening of a young seedling stem. Slow: a few mm of DIAMETER
    # per year. This is the single most important number here and the least
    # certain - it decides when the plant first touches the wall.
    growth_mm_per_year: float = 3.0
    # The propagule tapers toward its lower tip; 1.0 at the widest point.
    tip_taper: float = 0.55
    widest_frac: float = 0.30      # widest point, as a fraction up the propagule
    shoot_taper: float = 0.35      # how slim it is at the shoot end
    # Axial extent in the pod, as fractions of pod height. The propagule spans
    # the whole bore, so contact is possible anywhere along it.
    z_lo_frac: float = 0.05
    z_hi_frac: float = 0.95
    n_stations: int = 60


class HypocotylSystem:
    """The stem presented as the load source `pressure.run_simulation` consumes.

    Stations sit ON the pod axis (r = 0) and carry the stem's own radius, so the
    engine's penetration test, `(r_node + radius) - r_inner(z)`, reduces exactly
    to `r_stem(z, t) - r_inner(z)` — how far the stem has grown into the wall."""

    def __init__(self, pod, params: Optional[HypocotylParams] = None,
                 window_months: float = 12.0):
        self.p = params or HypocotylParams()
        self.window_months = float(window_months)
        H = pod.features.height
        z = np.linspace(self.p.z_lo_frac * H, self.p.z_hi_frac * H, self.p.n_stations)
        self.P = np.stack([np.zeros_like(z), np.zeros_like(z), z], axis=1)
        self.nodes = list(self.P)
        # Taper, from the photographs: the propagule is WIDEST in its lower
        # third - the brown region just above the root collar - and narrows
        # upward to the slim green shoot. That widest part therefore sits at or
        # near the pod's WAIST, the tightest point of the bore. Having it the
        # other way round (widest at the top, where the bore flares) meant the
        # stem could never reach the constriction that actually grips it.
        f = (z - z.min()) / max(z.max() - z.min(), 1e-9)
        widest = self.p.widest_frac
        self._taper = np.where(
            f <= widest,
            self.p.tip_taper + (1.0 - self.p.tip_taper) * (f / max(widest, 1e-9)),
            1.0 - (1.0 - self.p.shoot_taper) * ((f - widest) / max(1 - widest, 1e-9)))
        self._r0 = 0.5 * self.p.initial_diameter_mm * self._taper
        self.radius = self._r0.copy()
        self.parent_arr = np.full(len(z), -1, int)
        self.order = np.zeros(len(z), int)
        # the propagule is present from planting; nothing has to grow to arrive
        self.birth_arr = np.zeros(len(z), int)

    def positions(self):
        return self.P

    def segments(self):
        return []

    def birth_time(self, T):
        """Present from step 0 — the propagule is in the pod from day one."""
        return np.zeros(len(self.P))

    def radius_at(self, t, T):
        """Stem radius at step t. Secondary thickening adds diameter linearly in
        real time, tapered along the propagule."""
        months = self.window_months * t / max(T, 1)
        added = 0.5 * self.p.growth_mm_per_year * (months / 12.0)
        return self._r0 + added * self._taper

    # ---- diagnostics ----
    def clearance(self, pod, t, T):
        """Radial gap (mm) between stem and bore at each station; negative means
        the stem is bearing on the wall."""
        return pod.r_inner_at(self.P[:, 2]) - self.radius_at(t, T)

    def first_contact_months(self, pod, max_years: float = 10.0):
        """When the stem first touches the bore anywhere, in months."""
        r_in = pod.r_inner_at(self.P[:, 2])
        gap0 = (r_in - self._r0) / np.maximum(self._taper, 1e-9)
        need = 2.0 * gap0.min() / max(self.p.growth_mm_per_year, 1e-9)   # years
        return float(need * 12.0) if need <= max_years else float("inf")


def grow_hypocotyl(pod, params: Optional[HypocotylParams] = None,
                   window_months: float = 12.0) -> HypocotylSystem:
    """Build the propagule stem as a wall-load source."""
    return HypocotylSystem(pod, params, window_months)
