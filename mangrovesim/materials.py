"""
materials.py
============
Candidate pod materials as selectable presets, each carrying the properties that
actually change the break-away behaviour: fracture strength, stiffness, how fast
it loses strength under wet/tidal cycling, and whether it is biodegradable.

**Every material constant here is an ENGINEERING ESTIMATE requiring lab
verification.** These are order-of-magnitude values for thin, scored pod walls of
each material class - not datasheet values for a specific formulation, and not
measured on a real pod. They are provided so the tool can *rank* material choices
and expose the trade-offs; they must be replaced with measured values (via
Calibration Mode and material testing) before any production decision.

How a material enters the physics
---------------------------------
The wall model works in real MPa, so a material enters it directly rather than
as a relative multiplier:

    capacity(t) = fracture_strength_mpa * degradation(t)   # remaining strength
    damage     += (sigma / capacity) ** fatigue_exponent * dt / T_REF_MONTHS

`fracture_strength_mpa` is the wall's capacity in MPa; `degradation` is the
wet/tidal strength loss over elapsed time; `fatigue_exponent` is the
subcritical-crack-growth exponent that decides whether a wall held *just under*
strength eventually fails (low n, polymers) or effectively never does (high n,
ceramics). A biodegradable pod releases because the wall weakens into the root
load - the actual design mechanism.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .provenance import Constant, LITERATURE, ESTIMATE, CALIBRATED


@dataclass
class Material:
    key: str
    name: str
    # --- mechanical (flexural, thin scored wall) - ALL ESTIMATES ---
    fracture_strength_mpa: float          # best estimate
    fracture_range_mpa: tuple             # (lo, hi) plausible spread
    stiffness_mpa: float                  # elastic modulus estimate
    # Static-fatigue (subcritical crack-growth) exponent n: time to rupture
    # scales as (sigma_f/sigma)^n. Ceramics/concrete sit high (20-40, very sharp
    # threshold); polymers lower (8-15).
    fatigue_exponent: float
    # --- durability ---
    wet_strength_loss_per_month: float    # fraction of strength lost per month wet
    # --- environment ---
    biodegradable: bool
    biodegradability: str                 # short human label
    biodegradability_note: str
    # Wet strength loss PLATEAUS: it is not a slide to zero. Marine PHBV drops
    # ~25% early then holds 17-22 MPa of its initial 27; ceramics and concrete
    # lose a little and then hold. Fraction of initial strength retained.
    strength_floor: float = 0.60
    strength_note: str = ""               # caveat on the strength estimate
    warn: bool = False                    # show a visible UI warning
    warn_text: str = ""
    blurb: str = ""

    # ---- physics coupling ----
    def degradation_multiplier(self, elapsed_months: float) -> float:
        """Remaining strength fraction after `elapsed_months` of tidal wetting.
        Linear loss, floored so a wall never becomes literally zero-strength."""
        m = 1.0 - self.wet_strength_loss_per_month * max(elapsed_months, 0.0)
        return float(max(m, self.strength_floor))

    # ---- provenance ----
    def provenance_entries(self) -> List[Constant]:
        lo, hi = self.fracture_range_mpa
        return [
            Constant(
                f"mat_{self.key}_strength",
                f"{self.name}: fracture strength (flexural)",
                f"{self.fracture_strength_mpa:g}  (range {lo:g}-{hi:g})", "MPa",
                ESTIMATE, "Engineering estimate for a thin scored wall of this class.",
                (self.strength_note or
                 "NOT a datasheet value and NOT measured on a pod. This IS the "
                 "seam capacity the computed wall stress is compared against, so "
                 "it sets the margin directly. Verify by testing notched samples "
                 "of the actual formulation."),
                group="material"),
            Constant(
                f"mat_{self.key}_fatigue", f"{self.name}: static-fatigue exponent n",
                f"{self.fatigue_exponent:g}", "", ESTIMATE,
                "Subcritical crack-growth exponents for the material class.",
                "Time to rupture scales as (sigma_f/sigma)^n, so a wall held just "
                "under strength still fails eventually and one held well under it "
                "never does. Class-level estimate - verify with sustained-load "
                "testing.", group="material"),
            Constant(
                f"mat_{self.key}_stiffness", f"{self.name}: stiffness (elastic modulus)",
                f"~{self.stiffness_mpa:g}", "MPa", ESTIMATE,
                "Order-of-magnitude estimate for the material class.",
                "Indicative only; verify by testing.", group="material"),
            Constant(
                f"mat_{self.key}_degrade", f"{self.name}: wet/tidal strength loss",
                f"{self.wet_strength_loss_per_month*100:g}", "% per month", ESTIMATE,
                "Engineering estimate of marine/tidal degradation.",
                "Strongly formulation- and site-dependent. Verify with immersion "
                "testing. Drives how the seam weakens over the establishment window.",
                group="material"),
            Constant(
                f"mat_{self.key}_biodeg", f"{self.name}: biodegradability",
                self.biodegradability, "", ESTIMATE,
                "Environmental classification (estimate).",
                self.biodegradability_note, group="material"),
        ]

    def as_dict(self):
        lo, hi = self.fracture_range_mpa
        return {
            "key": self.key, "name": self.name,
            "fracture_strength_mpa": self.fracture_strength_mpa,
            "fracture_range_mpa": [lo, hi], "stiffness_mpa": self.stiffness_mpa,
            "fatigue_exponent": self.fatigue_exponent,
            "wet_strength_loss_per_month": self.wet_strength_loss_per_month,
            "biodegradable": self.biodegradable,
            "biodegradability": self.biodegradability,
            "biodegradability_note": self.biodegradability_note,
            "strength_note": self.strength_note,
            "warn": self.warn, "warn_text": self.warn_text, "blurb": self.blurb,
            "estimate_disclaimer": "Engineering estimate — requires lab verification.",
        }


# ----------------------------------------------------------------------------- #
#  presets  (ALL VALUES ARE ENGINEERING ESTIMATES - lab verification required)
# ----------------------------------------------------------------------------- #
MATERIALS = {
    # PHA / PHBV — genuinely marine-biodegradable; the design-intent baseline
    # this whole project is built around.
    "pha": Material(
        key="pha", name="PHA / PHBV (marine-degradable)",
        # Measured PHBV (the marine-degradable grade actually mouldable here)
        # sits at ~27-33 MPa; neat PHA reaches ~58 MPa. Range spans both.
        fracture_strength_mpa=32.0, fracture_range_mpa=(25.0, 58.0),
        stiffness_mpa=2800.0,
        fatigue_exponent=12,   # ductile-ish polymer: slow crack growth, forgiving
        # Marine field data: strength falls ~25% early, then HOLDS at 17-22 MPa
        # of an initial 27 - it plateaus rather than sliding to zero.
        wet_strength_loss_per_month=0.06, strength_floor=0.68,
        biodegradable=True, biodegradability="Marine-biodegradable — months to ~1 yr",
        biodegradability_note=(
            "PHA (incl. PHBV) genuinely biodegrades in seawater — field studies show "
            "full marine degradation on the order of months to a few years (within "
            "~1 yr for some formulations), depending on thickness, formulation and "
            "site. This is the design-intent baseline that holds shape, then "
            "dissolves to release the seedling. Estimate — verify with immersion "
            "testing."),
        blurb="Strong at first, then genuinely biodegrades in seawater to release the seedling. The design-intent baseline."),

    # PLA — mechanically stronger/stiffer, but NOT reliably marine-degradable:
    # needs the heat of industrial composting. Distinct preset, distinct claim.
    "pla": Material(
        key="pla", name="PLA (industrial-compost only)",
        fracture_strength_mpa=55.0, fracture_range_mpa=(45.0, 70.0),
        stiffness_mpa=3500.0,
        fatigue_exponent=14,   # stiffer, more brittle polymer than PHA
        # Does not meaningfully degrade in ambient seawater over the window.
        wet_strength_loss_per_month=0.004, strength_floor=0.90,
        biodegradable=False,
        biodegradability="NOT marine-degradable — industrial composting only",
        biodegradability_note=(
            "PLA does NOT reliably biodegrade in ambient marine or soil conditions — "
            "it needs the elevated heat of industrial composting. In side-by-side "
            "testing PLA did not meet standard marine-biodegradation thresholds "
            "where PHA did. It persists in seawater over the establishment window. "
            "Estimate."),
        warn=True, warn_text=(
            "⚠ PLA is NOT marine-degradable: it requires industrial composting heat "
            "and does not reliably break down in ambient seawater or soil. For a "
            "leave-in-place ocean pod, choose PHA instead."),
        blurb="Stiffer and stronger than PHA — but it only composts industrially, so it won't dissolve at sea."),

    "clay": Material(
        key="clay", name="Clay (low-fired earthenware)",
        # Flexural strength across clay-based studies spans ~2.0-9.5 MPa.
        fracture_strength_mpa=5.5, fracture_range_mpa=(2.0, 9.5),
        stiffness_mpa=8000.0,
        fatigue_exponent=30,   # ceramic static fatigue — very sharp threshold
        wet_strength_loss_per_month=0.03, strength_floor=0.55,
        biodegradable=True, biodegradability="Inert mineral — environmentally benign",
        biodegradability_note=(
            "Fired clay is not 'biodegradable' in the polymer sense, but it is an "
            "inert, non-toxic mineral that breaks down to sediment. Unfired/low-fired "
            "clay slakes faster in water (higher degradation). Estimate."),
        strength_note=(
            "Flexural strength across fired-clay studies spans roughly 1–25 MPa; true "
            "low-fired earthenware sits toward the LOW/weak end (intentionally more "
            "porous and less vitrified than higher-fired stoneware), so ~6 MPa is "
            "more representative than the mid-range. Treat the low end as the working "
            "value; verify by testing notched samples."),
        blurb="Brittle, porous low-fired ceramic; cracks readily at a scored seam. Benign if it stays behind."),

    "concrete": Material(
        key="concrete", name="Concrete (unreinforced, thin-wall)",
        # Tensile strength of unreinforced concrete is ~2.2-4.2 MPa.
        fracture_strength_mpa=3.2, fracture_range_mpa=(2.2, 4.2),
        stiffness_mpa=25000.0,
        fatigue_exponent=24,   # concrete static fatigue
        wet_strength_loss_per_month=0.006, strength_floor=0.72,
        biodegradable=False, biodegradability="Not biodegradable — persistent",
        biodegradability_note=(
            "LEAST biodegradable option. Persists in the marine environment for "
            "decades; alkaline leachate can locally raise pH. Cracks in tension at a "
            "scored seam, but the fragments remain. Not recommended for "
            "leave-in-place / dissolving pod designs. Estimate."),
        warn=True, warn_text=(
            "⚠ Concrete is the LEAST biodegradable material: it persists in the "
            "marine environment and can leach alkalinity. It may crack at the seam, "
            "but fragments stay behind — avoid for leave-in-place pods."),
        blurb="Durable and cheap, but persistent. Weak in tension so a thin scored seam still cracks."),
}

DEFAULT_MATERIAL = "pha"


def get_material(key: str) -> Material:
    return MATERIALS.get(key, MATERIALS[DEFAULT_MATERIAL])


def materials_payload():
    return {k: m.as_dict() for k, m in MATERIALS.items()}
