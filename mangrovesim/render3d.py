"""
render3d.py
===========
Pure *rendering* geometry helpers for the web viewer — no simulation logic.

Everything here only turns already-computed data (the pod mesh, the grown root
node positions/radii, the detected seam meridians) into triangle geometry the
browser can draw as solid, lit 3-D forms:

- tapered TUBE meshes for the roots (thick, tapering, organic) instead of flat
  wireframe lines,
- raised seam TUBES running rim -> slot -> foot so the 4 intended split lines are
  always visible,
- an EXPLODED split of the pod wall into its 4 quarter-pieces for the
  "show me the split" view.

None of this changes the simulation: the root node positions/radii and the seam
angles are consumed exactly as produced; we only add a light *visual* smoothing
of a COPY of the root centreline so the tubes don't look like sharp zig-zags.
"""
from __future__ import annotations

import numpy as np


# --------------------------------------------------------------------------- #
#  low-level tube construction
# --------------------------------------------------------------------------- #
def _frame(tangent):
    """A stable orthonormal (n1, n2) pair perpendicular to `tangent`."""
    t = tangent / (np.linalg.norm(tangent) + 1e-12)
    ref = np.array([0.0, 0.0, 1.0]) if abs(t[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    n1 = np.cross(t, ref)
    n1 /= (np.linalg.norm(n1) + 1e-12)
    n2 = np.cross(t, n1)
    return n1, n2


def _ring(center, n1, n2, radius, sides, cs, sn):
    return center[None, :] + radius * (np.outer(cs, n1) + np.outer(sn, n2))


class _TubeAccum:
    """Accumulate many frusta into one indexed mesh."""
    def __init__(self, sides=6):
        self.sides = sides
        ang = np.linspace(0, 2 * np.pi, sides, endpoint=False)
        self.cs, self.sn = np.cos(ang), np.sin(ang)
        self.V = []
        self.F = []
        self.n = 0

    def add_frustum(self, a, b, ra, rb):
        t = b - a
        L = np.linalg.norm(t)
        if L < 1e-6:
            return
        n1, n2 = _frame(t)
        s = self.sides
        ra_ = _ring(a, n1, n2, max(ra, 1e-3), s, self.cs, self.sn)
        rb_ = _ring(b, n1, n2, max(rb, 1e-3), s, self.cs, self.sn)
        base = self.n
        self.V.append(ra_)
        self.V.append(rb_)
        self.n += 2 * s
        for k in range(s):
            k2 = (k + 1) % s
            a0, a1 = base + k, base + k2
            b0, b1 = base + s + k, base + s + k2
            self.F.append((a0, a1, b1))
            self.F.append((a0, b1, b0))

    def add_polyline(self, pts, radii):
        pts = np.asarray(pts, float)
        radii = np.asarray(radii, float)
        for i in range(len(pts) - 1):
            self.add_frustum(pts[i], pts[i + 1], radii[i], radii[i + 1])

    def payload(self, round_to=1):
        if not self.V:
            return None
        V = np.round(np.concatenate(self.V, axis=0), round_to)
        F = np.asarray(self.F, int)
        return {
            "x": V[:, 0].tolist(), "y": V[:, 1].tolist(), "z": V[:, 2].tolist(),
            "i": F[:, 0].tolist(), "j": F[:, 1].tolist(), "k": F[:, 2].tolist(),
        }


# --------------------------------------------------------------------------- #
#  outer-wall radius profile (so tubes/seams hug the visible surface)
# --------------------------------------------------------------------------- #
def outer_radius_profile(pod, nz=90):
    """Axisymmetric OUTER radius as a function of z (for placing seams/roots
    against the visible surface). Cached on the pod instance."""
    if hasattr(pod, "_outer_prof"):
        return pod._outer_prof
    z = pod.z_face[pod.outer_mask]
    r = pod.r_face[pod.outer_mask]
    H = pod.features.height
    edges = np.linspace(0, H, nz + 1)
    zc = 0.5 * (edges[:-1] + edges[1:])
    ro = np.full(nz, np.nan)
    for i in range(nz):
        m = (z >= edges[i]) & (z < edges[i + 1])
        if m.sum() >= 3:
            ro[i] = np.percentile(r[m], 88)
    good = ~np.isnan(ro)
    if good.sum() >= 2:
        ro = np.interp(zc, zc[good], ro[good])
    else:
        ro[:] = pod.features.outer_r_waist
    pod._outer_prof = (zc, ro)
    return pod._outer_prof


def _outer_r_at(pod, z):
    zc, ro = outer_radius_profile(pod)
    return np.interp(z, zc, ro)


# --------------------------------------------------------------------------- #
#  roots as tapering tubes
# --------------------------------------------------------------------------- #
def _children(parent):
    ch = [[] for _ in range(len(parent))]
    for i, p in enumerate(parent):
        if p >= 0:
            ch[p].append(i)
    return ch


def _smooth_positions(P, parent, children, iters=2, w=0.45):
    """Light smoothing of a COPY of the centreline (rendering only) so the tubes
    read as roots, not zig-zags. Seeds (parent<0) stay fixed."""
    Q = P.copy()
    for _ in range(iters):
        Qn = Q.copy()
        for i in range(len(P)):
            if parent[i] < 0:
                continue
            neigh = list(children[i])
            neigh.append(int(parent[i]))
            if neigh:
                Qn[i] = (1 - w) * Q[i] + w * Q[neigh].mean(axis=0)
        Q = Qn
    return Q


def root_tube_mesh(roots, sides=6, radius_scale=1.35, r_min=0.8, r_max=7.0,
                   smooth_iters=2):
    """Build a single tapered-tube mesh for the whole root system."""
    P = np.asarray(roots.nodes, float)
    if len(P) < 2 or roots.radius is None:
        return None
    parent = np.asarray(roots.parent_arr, int)
    ch = _children(parent)
    Q = _smooth_positions(P, parent, ch, iters=smooth_iters)
    rad = np.clip(np.asarray(roots.radius, float) * radius_scale, r_min, r_max)
    acc = _TubeAccum(sides=sides)
    for i in range(len(P)):
        p = parent[i]
        if p >= 0:
            acc.add_frustum(Q[p], Q[i], rad[p], rad[i])
    return acc.payload()


# --------------------------------------------------------------------------- #
#  the 4 seams (rim -> slot -> foot) as raised tubes
# --------------------------------------------------------------------------- #
def seam_angles_deg(pod):
    """Seam meridians = the slot centres (each slot sits above a foot)."""
    slots = pod.features.slots
    if slots:
        return [s.theta_deg for s in slots]
    return list(pod.features.split_line_deg)


def seam_tube_mesh(pod, sides=5, n=60, radius=None, lift=1.03):
    """One combined tube mesh for all 4 seam lines, hugging the outer wall from
    just under the trumpet rim down to the base feet."""
    H = pod.features.height
    angles = seam_angles_deg(pod)
    if radius is None:
        radius = max(0.9, 0.02 * pod.features.outer_r_waist)
    z = np.linspace(0.02 * H, 0.985 * H, n)
    rr = _outer_r_at(pod, z) * lift
    acc = _TubeAccum(sides=sides)
    for a in angles:
        ar = np.radians(a)
        pts = np.stack([rr * np.cos(ar), rr * np.sin(ar), z], axis=1)
        acc.add_polyline(pts, np.full(n, radius))
    return acc.payload()


# --------------------------------------------------------------------------- #
#  exploded 4-piece split
# --------------------------------------------------------------------------- #
def exploded_sectors(pod, gap_frac=0.30):
    """Split the wall into its 4 quarter-pieces (bounded by the seams) and push
    each outward along its centre angle. Each sector carries the ORIGINAL vertex
    index per vertex so the client can re-apply a stress field if one exists."""
    seams = sorted(((a + 180) % 360 - 180) for a in seam_angles_deg(pod))
    if len(seams) < 2:
        seams = [-135.0, -45.0, 45.0, 135.0]
    th = np.degrees(pod.theta_face)
    # sector index per face: which (seam[k], seam[k+1]) circular arc it falls in
    def sector_of(a):
        for k in range(len(seams)):
            lo = seams[k]
            hi = seams[(k + 1) % len(seams)]
            if k == len(seams) - 1:      # wrap arc
                if a >= lo or a < hi:
                    return k
            elif lo <= a < hi:
                return k
        return 0

    face_sector = np.array([sector_of(a) for a in th], int)
    gap = gap_frac * pod.features.outer_r_waist
    sectors = []
    for k in range(len(seams)):
        lo = seams[k]
        hi = seams[(k + 1) % len(seams)] + (360 if k == len(seams) - 1 else 0)
        center = ((lo + hi) / 2 + 180) % 360 - 180
        cdir = np.array([np.cos(np.radians(center)), np.sin(np.radians(center)), 0.0])
        fmask = face_sector == k
        faces = pod.F[fmask]
        if len(faces) == 0:
            continue
        used = np.unique(faces)
        remap = {int(v): idx for idx, v in enumerate(used)}
        newV = pod.V[used] + gap * cdir
        newF = np.vectorize(remap.get)(faces)
        sectors.append({
            "x": np.round(newV[:, 0], 1).tolist(),
            "y": np.round(newV[:, 1], 1).tolist(),
            "z": np.round(newV[:, 2], 1).tolist(),
            "i": newF[:, 0].tolist(), "j": newF[:, 1].tolist(), "k": newF[:, 2].tolist(),
            "orig": used.astype(int).tolist(),
        })
    return sectors
