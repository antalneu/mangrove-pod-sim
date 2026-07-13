"""
podmesh.py
==========
Load the mangrove seed-pod Rhino model and turn it into an analysis-ready mesh
with detected features.

The .3dm file stores the pod as a single solid Brep (NURBS). rhino3dm cannot
mesh a Brep, but Rhino caches a *render mesh* on every Brep face - and that
cached mesh already respects the trimmed slots and feet, so we simply harvest
and weld those per-face meshes into one triangle mesh.

Detected features
-----------------
- central vertical axis (Z up), model recentred so XY-centroid = origin, base z=0
- cylindrical coordinates (r, theta, z) for every vertex and face
- inner-wall / outer-wall face classification (via radial component of normal)
- radius profile -> waist band, trumpet-opening band, base/feet band
- vertical slot perforations at the waist (count, theta, angular width, z-span)
- base feet (count, theta directions, tip radius) and the split-lines between them
- per-inner-face wall-thickness field (ray-cast outward to the outer wall)

Everything downstream (growth, pressure, perforation variants) is expressed in
model units (this file is in centimetres per the Rhino header, though the model
is drawn ~11x larger than a real ~30 cm propagule - see PodMesh.summary()).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from typing import List, Optional

import numpy as np
import trimesh


# --------------------------------------------------------------------------- #
#  Feature containers
# --------------------------------------------------------------------------- #
@dataclass
class Slot:
    """A vertical perforation cut through the waist wall."""
    theta_deg: float      # angular centre
    width_deg: float      # angular width
    z_lo: float
    z_hi: float

    @property
    def z_mid(self) -> float:
        return 0.5 * (self.z_lo + self.z_hi)

    @property
    def length(self) -> float:
        return self.z_hi - self.z_lo


@dataclass
class Foot:
    """A splayed base foot that anchors into soil."""
    theta_deg: float      # direction of the foot tip
    tip_radius: float     # outer radius reached by the tip
    z_top: float          # height where the foot merges into the body


@dataclass
class PodFeatures:
    height: float
    outer_r_waist: float
    inner_r_waist: float
    z_waist_lo: float
    z_waist_hi: float
    z_waist_mid: float
    z_base_top: float             # feet region is below this
    z_trumpet_bottom: float       # trumpet opening region is above this
    top_center: List[float]       # xyz of the top-opening centre (root seed anchor)
    slots: List[Slot] = field(default_factory=list)
    feet: List[Foot] = field(default_factory=list)
    split_line_deg: List[float] = field(default_factory=list)   # angles between feet
    wall_thickness_median: float = 0.0

    def to_dict(self):
        d = asdict(self)
        return d


# --------------------------------------------------------------------------- #
#  Main class
# --------------------------------------------------------------------------- #
class PodMesh:
    """Analysis-ready mangrove pod mesh with detected features."""

    def __init__(self, mesh: trimesh.Trimesh, features: PodFeatures,
                 source: str = ""):
        self.mesh = mesh
        self.features = features
        self.source = source
        self._compute_cached()

    # ---------------- construction ---------------- #
    @classmethod
    def from_3dm(cls, path: str, cache_ply: Optional[str] = None) -> "PodMesh":
        """Read a Rhino .3dm, harvest cached render meshes, weld, recentre."""
        import rhino3dm as r3
        f = r3.File3dm.Read(path)
        verts, faces, voff = [], [], 0
        for obj in f.Objects:
            g = obj.Geometry
            if not isinstance(g, r3.Brep):
                continue
            for fi in range(len(g.Faces)):
                m = g.Faces[fi].GetMesh(r3.MeshType.Render)
                if m is None:
                    m = g.Faces[fi].GetMesh(r3.MeshType.Any)
                if m is None:
                    continue
                nv = len(m.Vertices)
                for i in range(nv):
                    p = m.Vertices[i]
                    verts.append((p.X, p.Y, p.Z))
                for j in range(len(m.Faces)):
                    fc = m.Faces[j]
                    a, b, c, d = fc[0], fc[1], fc[2], fc[3]
                    faces.append((voff + a, voff + b, voff + c))
                    if d != c:
                        faces.append((voff + a, voff + c, voff + d))
                voff += nv
        if not verts:
            raise ValueError(f"No render meshes found in {path}")
        mesh = trimesh.Trimesh(vertices=np.asarray(verts, float),
                               faces=np.asarray(faces, int), process=True)
        cls._recentre(mesh)
        feats = cls._detect_features(mesh)
        pm = cls(mesh, feats, source=path)
        if cache_ply:
            mesh.export(cache_ply)
        return pm

    @classmethod
    def from_ply(cls, path: str) -> "PodMesh":
        mesh = trimesh.load(path, process=True)
        cls._recentre(mesh)
        feats = cls._detect_features(mesh)
        return cls(mesh, feats, source=path)

    # ---------------- geometry helpers ---------------- #
    @staticmethod
    def _recentre(mesh: trimesh.Trimesh):
        V = mesh.vertices
        V[:, 0] -= V[:, 0].mean()
        V[:, 1] -= V[:, 1].mean()
        V[:, 2] -= V[:, 2].min()
        mesh.vertices = V

    def _compute_cached(self):
        m = self.mesh
        self.V = m.vertices
        self.F = m.faces
        self.face_centers = self.V[self.F].mean(axis=1)
        self.face_normals = m.face_normals
        fc = self.face_centers
        self.r_face = np.hypot(fc[:, 0], fc[:, 1])
        self.theta_face = np.arctan2(fc[:, 1], fc[:, 0])
        self.z_face = fc[:, 2]
        radial = np.stack([fc[:, 0] / np.maximum(self.r_face, 1e-9),
                           fc[:, 1] / np.maximum(self.r_face, 1e-9),
                           np.zeros(len(fc))], axis=1)
        self.radial_dir = radial
        self.radial_dot = np.sum(self.face_normals * radial, axis=1)
        # inner wall faces = normal points toward axis (into cavity)
        self.inner_mask = self.radial_dot < -0.30
        self.outer_mask = self.radial_dot > 0.30
        self.face_area = m.area_faces

    # ---------------- feature detection ---------------- #
    @staticmethod
    def _radius_profile(mesh, nb=60):
        Z = mesh.vertices[:, 2]
        R = np.hypot(mesh.vertices[:, 0], mesh.vertices[:, 1])
        H = Z.max()
        edges = np.linspace(0, H, nb + 1)
        zc = 0.5 * (edges[:-1] + edges[1:])
        r_out = np.full(nb, np.nan)
        r_in = np.full(nb, np.nan)
        for i in range(nb):
            m = (Z >= edges[i]) & (Z < edges[i + 1])
            if m.sum() > 3:
                r_out[i] = np.percentile(R[m], 97)
                r_in[i] = np.percentile(R[m], 3)
        return zc, r_out, r_in, H

    @classmethod
    def _detect_features(cls, mesh) -> PodFeatures:
        V = mesh.vertices
        Z = V[:, 2]
        R = np.hypot(V[:, 0], V[:, 1])
        TH = np.arctan2(V[:, 1], V[:, 0])
        H = Z.max()
        zc, r_out, r_in, _ = cls._radius_profile(mesh)

        # ---- waist = band of minimum outer radius in the middle third ----
        mid = (zc > 0.20 * H) & (zc < 0.75 * H)
        r_out_mid = np.where(mid, r_out, np.nan)
        waist_r = np.nanmin(r_out_mid)
        z_waist_mid = zc[np.nanargmin(r_out_mid)]
        thresh = waist_r * 1.30
        waist_band = mid & (r_out < thresh)
        z_waist_lo = zc[waist_band].min()
        z_waist_hi = zc[waist_band].max()
        inner_r_waist = np.nanmedian(r_in[(zc > z_waist_lo) & (zc < z_waist_hi)])

        # ---- base / feet band and trumpet band ----
        z_base_top = 0.15 * H
        z_trumpet_bottom = 0.80 * H

        # ---- top-opening centre (seed anchor) ----
        top_sel = Z > H - 0.05 * H
        top_center = [float(V[top_sel, 0].mean()),
                      float(V[top_sel, 1].mean()),
                      float(Z.max())]

        # ---- SLOT detection: outer-wall faces in waist, (theta,z) raster ----
        slots = cls._detect_slots(mesh, z_waist_lo, z_waist_hi)

        # ---- FEET detection ----
        feet, splits = cls._detect_feet(mesh, z_base_top)

        # ---- wall thickness (ray-cast inner->outer) ----
        wt_med = cls._wall_thickness_median(mesh)

        return PodFeatures(
            height=float(H),
            outer_r_waist=float(waist_r),
            inner_r_waist=float(inner_r_waist),
            z_waist_lo=float(z_waist_lo),
            z_waist_hi=float(z_waist_hi),
            z_waist_mid=float(z_waist_mid),
            z_base_top=float(z_base_top),
            z_trumpet_bottom=float(z_trumpet_bottom),
            top_center=top_center,
            slots=slots,
            feet=feet,
            split_line_deg=splits,
            wall_thickness_median=float(wt_med),
        )

    @staticmethod
    def _runs(mask):
        """Contiguous True runs on a circular boolean array -> list of index lists."""
        n = len(mask)
        seq = mask.tolist()
        if all(seq):
            return [list(range(n))]
        if not any(seq):
            return []
        s = 0
        while seq[s]:
            s += 1
        order = [(s + k) % n for k in range(n)]
        out, cur = [], None
        for bi in order:
            if seq[bi]:
                cur = [bi] if cur is None else cur + [bi]
            else:
                if cur is not None:
                    out.append(cur)
                    cur = None
        if cur is not None:
            out.append(cur)
        return out

    @classmethod
    def _detect_slots(cls, mesh, z_lo, z_hi, gap_min_deg=7.0) -> List[Slot]:
        """Find vertical slots as persistent angular gaps in the outer wall.

        For thin horizontal slices through the waist we sort the outer-wall
        vertices by angle and look for angular gaps wider than `gap_min_deg`.
        Gaps that recur at the same angle over a tall z-range are slots.
        """
        V = mesh.vertices
        Z = V[:, 2]
        R = np.hypot(V[:, 0], V[:, 1])
        TH = np.degrees(np.arctan2(V[:, 1], V[:, 0]))
        pad = 0.12 * (z_hi - z_lo)
        z0, z1 = z_lo - pad, z_hi + pad
        # slice thick enough to average over the mesh's alternating dense/sparse
        # vertex rows (thin slices produce false gaps in the sparse rows)
        step = max(13.0, (z1 - z0) / 12.0)
        raw = []   # (center_deg, width_deg, z_slice)
        z = z0
        while z < z1:
            m = (Z >= z) & (Z < z + step)
            if m.sum() >= 15:
                rr = R[m]
                keep = rr > 0.70 * np.percentile(rr, 95)     # outer wall only
                tt = np.sort(TH[m][keep])
                if len(tt) >= 8:
                    d = np.diff(np.concatenate([tt, [tt[0] + 360]]))
                    for i in range(len(d)):
                        if d[i] > gap_min_deg:
                            c = ((tt[i] + d[i] / 2) + 180) % 360 - 180
                            raw.append((c, d[i], z + step / 2))
            z += step * 0.5   # overlap slices for finer z-resolution
        if not raw:
            return []
        # cluster raw gaps by angle (circular, 20 deg tolerance)
        raw.sort(key=lambda t: t[0])
        clusters = []
        for c, w, zs in raw:
            placed = False
            for cl in clusters:
                if abs(((c - cl["c"] + 180) % 360) - 180) < 20:
                    cl["items"].append((c, w, zs))
                    cl["c"] = np.mean([it[0] for it in cl["items"]])
                    placed = True
                    break
            if not placed:
                clusters.append({"c": c, "items": [(c, w, zs)]})
        slots = []
        for cl in clusters:
            items = cl["items"]
            cs = np.array([it[0] for it in items])
            ws = np.array([it[1] for it in items])
            zss = np.array([it[2] for it in items])
            # a real slot persists over a genuine z-range; drop single-slice noise
            if len(items) < 3 or (zss.max() - zss.min()) < 25:
                continue
            center = np.degrees(np.arctan2(np.sin(np.radians(cs)).mean(),
                                           np.cos(np.radians(cs)).mean()))
            slots.append(Slot(theta_deg=float(center),
                              width_deg=float(ws.max()),
                              z_lo=float(zss.min() - step / 2),
                              z_hi=float(zss.max() + step / 2)))
        slots.sort(key=lambda s: s.theta_deg)
        return slots

    @classmethod
    def _detect_feet(cls, mesh, z_base_top):
        V = mesh.vertices
        Z = V[:, 2]
        R = np.hypot(V[:, 0], V[:, 1])
        TH = np.arctan2(V[:, 1], V[:, 0])
        base = Z < z_base_top
        nA = 360
        ai = np.clip(((TH[base] + np.pi) / (2 * np.pi) * nA).astype(int), 0, nA - 1)
        rmax = np.zeros(nA)
        for a, rr in zip(ai, R[base]):
            if rr > rmax[a]:
                rmax[a] = rr
        # smooth circularly
        k = 9
        ker = np.ones(k) / k
        rs = np.convolve(np.concatenate([rmax[-k:], rmax, rmax[:k]]), ker, "same")[k:-k]
        # feet = prominent circular local maxima (tip radius near the global max)
        thr = 0.80 * rs.max()
        peaks = []
        for i in range(nA):
            if rs[i] >= thr and rs[i] >= rs[(i - 1) % nA] and rs[i] >= rs[(i + 1) % nA]:
                peaks.append((i / nA * 360 - 180, rs[i]))
        peaks.sort()
        merged = []
        for c, v in peaks:                       # merge peaks within 25 deg
            if merged and abs(((c - merged[-1][0] + 180) % 360) - 180) < 25:
                if v > merged[-1][1]:
                    merged[-1] = (c, v)
            else:
                merged.append((c, v))
        feet = [Foot(theta_deg=float(c), tip_radius=float(v), z_top=float(z_base_top))
                for c, v in merged]
        feet.sort(key=lambda ft: ft.theta_deg)
        # split lines = angular midpoints of gaps between consecutive feet
        splits = []
        if len(feet) >= 2:
            angs = sorted(ft.theta_deg for ft in feet)
            for i in range(len(angs)):
                a = angs[i]
                b = angs[(i + 1) % len(angs)]
                if i == len(angs) - 1:
                    b += 360
                mid = ((a + b) / 2 + 180) % 360 - 180
                splits.append(float(mid))
            splits.sort()
        return feet, splits

    @staticmethod
    def _wall_thickness_median(mesh) -> float:
        """Median wall thickness at the waist, cast from inner-wall faces
        *into* the material along the reversed face normal."""
        fc = mesh.vertices[mesh.faces].mean(axis=1)
        r = np.hypot(fc[:, 0], fc[:, 1])
        n = mesh.face_normals
        radial = np.stack([fc[:, 0] / np.maximum(r, 1e-9),
                           fc[:, 1] / np.maximum(r, 1e-9), 0 * r], axis=1)
        rdot = np.sum(n * radial, axis=1)
        H = mesh.vertices[:, 2].max()
        z = fc[:, 2]
        inner = np.where((rdot < -0.35) & (z > 0.25 * H) & (z < 0.70 * H))[0]
        if len(inner) == 0:
            inner = np.where(rdot < -0.35)[0]
        if len(inner) == 0:
            return 0.0
        rng = np.random.default_rng(0)
        pick = rng.choice(inner, size=min(500, len(inner)), replace=False)
        origins = fc[pick] - n[pick] * 0.02          # step into the wall
        dirs = -n[pick]                              # cast into material
        locs, ray_idx, _ = mesh.ray.intersects_location(origins, dirs,
                                                        multiple_hits=False)
        if len(locs) == 0:
            return 0.0
        d = np.linalg.norm(locs - origins[ray_idx], axis=1)
        d = d[(d > 0.1) & (d < 60)]
        return float(np.median(d)) if len(d) else 0.0

    # ---------------- cavity / radius profiles ---------------- #
    def inner_radius_profile(self, nb=40):
        """Axisymmetric inner-cavity radius as a function of z, from inner-wall
        faces (median radius per z-band). Returns (z_grid, r_inner)."""
        z = self.z_face[self.inner_mask]
        r = self.r_face[self.inner_mask]
        H = self.features.height
        edges = np.linspace(0, H, nb + 1)
        zc = 0.5 * (edges[:-1] + edges[1:])
        ri = np.full(nb, np.nan)
        for i in range(nb):
            m = (z >= edges[i]) & (z < edges[i + 1])
            if m.sum() >= 3:
                ri[i] = np.median(r[m])
        # fill gaps
        good = ~np.isnan(ri)
        if good.sum() >= 2:
            ri = np.interp(zc, zc[good], ri[good])
        else:
            ri[:] = self.features.inner_r_waist
        self._zc_prof = zc
        self._ri_prof = ri
        return zc, ri

    def r_inner_at(self, z):
        """Interpolated inner-cavity radius at height(s) z."""
        if not hasattr(self, "_zc_prof"):
            self.inner_radius_profile()
        return np.interp(z, self._zc_prof, self._ri_prof)

    def wall_thickness_field(self):
        """Per-face wall thickness (0 for non-inner faces), cast into material.
        Cached on the instance."""
        if hasattr(self, "_thickness_field"):
            return self._thickness_field
        t = np.zeros(len(self.F))
        inner = np.where(self.inner_mask)[0]
        if len(inner):
            origins = self.face_centers[inner] - self.face_normals[inner] * 0.02
            dirs = -self.face_normals[inner]
            locs, ray_idx, _ = self.mesh.ray.intersects_location(
                origins, dirs, multiple_hits=False)
            d = np.full(len(inner), self.features.wall_thickness_median)
            if len(locs):
                dist = np.linalg.norm(locs - origins[ray_idx], axis=1)
                for ri, dd in zip(ray_idx, dist):
                    if 0.1 < dd < 60:
                        d[ri] = dd
            t[inner] = d
        self._thickness_field = t
        return t

    # ---------------- face masks / regions ---------------- #
    def _ang_diff(self, a_deg, b_deg):
        return np.abs(((a_deg - b_deg + 180) % 360) - 180)

    def slot_face_mask(self, slots=None, ang_pad=3.0, z_pad=6.0):
        """Faces lying within (or on the sidewalls of) any waist slot."""
        slots = self.features.slots if slots is None else slots
        th = np.degrees(self.theta_face)
        z = self.z_face
        mask = np.zeros(len(self.F), bool)
        for s in slots:
            m = (self._ang_diff(th, s.theta_deg) < s.width_deg / 2 + ang_pad) & \
                (z > s.z_lo - z_pad) & (z < s.z_hi + z_pad)
            mask |= m
        return mask

    def foot_face_mask(self):
        """Faces belonging to the splayed base feet."""
        f = self.features
        return (self.z_face < f.z_base_top) & (self.r_face > 0.45 *
                max((ft.tip_radius for ft in f.feet), default=1.0))

    def split_line_face_mask(self, ang_pad=6.0):
        """Faces near the base split-lines between feet (candidate tear paths)."""
        th = np.degrees(self.theta_face)
        mask = np.zeros(len(self.F), bool)
        for a in self.features.split_line_deg:
            mask |= (self._ang_diff(th, a) < ang_pad) & (self.z_face < self.features.z_base_top * 1.4)
        return mask

    def region_labels(self):
        """Per-face coarse region label:
        0 base/feet, 1 lower body, 2 waist wall, 3 slot, 4 upper body, 5 trumpet."""
        f = self.features
        z = self.z_face
        lab = np.full(len(self.F), 1, int)
        lab[z < f.z_base_top] = 0
        lab[(z >= f.z_waist_lo) & (z <= f.z_waist_hi)] = 2
        lab[z > f.z_trumpet_bottom] = 5
        lab[(z > f.z_waist_hi) & (z <= f.z_trumpet_bottom)] = 4
        lab[self.slot_face_mask()] = 3
        return lab

    # ---------------- reporting ---------------- #
    def summary(self) -> str:
        f = self.features
        lines = []
        lines.append(f"Source                 : {os.path.basename(self.source)}")
        lines.append(f"Triangles / vertices   : {len(self.F)} / {len(self.V)}")
        lines.append(f"Height (model units)   : {f.height:.1f}")
        lines.append(f"  (real propagule ~30 cm -> model is ~{f.height/30:.0f}x scale)")
        lines.append(f"Waist outer / inner R  : {f.outer_r_waist:.1f} / {f.inner_r_waist:.1f}")
        lines.append(f"Waist z-band           : {f.z_waist_lo:.0f} .. {f.z_waist_hi:.0f} (mid {f.z_waist_mid:.0f})")
        lines.append(f"Base/feet below z      : {f.z_base_top:.0f}")
        lines.append(f"Trumpet opening above z: {f.z_trumpet_bottom:.0f}")
        lines.append(f"Top-opening centre     : ({f.top_center[0]:.0f},{f.top_center[1]:.0f},{f.top_center[2]:.0f})")
        lines.append(f"Median wall thickness  : {f.wall_thickness_median:.1f}")
        lines.append(f"Waist slots detected   : {len(f.slots)}")
        for i, s in enumerate(f.slots):
            lines.append(f"    slot {i}: theta={s.theta_deg:7.1f}deg  width={s.width_deg:4.1f}deg"
                         f"  z=[{s.z_lo:.0f},{s.z_hi:.0f}] len={s.length:.0f}")
        lines.append(f"Base feet detected     : {len(f.feet)}")
        for i, ft in enumerate(f.feet):
            lines.append(f"    foot {i}: theta={ft.theta_deg:7.1f}deg  tipR={ft.tip_radius:.0f}")
        lines.append(f"Split lines (between feet): "
                     + ", ".join(f"{s:.0f}" for s in f.split_line_deg))
        return "\n".join(lines)

    def save_features(self, path: str):
        with open(path, "w") as fh:
            json.dump(self.features.to_dict(), fh, indent=2)


if __name__ == "__main__":
    import sys
    src = sys.argv[1] if len(sys.argv) > 1 else "mangrovepod.3dm"
    if src.endswith(".3dm"):
        pod = PodMesh.from_3dm(src, cache_ply="pod_mesh.ply")
    else:
        pod = PodMesh.from_ply(src)
    print(pod.summary())
    pod.save_features("outputs/pod_features.json")
    print("\nSaved outputs/pod_features.json")
