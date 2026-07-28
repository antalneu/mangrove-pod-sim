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
CALIBRATED   a modelling choice: chosen so the wall-mechanics model behaves
             sensibly. Not a measured physical quantity.
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
    CALIBRATED: {"label": "Calibrated (modelling choice)", "color": "#8a7bd8",
                 "blurb": "Chosen for sensible behaviour; not a measured quantity."},
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
#  physical scale + wall-mechanics constants
# ----------------------------------------------------------------------------- #
# MEASURED off the physical pod, not assumed. The owner's CAD dimensions give a
# 197 mm tall pod with a 126 mm foot span and a 51.4 mm top opening. Against the
# 333.7-unit model that fixes the scale at 0.5904 mm per unit, and the other two
# dimensions then land within 3-5% - three independent confirmations.
# At that scale the WAIST BORE is only ~15 mm, against a 20-36 mm propagule.
# Every pressure and stress in pressure.py is therefore a real MPa (N/mm^2).
# THIS IS THE SINGLE MOST LOAD-BEARING ASSUMPTION IN THE TOOL: every stress
# scales with it, so confirm it against the physical prototype.
MM_PER_UNIT = 0.5904
# Clamped rectangular plate, peak bending stress sigma = beta*p*(L/t)^2
# (Roark's Formulas for Stress and Strain, clamped edges, a/b ~ 1 -> beta ~ 0.308).
PLATE_BETA = 0.31
# Static fatigue / subcritical crack growth: at sigma = sigma_f the section
# ruptures in T_REF_MONTHS; below that, time-to-rupture scales as (sigma_f/sigma)^n.
T_REF_MONTHS = 0.5
MIN_T_EFF_MM = 0.15            # a score cannot thin the wall below this
NET_SECTION_FLOOR = 0.12       # cap on net-section amplification (~8x)
# Crack propagation, K = Y * sigma * sqrt(pi*a). What drives a crack forward is
# the stress INTENSITY at its tip - a function of the load applied to the seam
# and how long the crack already is - NOT whatever stress happens to sit in the
# material just ahead of it. That distinction decides whether a DISCRETE load can
# open a seam at all: a prop root driving through the wall at one spot raises
# almost no stress in the next band along, so a rule keyed to local stress
# stalls, while a K-based one lets the crack run on the load that started it.
# Expressed per band, with the first cracked band as the reference flaw:
#     amplification = CRACK_GEOM_Y * sqrt(bands already cracked)
CRACK_GEOM_Y = 1.15            # geometry factor Y (edge-crack-ish, order 1)

REF_ROOT_PRESSURE_MPA = 0.75   # mid of the grounded 0.5-1.0 MPa working range


def contact_ref_mm(contact_stiffness: float) -> float:
    """Indentation delta0 (mm) at which a swelling root reaches its full bearing
    pressure, p = p_root * (1 - exp(-delta/delta0)). Tied to the "wall contact
    stiffness" control so that knob keeps its meaning: a stiffer contact reaches
    full pressure after a smaller indentation."""
    return min(max(10.0 / max(float(contact_stiffness), 1e-3), 0.12), 4.0)


def coupling_constants() -> List[Constant]:
    return [
        Constant(
            "ref_root_pressure", "Reference root pressure (default)",
            f"{REF_ROOT_PRESSURE_MPA}", "MPa", CALIBRATED,
            "Mid-point of the grounded working range (see root_pressure_working_range).",
            "The turgor-limited bearing pressure a fully-engaged root develops. "
            "However far a root swells it can never push harder than this.",
            group="coupling"),
        Constant(
            "unit_scale", "Model unit scale",
            f"1 unit = {MM_PER_UNIT:g} mm", "", GEOMETRY,
            "Read off the Rhino model's own dimensions; CONFIRMED against the "
            "design intent by the project owner.",
            "Every stress scales with this, so it was long flagged as the tool's "
            "most load-bearing assumption. Now settled: the design is a 334 mm "
            "pod. Note the 14 cm 3-D-printed field demo is a 2.4x scale "
            "PROTOTYPE - stress results transfer to it (the stress relation "
            "depends on r/t and span/t, which are ratios) but CONTACT TIMING "
            "does not, because a real propagule and its roots are the same "
            "physical size in both.",
            group="model"),
        Constant(
            "stress_formula", "Wall stress relation",
            "sigma = SCF * p * [ r/t + beta*(L/t)^2 ]", "MPa", CALIBRATED,
            "Standard thin-shell + flat-plate relations, combined by this project.",
            "Membrane hoop stress on a pressurised shell superposed with the "
            "transverse bending of the wall panel. Superposition of the two is the "
            "modelling choice; each term on its own is textbook.",
            group="model"),
        Constant(
            "plate_beta", "Plate bending coefficient beta",
            f"{PLATE_BETA}", "", LITERATURE,
            "Roark's Formulas for Stress and Strain - clamped rectangular plate, a/b ~ 1.",
            "Peak bending stress under uniform pressure, sigma = beta*q*b^2/t^2.",
            group="model"),
        Constant(
            "t_ref_months", "Static-fatigue reference time",
            f"{T_REF_MONTHS}", "months", CALIBRATED,
            "Modelling choice.",
            "Time to rupture when stress exactly equals the remaining fracture "
            "strength. Sets the absolute pace of the delayed-failure branch.",
            group="failure"),
        Constant(
            "net_section", "Net-section amplification",
            f"1 / (1 - phi), capped at {1/NET_SECTION_FLOOR:.0f}x", "", CALIBRATED,
            "Net-section stress principle.",
            "Once a fraction phi of a seam's bands have cracked, the survivors "
            "carry the whole section. This is what makes a crack initiate at the "
            "slot-tip hot spot and then RUN across the ligament rather than stalling.",
            group="failure"),
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
            "Shell mechanics in real MPa (not FEA)", "", CALIBRATED,
            "This project's own transparent model.",
            "Hoop + plate bending on the net scored section, failed by brittle "
            "overload and a power-law static-fatigue integral. Absolute numbers "
            "are real MPa but rest on the unit scale and the estimated constants "
            "below; an FEA cross-check is recommended before trusting margins.",
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
            "contact_stiffness", "Contact engagement depth delta0",
            f"{contact_ref_mm(20.0):.2f}", "mm", CALIBRATED,
            "Chosen for sensible relative behaviour.",
            "Indentation at which a swelling root reaches its full bearing "
            "pressure, p = p_root * (1 - exp(-delta/delta0)). Driven by the 'wall "
            "contact stiffness' control. Not a measured quantity.",
            group="root force"),
        Constant(
            "slot_tip_scf", "Stress-concentration factor at slot tips",
            "3.0", "x", ESTIMATE,
            "Order-of-magnitude fracture-mechanics estimate for a rounded notch.",
            "Real value depends on tip radius and material; verify with FEA / a "
            "notched-sample test.",
            group="failure"),
        Constant(
            "crack_geom_y", "Crack-propagation geometry factor Y",
            f"{CRACK_GEOM_Y}", "", ESTIMATE,
            "Linear-elastic fracture mechanics, K = Y*sigma*sqrt(pi*a); Y is order 1.",
            "A crack front advances on the stress INTENSITY there - the seam's "
            "driving load times the square root of the crack already formed - not "
            "on the local stress ahead of it. This is what lets a discrete load "
            "(a prop root through the wall at one point) open a whole seam, and "
            "what makes a long crack accelerate. Verify against a fracture test.",
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
            Constant("geom_height", "Pod height",
                     f"{f.height * MM_PER_UNIT:.0f}", "mm", GEOMETRY,
                     "Measured off mangrovepod.3dm.", "", group="geometry"),
            Constant("geom_wall", "Median wall thickness",
                     f"{f.wall_thickness_median * MM_PER_UNIT:.1f}", "mm", GEOMETRY,
                     "Measured off mangrovepod.3dm.",
                     "Local thickness sets the net section that carries the root "
                     "load - the single most sensitive geometric input.",
                     group="geometry"),
            Constant("geom_bore", "Bore diameter at the waist",
                     f"{2 * f.inner_r_waist * MM_PER_UNIT:.1f}", "mm", GEOMETRY,
                     "Measured off mangrovepod.3dm.",
                     "The lever arm for hoop stress, and the space the propagule "
                     "has to thicken into.", group="geometry"),
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
