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
The reduced-order surrogate is dimensionless. A material acts through two
*relative* multipliers, anchored so bioplastic reproduces the original
calibration (see provenance.REF_FRACTURE_MPA):

    capacity  x= (fracture_strength / REF_FRACTURE) ** STRENGTH_SENSITIVITY
    capacity  x= degradation(t)      # wet/tidal strength loss over elapsed time

Nothing else in the engine changes. A stronger material resists longer; a
faster-degrading material weakens over the establishment window; a non-degrading
material (concrete) essentially never gives way on its own.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List

from .provenance import (Constant, LITERATURE, ESTIMATE, CALIBRATED,
                         REF_FRACTURE_MPA, STRENGTH_SENSITIVITY)


@dataclass
class Material:
    key: str
    name: str
    # --- mechanical (flexural, thin scored wall) - ALL ESTIMATES ---
    fracture_strength_mpa: float          # best estimate
    fracture_range_mpa: tuple             # (lo, hi) plausible spread
    stiffness_mpa: float                  # elastic modulus estimate
    # --- durability ---
    wet_strength_loss_per_month: float    # fraction of strength lost per month wet
    # --- environment ---
    biodegradable: bool
    biodegradability: str                 # short human label
    biodegradability_note: str
    warn: bool = False                    # show a visible UI warning
    warn_text: str = ""
    blurb: str = ""

    # ---- physics coupling ----
    def strength_scale(self) -> float:
        """Static capacity multiplier vs the reference material."""
        return (self.fracture_strength_mpa / REF_FRACTURE_MPA) ** STRENGTH_SENSITIVITY

    def degradation_multiplier(self, elapsed_months: float) -> float:
        """Remaining strength fraction after `elapsed_months` of tidal wetting.
        Linear loss, floored so a wall never becomes literally zero-strength."""
        m = 1.0 - self.wet_strength_loss_per_month * max(elapsed_months, 0.0)
        return float(max(m, 0.05))

    # ---- provenance ----
    def provenance_entries(self) -> List[Constant]:
        lo, hi = self.fracture_range_mpa
        return [
            Constant(
                f"mat_{self.key}_strength",
                f"{self.name}: fracture strength (flexural)",
                f"{self.fracture_strength_mpa:g}  (range {lo:g}-{hi:g})", "MPa",
                ESTIMATE, "Engineering estimate for a thin scored wall of this class.",
                "NOT a datasheet value and NOT measured on a pod. Sets seam "
                "capacity relative to the reference material. Verify by testing "
                "notched samples of the actual formulation.",
                group="material"),
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
            "wet_strength_loss_per_month": self.wet_strength_loss_per_month,
            "biodegradable": self.biodegradable,
            "biodegradability": self.biodegradability,
            "biodegradability_note": self.biodegradability_note,
            "warn": self.warn, "warn_text": self.warn_text, "blurb": self.blurb,
            "strength_scale": round(self.strength_scale(), 3),
            "estimate_disclaimer": "Engineering estimate — requires lab verification.",
        }


# ----------------------------------------------------------------------------- #
#  presets  (ALL VALUES ARE ENGINEERING ESTIMATES - lab verification required)
# ----------------------------------------------------------------------------- #
MATERIALS = {
    "clay": Material(
        key="clay", name="Clay (low-fired earthenware)",
        fracture_strength_mpa=15.0, fracture_range_mpa=(8.0, 25.0),
        stiffness_mpa=8000.0,
        wet_strength_loss_per_month=0.03,
        biodegradable=True, biodegradability="Inert mineral — environmentally benign",
        biodegradability_note=(
            "Fired clay is not 'biodegradable' in the polymer sense, but it is an "
            "inert, non-toxic mineral that breaks down to sediment. Unfired/low-fired "
            "clay slakes faster in water (higher degradation). Estimate."),
        blurb="Brittle ceramic; cracks readily at a scored seam. Benign if it stays behind."),

    "concrete": Material(
        key="concrete", name="Concrete (unreinforced, thin-wall)",
        fracture_strength_mpa=4.0, fracture_range_mpa=(3.0, 6.0),
        stiffness_mpa=25000.0,
        wet_strength_loss_per_month=0.004,
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

    "bioplastic": Material(
        key="bioplastic", name="Bioplastic (marine-degradable PHA/PLA)",
        fracture_strength_mpa=55.0, fracture_range_mpa=(40.0, 75.0),
        stiffness_mpa=2800.0,
        wet_strength_loss_per_month=0.05,
        biodegradable=True, biodegradability="Marine-biodegradable (formulation-dependent)",
        biodegradability_note=(
            "Designed to hold shape initially, then weaken and biodegrade over the "
            "establishment window. Real degradation rate is highly "
            "formulation/site-dependent (PHA degrades faster than PLA in seawater). "
            "Estimate — verify with immersion testing."),
        blurb="Strong at first, then degrades to release the seedling cleanly. The design-intent baseline."),
}

DEFAULT_MATERIAL = "bioplastic"


def get_material(key: str) -> Material:
    return MATERIALS.get(key, MATERIALS[DEFAULT_MATERIAL])


def materials_payload():
    return {k: m.as_dict() for k, m in MATERIALS.items()}
