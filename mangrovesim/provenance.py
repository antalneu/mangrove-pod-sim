"""
provenance.py
=============
Single source of truth for **every physical constant the simulator relies on**,
each tagged by how well-grounded it is. The web app's "Data provenance" panel and
the report headers both read from this registry, so anyone making a real
production decision can see exactly what is *measured*, what is *literature
sourced*, and what is *an engineering estimate still awaiting lab validation* -
nothing is silently presented as verified fact.

Provenance levels
-----------------
LITERATURE   published measurement / well-established biology, with a citation.
             (Biological-timing figures below are established mangrove biology;
             the primary reference is named and should be re-checked against the
             source before it drives a production decision.)
ESTIMATE     engineering estimate, or a proxy borrowed from adjacent literature
             (e.g. general tree-root biomechanics used in place of missing
             mangrove-specific data). **Needs lab validation.**
GEOMETRY     measured directly off the user's 3-D model - a shape fact, not a
             physical material/biology property.
CALIBRATED   chosen so the reduced-order surrogate behaves sensibly for
             *relative* comparison. Not a measured physical quantity.
MEASURED     supplied by the user from physical prototype testing via Calibration
             Mode (a load cell pressing a real propagule root against a scored
             pod sample). Overrides the estimate once real data exists.

This module deliberately holds no simulation logic - only declared facts and
their provenance. materials.py and species.py contribute their own entries; the
web app merges them for the panel.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


# ----------------------------------------------------------------------------- #
#  provenance levels
# ----------------------------------------------------------------------------- #
LITERATURE = "literature"
ESTIMATE = "estimate"
GEOMETRY = "geometry"
CALIBRATED = "calibrated"
MEASURED = "measured"

LEVELS = {
    LITERATURE: {"label": "Literature-sourced", "color": "#5aa469",
                 "blurb": "Published / well-established; citation given."},
    ESTIMATE:   {"label": "Estimated — needs lab validation", "color": "#c98a3a",
                 "blurb": "Engineering estimate or adjacent-field proxy. Validate physically."},
    GEOMETRY:   {"label": "Measured off the 3-D model", "color": "#5a8fce",
                 "blurb": "A shape fact from your Rhino model, not a material property."},
    CALIBRATED: {"label": "Calibrated (relative surrogate)", "color": "#8a7bd8",
                 "blurb": "Chosen for sensible relative behaviour; not a measured quantity."},
    MEASURED:   {"label": "Measured (your prototype)", "color": "#48c9b0",
                 "blurb": "From your physical Calibration-Mode input; overrides the estimate."},
}


@dataclass
class Constant:
    """One declared value plus where it comes from."""
    key: str
    label: str
    value: str                 # human-readable value (keep units in `unit`)
    unit: str = ""
    level: str = ESTIMATE
    citation: str = ""         # source, or the descriptor of the source
    note: str = ""             # caveat / how it is used
    group: str = "general"

    def as_dict(self):
        lv = LEVELS.get(self.level, LEVELS[ESTIMATE])
        return {
            "key": self.key, "label": self.label, "value": self.value,
            "unit": self.unit, "level": self.level, "level_label": lv["label"],
            "level_color": lv["color"], "citation": self.citation,
            "note": self.note, "group": self.group,
        }


# ----------------------------------------------------------------------------- #
#  coupling reference constants (the physical <-> surrogate bridge)
# ----------------------------------------------------------------------------- #
# The reduced-order engine is dimensionless. Physical inputs enter only as
# *relative* multipliers, anchored to this reference pair so the existing
# calibration is exactly reproduced at (bioplastic, 0.75 MPa).
REF_FRACTURE_MPA = 55.0        # bioplastic flexural strength = capacity baseline
REF_ROOT_PRESSURE_MPA = 0.75   # mid of the grounded 0.5-1.0 MPa working range
# How strongly the *relative* fracture-strength estimate scales seam capacity in
# this surrogate. <1 compresses the spread between materials (a modelling choice,
# not physics). Documented in the panel so it is never mistaken for a measurement.
STRENGTH_SENSITIVITY = 0.9


def coupling_constants() -> List[Constant]:
    return [
        Constant(
            "ref_root_pressure", "Reference root pressure (surrogate anchor)",
            f"{REF_ROOT_PRESSURE_MPA}", "MPa", CALIBRATED,
            "Mid-point of the grounded working range (see root_pressure_working_range).",
            "Root pressure enters the surrogate only as pressure/this-reference; "
            "at this value the drive equals the original calibration.",
            group="coupling"),
        Constant(
            "ref_fracture", "Reference fracture strength (surrogate anchor)",
            f"{REF_FRACTURE_MPA}", "MPa", CALIBRATED,
            "Bioplastic flexural-strength estimate (see materials).",
            "Seam capacity scales as (material strength / this reference) ^ "
            f"{STRENGTH_SENSITIVITY}; bioplastic reproduces the original calibration.",
            group="coupling"),
        Constant(
            "strength_sensitivity", "Strength-to-capacity sensitivity",
            f"{STRENGTH_SENSITIVITY}", "exponent", CALIBRATED,
            "Modelling choice.",
            "Compresses the between-material capacity spread in this reduced-order "
            "surrogate. A tunable modelling knob, not a physical constant.",
            group="coupling"),
    ]


# ----------------------------------------------------------------------------- #
#  core simulation constants (geometry + surrogate calibration)
# ----------------------------------------------------------------------------- #
def core_constants(pod=None) -> List[Constant]:
    """Constants that describe the surrogate itself and the parsed geometry.
    Pass a loaded pod to fill in measured geometry values."""
    out = [
        Constant(
            "model_type", "Failure model",
            "Reduced-order engineering surrogate (not FEA)", "", CALIBRATED,
            "This project's own transparent model.",
            "Calibrated for RELATIVE comparison of designs/materials and to locate "
            "failure hot-spots - not for absolute load numbers. An FEA cross-check "
            "is recommended before trusting absolute margins.",
            group="model"),
        Constant(
            "root_pressure_working_range", "Root-pressure working range (default)",
            "0.5 - 1.0", "MPa", ESTIMATE,
            "General plant/tree root biomechanics literature (NOT mangrove-specific).",
            "Grounded proxy: general max axial root growth pressure ~0.1-1.0 MPa "
            "(turgor-limited), with ~0.5-0.6 MPa commonly cited for fully impeded "
            "roots; tree-specific values reach ~0.91 MPa radial / ~1.45 MPa axial. "
            "Treat as a STARTING POINT pending physical validation.",
            group="root force"),
        Constant(
            "contact_stiffness", "Root contact stiffness",
            "20 (surrogate units)", "", CALIBRATED,
            "Chosen for sensible relative behaviour.",
            "Pressure per unit radial penetration of the swelling root into the "
            "wall. Scaled by (root pressure / reference) so the physical slider "
            "drives it; the base number itself is not a measured quantity.",
            group="root force"),
        Constant(
            "slot_tip_scf", "Stress-concentration factor at slot tips",
            "3.0", "x", ESTIMATE,
            "Order-of-magnitude fracture-mechanics estimate for a rounded notch.",
            "Real value depends on tip radius and material; verify with FEA / a "
            "notched-sample test.",
            group="failure"),
        Constant(
            "span_frac", "Seam tear criterion (crack span)",
            "0.6", "fraction", CALIBRATED,
            "Chosen so a taller bridge is genuinely harder to sever.",
            "A slot->foot seam/ligament 'tears' once failed faces span this "
            "fraction of its stacked z-bands.",
            group="failure"),
        Constant(
            "breakthrough_frac", "Breakthrough criterion",
            "0.75", "fraction", CALIBRATED,
            "Design choice.",
            "Pod 'breaks through' once this fraction of the 4 seams have torn - "
            "the point it can release into petals.",
            group="failure"),
    ]
    if pod is not None:
        f = pod.features
        out += [
            Constant("geom_height", "Pod height", f"{f.height:.1f}",
                     "model units (~11x a 30 cm propagule)", GEOMETRY,
                     "Measured off mangrovepod.3dm.", "", group="geometry"),
            Constant("geom_wall", "Median wall thickness",
                     f"{f.wall_thickness_median:.1f}", "model units", GEOMETRY,
                     "Measured off mangrovepod.3dm.",
                     "Local thickness sets each face's baseline capacity.",
                     group="geometry"),
            Constant("geom_slots", "Detected waist slots",
                     f"{len(f.slots)}", "count", GEOMETRY,
                     "Auto-detected from the mesh.", "", group="geometry"),
            Constant("geom_feet", "Detected base feet",
                     f"{len(f.feet)}", "count", GEOMETRY,
                     "Auto-detected from the mesh.", "", group="geometry"),
        ]
    return out


VALIDATION_ROADMAP = (
    "Industry deployment requires physical prototype testing to replace the "
    "estimated root-force constants with measured ones. Published data covers "
    "mangrove growth TIMING well, but not the mechanical FORCE a propagule root "
    "exerts against a substrate. Recommended path: grow real propagules of each "
    "candidate species inside scored 4-piece pods of each candidate material, "
    "under representative tidal wetting, and record the actual break timing and "
    "which seam releases first. Feed the measured root force (N) back through "
    "Calibration Mode to convert this tool from a relative design explorer into a "
    "quantitatively validated predictor."
)


def build_registry(pod=None, material=None, species=None,
                   root_pressure_mpa: Optional[float] = None,
                   calibration=None) -> dict:
    """Assemble the full provenance registry for the current configuration."""
    consts: List[Constant] = []
    consts += core_constants(pod)
    consts += coupling_constants()
    if material is not None:
        consts += material.provenance_entries()
    if species is not None:
        consts += species.provenance_entries()
    if root_pressure_mpa is not None:
        consts.append(Constant(
            "root_pressure_selected", "Root pressure in use",
            f"{root_pressure_mpa:.2f}", "MPa",
            MEASURED if (calibration and calibration.get("active")) else ESTIMATE,
            ("Your Calibration-Mode measurement." if (calibration and calibration.get("active"))
             else "General tree-root biomechanics proxy (not mangrove-specific)."),
            ("Derived from a measured load-cell force." if (calibration and calibration.get("active"))
             else "Estimated - validate physically."),
            group="root force"))
    counts = {}
    for c in consts:
        counts[c.level] = counts.get(c.level, 0) + 1
    return {
        "levels": LEVELS,
        "constants": [c.as_dict() for c in consts],
        "counts": counts,
        "validation_roadmap": VALIDATION_ROADMAP,
    }
