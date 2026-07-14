"""
species.py
==========
Ties the simulator's abstract growth/time-step axis to **real propagule biology**,
so the tool can report elapsed weeks/months alongside the step counter and pace
the root-force ramp the way real roots behave (slow at first, not linear).

Two species presets
--------------------
Rhizophora mangle
    Nursery seedlings reach ~30-60 cm and outplant-readiness at ~12 months;
    mature growth ~1-1.5 m/year on productive sites. Early root growth is very
    slow (on the order of 0.1 mm at ~4 weeks in R. mucronata), so root FORCE is
    ramped up slowly at first rather than linearly.

Avicennia marina
    Node (leaf-pair) production interval of ~37-38 days gives a reliable
    biological clock for pacing growth stages. Salinity of ~5-15 ppt is optimal
    for early growth; values outside that band slow growth (optional
    environmental input) and therefore stretch the real elapsed time.

Honesty note
------------
The biological TIMING figures below are established mangrove biology (the source
is named on each provenance entry and should be re-checked against the primary
literature before a production decision). What literature does NOT provide is the
mechanical FORCE a root exerts against a substrate - that comes from the general
tree-root proxy in provenance.py and must be validated physically. The mapping
from "growth stage" to "root force" here is therefore a documented modelling
choice, not a measured relationship.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import numpy as np

from .provenance import Constant, LITERATURE, ESTIMATE, CALIBRATED


@dataclass
class Species:
    key: str
    name: str
    latin: str
    window_months: float             # real months spanned by the full step axis
    outplant_months: float
    mature_growth_m_yr: tuple
    salinity_optimum_ppt: tuple
    early_root_note: str
    node_interval_days: Optional[float] = None   # Avicennia biological clock
    ramp_base: float = 0.25          # root force at the very start (fraction)
    ramp_exp: float = 1.4            # >1 => slow-start (concave) ramp
    ramp_peak: float = 1.15          # multiplier reached late in the window
    blurb: str = ""

    # ---- root-force ramp (slow at first, not linear) ----
    def force_ramp(self, frac) -> np.ndarray:
        """Root-force multiplier over the normalised window fraction [0,1].
        Concave: small early, rising later - matches slow initial root growth."""
        frac = np.clip(np.asarray(frac, float), 0.0, 1.0)
        r = self.ramp_base + (self.ramp_peak - self.ramp_base) * frac ** self.ramp_exp
        return r

    # ---- salinity modifies growth RATE (optional environmental input) ----
    def growth_rate_modifier(self, salinity_ppt: Optional[float]) -> float:
        """1.0 within the optimal salinity band, tapering outside it."""
        if salinity_ppt is None:
            return 1.0
        lo, hi = self.salinity_optimum_ppt
        if lo <= salinity_ppt <= hi:
            return 1.0
        mid = 0.5 * (lo + hi)
        half = max(0.5 * (hi - lo), 1e-6)
        # gentle gaussian taper outside the band, floored at 0.4
        d = (salinity_ppt - (hi if salinity_ppt > hi else lo)) / half
        return float(max(0.4, np.exp(-0.5 * d * d)))

    # ---- real-time mapping ----
    def elapsed_months(self, frac, salinity_ppt: Optional[float] = None) -> float:
        """Real elapsed time for a given fraction of the step axis. Slower growth
        (salinity stress) => the same steps span MORE real time."""
        mod = self.growth_rate_modifier(salinity_ppt)
        return float(np.asarray(frac, float) * self.window_months / max(mod, 1e-6))

    def time_context(self, step: float, n_steps: int,
                     salinity_ppt: Optional[float] = None) -> dict:
        """Human-readable elapsed-time context for a given step."""
        if step is None or not np.isfinite(step):
            return {"months": None, "weeks": None, "nodes": None, "label": "—"}
        frac = float(step) / max(n_steps, 1)
        months = self.elapsed_months(frac, salinity_ppt)
        weeks = months * 4.345
        nodes = (months * 30.437 / self.node_interval_days
                 if self.node_interval_days else None)
        if months < 3:
            label = f"~{weeks:.0f} weeks"
        else:
            label = f"~{months:.1f} months"
        if nodes is not None:
            label += f" · ~{nodes:.0f} nodes"
        return {"months": round(months, 2), "weeks": round(weeks, 1),
                "nodes": None if nodes is None else round(nodes, 1), "label": label}

    # ---- provenance ----
    def provenance_entries(self) -> List[Constant]:
        lo, hi = self.salinity_optimum_ppt
        g_lo, g_hi = self.mature_growth_m_yr
        out = [
            Constant(
                f"sp_{self.key}_outplant", f"{self.name}: outplant-readiness",
                f"~{self.outplant_months:g}", "months", LITERATURE,
                "Mangrove nursery/silviculture literature (verify primary source).",
                "Anchors the real-time window mapped across the step axis.",
                group="species"),
            Constant(
                f"sp_{self.key}_growth", f"{self.name}: mature growth rate",
                f"{g_lo:g}-{g_hi:g}", "m/year", LITERATURE,
                "Mangrove growth studies on productive sites (verify primary source).",
                "Context for pacing; not used directly for force.",
                group="species"),
            Constant(
                f"sp_{self.key}_earlyroot", f"{self.name}: early root growth",
                "very slow initially", "", LITERATURE,
                "R. mucronata early-root data (~0.1 mm at ~4 weeks); verify primary source.",
                "Justifies the concave (slow-start) root-force ramp — root force is "
                "NOT linear in time. The force magnitude itself is the general "
                "tree-root proxy (estimate), not mangrove-measured.",
                group="species"),
        ]
        if self.node_interval_days:
            out.append(Constant(
                f"sp_{self.key}_node", f"{self.name}: node-production interval",
                f"~{self.node_interval_days:g}", "days/node", LITERATURE,
                "Avicennia marina phenology (verify primary source).",
                "Biological clock used to pace growth stages and report node count.",
                group="species"))
        out.append(Constant(
            f"sp_{self.key}_salinity", f"{self.name}: optimal early-growth salinity",
            f"{lo:g}-{hi:g}", "ppt", LITERATURE,
            "Mangrove salinity-response literature (verify primary source).",
            "Optional environmental input: outside this band growth slows, "
            "stretching real elapsed time (and thus wet degradation).",
            group="species"))
        out.append(Constant(
            f"sp_{self.key}_forcemap", f"{self.name}: growth-stage → root-force map",
            "concave ramp (modelling choice)", "", CALIBRATED,
            "This project's modelling choice.",
            "How biological growth stage translates to wall force is assumed, not "
            "measured. Calibration Mode + prototype testing should replace it.",
            group="species"))
        return out

    def as_dict(self):
        lo, hi = self.salinity_optimum_ppt
        g_lo, g_hi = self.mature_growth_m_yr
        return {
            "key": self.key, "name": self.name, "latin": self.latin,
            "window_months": self.window_months, "outplant_months": self.outplant_months,
            "mature_growth_m_yr": [g_lo, g_hi],
            "salinity_optimum_ppt": [lo, hi],
            "node_interval_days": self.node_interval_days,
            "early_root_note": self.early_root_note, "blurb": self.blurb,
        }


SPECIES = {
    "rhizophora": Species(
        key="rhizophora", name="Rhizophora mangle", latin="Rhizophora mangle",
        window_months=12.0, outplant_months=12.0, mature_growth_m_yr=(1.0, 1.5),
        salinity_optimum_ppt=(5.0, 25.0),
        early_root_note="Early root growth very slow (~0.1 mm at 4 weeks, R. mucronata).",
        node_interval_days=None,
        ramp_base=0.20, ramp_exp=1.5, ramp_peak=1.15,
        blurb="Red mangrove; the tall propagule this pod is shaped for. Slow-start roots."),

    "avicennia": Species(
        key="avicennia", name="Avicennia marina", latin="Avicennia marina",
        window_months=11.0, outplant_months=10.0, mature_growth_m_yr=(0.6, 1.0),
        salinity_optimum_ppt=(5.0, 15.0),
        early_root_note="Node-paced growth; ~37-38 day node interval as a biological clock.",
        node_interval_days=37.5,
        ramp_base=0.30, ramp_exp=1.2, ramp_peak=1.12,
        blurb="Grey mangrove; steady node-paced growth, salinity-sensitive early on."),
}

DEFAULT_SPECIES = "rhizophora"


def get_species(key: str) -> Species:
    return SPECIES.get(key, SPECIES[DEFAULT_SPECIES])


def species_payload():
    return {k: s.as_dict() for k, s in SPECIES.items()}
