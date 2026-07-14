"""
export_geometry.py
==================
Dump everything the *browser* engine needs as one static JSON, so the client-side
port (docs/) can run the whole simulation with no Python backend.

We only precompute what the browser genuinely cannot do itself:
  - the welded mesh vertices/faces (needs rhino3dm/trimesh),
  - per-face radial_dot (needs consistent face normals),
  - the ray-cast wall-thickness field,
  - the detected features + inner/outer radius profiles.

Everything else (face centres, r/theta/z, areas, region labels, masks) the JS
engine recomputes from V/F so we keep the payload small.
"""
import os
import sys
import json

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from mangrovesim.podmesh import PodMesh
from mangrovesim import render3d


def main():
    ply = os.path.join(ROOT, "pod_mesh.ply")
    src = os.path.join(ROOT, "mangrovepod.3dm")
    pod = PodMesh.from_ply(ply) if os.path.exists(ply) else PodMesh.from_3dm(src, cache_ply=ply)
    pod.wall_thickness_field()
    zc_in, ri = pod.inner_radius_profile()
    zc_out, ro = render3d.outer_radius_profile(pod)
    f = pod.features

    data = {
        "V": np.round(pod.V, 2).astype(float).flatten().tolist(),
        "F": pod.F.astype(int).flatten().tolist(),
        "radial_dot": np.round(pod.radial_dot, 3).tolist(),
        "thickness": np.round(pod.wall_thickness_field(), 2).tolist(),
        "inner_prof": {"z": np.round(zc_in, 2).tolist(), "r": np.round(ri, 2).tolist()},
        "outer_prof": {"z": np.round(zc_out, 2).tolist(), "r": np.round(ro, 2).tolist()},
        "features": {
            "height": f.height,
            "outer_r_waist": f.outer_r_waist,
            "inner_r_waist": f.inner_r_waist,
            "z_waist_lo": f.z_waist_lo, "z_waist_hi": f.z_waist_hi,
            "z_waist_mid": f.z_waist_mid,
            "z_base_top": f.z_base_top, "z_trumpet_bottom": f.z_trumpet_bottom,
            "top_center": [float(x) for x in f.top_center],
            "wall_thickness_median": f.wall_thickness_median,
            "slots": [{"theta_deg": s.theta_deg, "width_deg": s.width_deg,
                       "z_lo": s.z_lo, "z_hi": s.z_hi} for s in f.slots],
            "feet": [{"theta_deg": ft.theta_deg, "tip_radius": ft.tip_radius,
                      "z_top": ft.z_top} for ft in f.feet],
            "split_line_deg": list(f.split_line_deg),
        },
        "n_faces": int(len(pod.F)), "n_verts": int(len(pod.V)),
    }

    out_dir = os.path.join(ROOT, "docs", "data")
    os.makedirs(out_dir, exist_ok=True)
    # ship as a JS file loaded via <script> (avoids the fetch() large-body reset
    # that the in-app preview proxy triggers; <script> loads big files fine).
    out = os.path.join(out_dir, "pod.js")
    with open(out, "w") as fh:
        fh.write("window.POD_RAW=")
        json.dump(data, fh, separators=(",", ":"))
        fh.write(";")
    kb = os.path.getsize(out) / 1024
    print(f"wrote {out}  ({kb:.0f} KB, {data['n_verts']} verts, {data['n_faces']} faces)")


if __name__ == "__main__":
    main()
