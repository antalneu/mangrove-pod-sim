"""
physical.py
===========
The bridge between the *physical* selections (material, species, root pressure,
salinity, and any Calibration-Mode measurement) and the wall-mechanics model in
pressure.py.

Everything here produces per-time-step quantities in **real units**:

    drive (per step)    = root_pressure_mpa * species.force_ramp_norm(t)   [MPa]
    capacity (per step) = sigma_f_mpa * material.degradation(months(t))    [MPa]
    months (per step)   = real elapsed time, stretched by salinity stress

`drive` is the turgor-limited bearing pressure a fully-engaged root can develop;
`capacity` is the wall's remaining fracture strength. The ramp is normalised to
1.0 at maturity so the root pressure you set IS the peak a root can exert rather
than something the ramp overshoots.

The absolute numbers rest on the model's unit scale (provenance.MM_PER_UNIT) and
on estimated material constants - that caveat is surfaced in the provenance panel.

Calibration Mode
----------------
`pressure_from_force(force_N, contact_area_mm2)` converts a real load-cell reading
(a propagule root pressed against a scored pod sample) into an effective contact
pressure in MPa (= N / mm^2), which overrides the estimated root-pressure default
and is re-tagged MEASURED in the provenance registry.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .provenance import REF_ROOT_PRESSURE_MPA
from .materials import Material, get_material, DEFAULT_MATERIAL
from .species import Species, get_species, DEFAULT_SPECIES


def pressure_from_force(force_n: float, contact_area_mm2: float) -> float:
    """Measured root force (N) over an estimated root-tip contact patch (mm^2)
    -> contact pressure in MPa. 1 MPa = 1 N/mm^2."""
    return float(force_n) / max(float(contact_area_mm2), 1e-6)


@dataclass
class PhysicalContext:
    material: Material
    species: Species
    root_pressure_mpa: float = REF_ROOT_PRESSURE_MPA
    salinity_ppt: Optional[float] = None
    calibration_active: bool = False
    calibration_force_n: Optional[float] = None
    calibration_area_mm2: Optional[float] = None
    # sigma_f_mpa / thickness_factor let Monte Carlo sample the published
    # strength range and a wall-thickness moulding tolerance without disturbing
    # the nominal run. None => the material's best estimate.
    sigma_f_mpa: Optional[float] = None
    thickness_factor: float = 1.0

    def __post_init__(self):
        if self.sigma_f_mpa is None:
            self.sigma_f_mpa = self.material.fracture_strength_mpa

    @property
    def fatigue_n(self) -> float:
        return self.material.fatigue_exponent

    # ---- factories ----
    @classmethod
    def default(cls) -> "PhysicalContext":
        """The design-intent baseline: PHA in a Rhizophora window."""
        return cls(material=get_material(DEFAULT_MATERIAL),
                   species=get_species(DEFAULT_SPECIES))

    @classmethod
    def from_config(cls, cfg: dict) -> "PhysicalContext":
        mat = get_material(cfg.get("material", DEFAULT_MATERIAL))
        sp = get_species(cfg.get("species", DEFAULT_SPECIES))
        sal = cfg.get("salinity_ppt")
        sal = float(sal) if sal not in (None, "") else None
        p = cfg.get("root_pressure_mpa")
        p = float(p) if p not in (None, "") else REF_ROOT_PRESSURE_MPA
        active = bool(cfg.get("calibration_active"))
        f = cfg.get("calibration_force_n")
        a = cfg.get("calibration_area_mm2")
        f = float(f) if f not in (None, "") else None
        a = float(a) if a not in (None, "") else None
        if active and f and a:
            p = pressure_from_force(f, a)
        sig = cfg.get("sigma_f_mpa")
        tfac = cfg.get("thickness_factor")
        return cls(material=mat, species=sp, root_pressure_mpa=p,
                   salinity_ppt=sal, calibration_active=active and bool(f and a),
                   calibration_force_n=f, calibration_area_mm2=a,
                   sigma_f_mpa=float(sig) if sig not in (None, "") else None,
                   thickness_factor=float(tfac) if tfac not in (None, "") else 1.0)

    # ---- couplings ----
    def load_factor(self) -> float:
        return self.root_pressure_mpa / REF_ROOT_PRESSURE_MPA

    def per_step(self, T: int):
        """Per-step drive (MPa of available root bearing pressure) and capacity
        (MPa of remaining fracture strength after wet degradation), plus the real
        elapsed months each step lands on. Returns (drive[T], capacity[T], months[T])."""
        frac = np.arange(1, T + 1, dtype=float) / max(T, 1)
        ramp = self.species.force_ramp_norm(frac)
        months = np.array([self.species.elapsed_months(fr, self.salinity_ppt)
                           for fr in frac])
        degrade = np.array([self.material.degradation_multiplier(mo) for mo in months])
        drive = self.root_pressure_mpa * ramp
        capacity = np.maximum(self.sigma_f_mpa * degrade, 1e-6)
        return drive, capacity, months

    def elapsed_context(self, step, T):
        return self.species.time_context(step, T, self.salinity_ppt)

    def summary(self) -> dict:
        return {
            "material": self.material.key,
            "material_name": self.material.name,
            "species": self.species.key,
            "species_name": self.species.name,
            "root_pressure_mpa": round(self.root_pressure_mpa, 3),
            "salinity_ppt": self.salinity_ppt,
            "calibration_active": self.calibration_active,
            "window_months": self.species.window_months,
            "load_factor": round(self.load_factor(), 3),
            "sigma_f_mpa": round(self.sigma_f_mpa, 2),
            "fatigue_n": self.fatigue_n,
        }
