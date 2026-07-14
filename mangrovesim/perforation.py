"""
perforation.py
==============
Parametric perforation patterns and the wall-strength field they produce.

A `PerforationPattern` is the *design you are testing*: a set of vertical waist
slots (position / length / width / count) plus a set of base split-lines (the
intended tear paths between the feet, with an optional score depth). From a
pattern and a pod we build a per-inner-face field:

    open_frac[f]   1 where the face sits inside a slot (no material there)
    strength[f]    local failure capacity  (thickness * material * (1-weakening))
    scf[f]         stress-concentration factor (>1 near slot tips & split-lines)
    ligament[f]    which "break site" this face belongs to (-1 = none)

`ligament` groups the load-bearing bridges we care about: the un-perforated wall
directly below each slot that still connects to the foot ("slot->foot ligament"),
and the base split-lines between feet. A break site *activates* when the roots'
accumulated stress there overwhelms its summed strength (see pressure.py).

Testing variations
------------------
PerforationPattern.detected(pod)                     -> the as-drawn pattern
PerforationPattern.parametric(pod, n_slots=4, ...)   -> a what-if pattern
Vary slot_length_frac, slot_width_deg, slot_z_center_frac, theta_offset_deg,
n_slots, split_depth_frac, split_score (pre-weakening of the split-line).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import numpy as np

from .podmesh import Slot


@dataclass
class SplitLine:
    """An intended base tear-path between two feet."""
    theta_deg: float
    depth_frac: float = 1.3      # how far up (as fraction of z_base_top) it scores
    score: float = 0.35          # 0 = none, 1 = fully pre-cut (strong weakening)


@dataclass
class MaterialParams:
    yield_stress: float = 1.0    # capacity per unit (thickness * area)
    slot_tip_scf: float = 3.0    # stress concentration right at a slot tip
    split_scf: float = 1.8       # stress concentration along a scored split-line
    tip_zone: float = 22.0       # model-unit radius of the slot-tip stress zone
    ligament_halfwidth_deg: float = 26.0   # angular half-width of a slot->foot bridge


@dataclass
class PerforationPattern:
    slots: List[Slot]
    split_lines: List[SplitLine]
    material: MaterialParams = field(default_factory=MaterialParams)
    name: str = "pattern"
    # --- seam / quarter-piece design ---
    # The pod is built as 4 quarter-pieces joined by vertical seams that run
    # rim -> waist slot -> base foot (each seam sits on a slot meridian). A seam
    # is a manufacturing score line: `seam_score` in [0,1] pre-weakens the wall
    # along it (0 = none, 1 = fully pre-cut), over an angular band `seam_width_deg`
    # wide, so a deeper/wider seam gives way sooner. Rotational offset of the whole
    # seam set is the pattern's theta_offset (see parametric()).
    seam_score: float = 0.0
    seam_width_deg: float = 0.0        # 0 => default to ~2x the ligament half-width

    # ---------- constructors ---------- #
    @classmethod
    def detected(cls, pod, name="as-drawn", **mat) -> "PerforationPattern":
        splits = [SplitLine(theta_deg=a) for a in pod.features.split_line_deg]
        return cls(slots=list(pod.features.slots), split_lines=splits,
                   material=MaterialParams(**mat), name=name)

    @classmethod
    def parametric(cls, pod, n_slots=4, slot_length_frac=None, slot_width_deg=None,
                   slot_z_center_frac=None, theta_offset_deg=0.0,
                   align="feet", split_depth_frac=1.3, split_score=0.35,
                   seam_score=0.0, seam_width_deg=0.0,
                   name="parametric", **mat) -> "PerforationPattern":
        """Build a fresh slot + split pattern.

        align="feet"  -> slots centred over the feet (default, matches as-drawn)
        align="split" -> slots centred over the between-feet split-lines
        seam_score / seam_width_deg -> depth/width of the vertical quarter-piece
        seams; theta_offset_deg -> their rotational offset.
        """
        f = pod.features
        H = f.height
        # reference geometry from the detected slots (fallbacks if none)
        det = f.slots
        base_len = np.mean([s.length for s in det]) if det else 0.22 * H
        base_wid = np.mean([s.width_deg for s in det]) if det else 15.0
        base_zc = np.mean([s.z_mid for s in det]) if det else f.z_waist_mid + 20
        length = (slot_length_frac * H) if slot_length_frac is not None else base_len
        width = slot_width_deg if slot_width_deg is not None else base_wid
        # keep the slot TOP fixed (near the as-drawn top) and grow the lower tip
        # downward, so "longer slot" unambiguously means "shorter ligament below".
        det_top = np.mean([s.z_hi for s in det]) if det else (base_zc + base_len / 2)
        if slot_z_center_frac is not None:
            zc = slot_z_center_frac * H
        elif slot_length_frac is not None:
            zc = det_top - length / 2
        else:
            zc = base_zc

        if align == "feet":
            centers = [ft.theta_deg for ft in f.feet]
        else:
            centers = list(f.split_line_deg)
        if len(centers) != n_slots or not centers:
            centers = list(np.linspace(-180, 180, n_slots, endpoint=False))
        centers = [(c + theta_offset_deg + 180) % 360 - 180 for c in centers]

        slots = [Slot(theta_deg=float(c), width_deg=float(width),
                      z_lo=float(zc - length / 2), z_hi=float(zc + length / 2))
                 for c in centers]
        # split-lines sit between consecutive slots
        sc = sorted(centers)
        split_th = []
        for i in range(len(sc)):
            a = sc[i]
            b = sc[(i + 1) % len(sc)] + (360 if i == len(sc) - 1 else 0)
            split_th.append(((a + b) / 2 + 180) % 360 - 180)
        splits = [SplitLine(theta_deg=float(a), depth_frac=split_depth_frac,
                            score=split_score) for a in split_th]
        return cls(slots=slots, split_lines=splits,
                   material=MaterialParams(**mat), name=name,
                   seam_score=seam_score, seam_width_deg=seam_width_deg)

    # ---------- field construction ---------- #
    def build_fields(self, pod) -> "WallFields":
        m = self.material
        F = pod.F
        th = np.degrees(pod.theta_face)
        z = pod.z_face
        r = pod.r_face
        inner = pod.inner_mask
        thickness = pod.wall_thickness_field()
        H = pod.features.height
        z_base_top = pod.features.z_base_top

        n = len(F)
        open_frac = np.zeros(n)
        scf = np.ones(n)
        ligament = np.full(n, -1, int)

        def angdiff(a, b):
            return np.abs(((a - b + 180) % 360) - 180)

        # slots: mark open faces + slot-tip stress zones + slot->foot ligaments
        lig_width_scale = np.ones(n)
        for si, s in enumerate(self.slots):
            in_ang = angdiff(th, s.theta_deg) < s.width_deg / 2
            in_z = (z > s.z_lo) & (z < s.z_hi)
            open_frac[in_ang & in_z] = 1.0
            # stress concentration in a zone around each slot tip (top & bottom)
            for ztip in (s.z_lo, s.z_hi):
                d = np.hypot((angdiff(th, s.theta_deg) * np.pi / 180.0) *
                             np.maximum(r, 1.0), (z - ztip))
                scf = np.maximum(scf, 1 + (m.slot_tip_scf - 1) *
                                 np.exp(-(d / m.tip_zone) ** 2))
            # ligament = load-bearing bridge between the slot bottom and the top
            # of the foot; this is the wall that must tear for the petal to release.
            # A wider slot removes more circumferential material, weakening it.
            # A wider seam band widens the load-bearing bridge it defines.
            halfw = max(m.ligament_halfwidth_deg, s.width_deg * 0.8)
            if self.seam_width_deg > 0:
                halfw = max(halfw, self.seam_width_deg / 2.0)
            lig = inner & (angdiff(th, s.theta_deg) < halfw) & \
                (z < s.z_lo) & (z > z_base_top)
            ligament[lig] = si
            lig_width_scale[lig] = 1.0 - 0.4 * np.clip(s.width_deg / 90.0, 0, 0.6)

        # split-lines: pre-weakening + stress concentration between the feet
        for sp in self.split_lines:
            near = angdiff(th, sp.theta_deg) < 6.0
            low = z < z_base_top * sp.depth_frac
            band = near & low
            scf = np.maximum(scf, np.where(band, 1 + (m.split_scf - 1), 1.0))

        # per-face strength: thickness * material * (1 - slot opening),
        # reduced along scored split-lines
        weaken = np.zeros(n)
        for sp in self.split_lines:
            near = angdiff(th, sp.theta_deg) < 6.0
            low = z < z_base_top * sp.depth_frac
            weaken = np.maximum(weaken, np.where(near & low, sp.score, 0.0))

        # vertical quarter-piece SEAMS: a manufacturing score line down each slot
        # meridian (rim -> waist slot -> foot) that pre-weakens the wall along it.
        seam_weaken = np.zeros(n)
        if self.seam_score > 0:
            seam_hw = (self.seam_width_deg / 2.0 if self.seam_width_deg > 0
                       else m.ligament_halfwidth_deg)
            for s in self.slots:
                on_seam = inner & (angdiff(th, s.theta_deg) < seam_hw)
                seam_weaken = np.maximum(seam_weaken,
                                         np.where(on_seam, self.seam_score, 0.0))
        weaken = np.maximum(weaken, seam_weaken)

        strength = (thickness * m.yield_stress * (1.0 - open_frac)
                    * (1.0 - weaken) * lig_width_scale)
        strength[~inner] = np.inf              # only inner wall carries root load
        strength[open_frac > 0.5] = 1e-6       # already-open slot faces: no capacity

        # base split-line "break sites" (one per split-line), indexed after slots
        split_site = np.full(n, -1, int)
        for spi, sp in enumerate(self.split_lines):
            near = angdiff(th, sp.theta_deg) < m.ligament_halfwidth_deg * 0.6
            low = z < z_base_top * sp.depth_frac
            split_site[inner & near & low] = spi

        return WallFields(open_frac=open_frac, strength=strength, scf=scf,
                          ligament=ligament, split_site=split_site,
                          n_slots=len(self.slots), n_splits=len(self.split_lines),
                          pattern=self)


@dataclass
class WallFields:
    open_frac: np.ndarray
    strength: np.ndarray
    scf: np.ndarray
    ligament: np.ndarray          # slot->foot bridge index per face (-1 none)
    split_site: np.ndarray        # base split-line index per face (-1 none)
    n_slots: int
    n_splits: int
    pattern: PerforationPattern

    def site_labels(self):
        """Human labels for the break sites (slots first, then split-lines)."""
        labels = []
        for s in self.pattern.slots:
            labels.append(f"slot@{s.theta_deg:.0f}°")
        for sp in self.pattern.split_lines:
            labels.append(f"split@{sp.theta_deg:.0f}°")
        return labels
