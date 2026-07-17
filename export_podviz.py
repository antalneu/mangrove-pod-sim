"""
export_podviz.py
================
Export a HIGH-RESOLUTION VISUAL pod mesh from the updated mangrovepod.3dm (now a
dense Mesh, not a NURBS Brep) for RENDERING the intact pod, while the simulation
keeps running on the existing, untouched sim mesh in docs/data/pod.js.

The visual mesh is:
  - welded (coincident verts merged) so Plotly's flatshading:false shades it smooth,
  - aligned to the sim frame (feet z=0, axis at origin) by matching bounding boxes
    (the source model is the same shape/scale, just translated to a far-away frame),
  - shipped with a per-vertex `map` = nearest sim-mesh vertex index, so the app can
    display the per-sim-vertex stress field on this denser mesh (nearest-vertex,
    same approach as the exploded pieces). NO simulation data is touched.

Output: docs/data/podviz.js  ->  window.PODVIZ_RAW = {V, F, map, n_verts, n_faces}
"""
import json, os
import numpy as np
import rhino3dm as r3
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "mangrovepod.3dm")
OUT = os.path.join(ROOT, "docs", "data", "podviz.js")


def extract_VF(geom):
    V, F = [], []
    meshes = [geom] if isinstance(geom, r3.Mesh) else \
        ([fc.GetMesh(r3.MeshType.Render) for fc in geom.Faces] if isinstance(geom, r3.Brep) else [])
    for m in meshes:
        if m is None:
            continue
        base = len(V)
        for vi in range(len(m.Vertices)):
            p = m.Vertices[vi]; V.append([p.X, p.Y, p.Z])
        for qi in range(m.Faces.Count):
            a, b, c, d = m.Faces[qi]
            F.append([base + a, base + b, base + c])
            if d != c:
                F.append([base + a, base + c, base + d])
    return np.array(V, float), np.array(F, int)


def weld(V, F, q=1):
    """Merge verts that coincide when rounded to `q` decimals; remap faces."""
    key = np.round(V, q)
    _, idx, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    # keep the first-seen ORIGINAL coordinate for each unique key
    order = np.argsort(idx)
    newpos = np.empty((len(idx), 3))
    remap = np.empty(len(idx), int)
    for new_i, old_group in enumerate(order):
        newpos[new_i] = V[idx[old_group]]
        remap[old_group] = new_i
    Vn = newpos
    Fn = remap[inv][F]
    return Vn, Fn


def main():
    # --- sim mesh verts (for the nearest-vertex map); NOT modified ---
    src = open(os.path.join(ROOT, "docs", "data", "pod.js"), encoding="utf-8").read()
    src = src[src.index("=") + 1:].rstrip().rstrip(";")
    simV = np.array(json.loads(src)["V"], float).reshape(-1, 3)

    # --- new high-res visual mesh ---
    doc = r3.File3dm.Read(SRC)
    V, F = extract_VF(doc.Objects[0].Geometry)
    V, F = weld(V, F, q=1)

    # --- align to the sim frame by matching bounding-box minima (pure translation:
    #     the model is the same shape/scale, just placed in a distant frame) ---
    offset = simV.min(0) - V.min(0)
    V = V + offset

    # --- nearest sim vertex per visual vertex ---
    tree = cKDTree(simV)
    dist, vmap = tree.query(V, k=1)
    print("alignment offset: (%.1f, %.1f, %.1f)" % tuple(offset))
    print("visual pod: verts=%d faces=%d  (sim mesh verts=%d)" % (len(V), len(F), len(simV)))
    print("bbox after align: x[%.1f,%.1f] y[%.1f,%.1f] z[%.1f,%.1f]" % (
        V[:, 0].min(), V[:, 0].max(), V[:, 1].min(), V[:, 1].max(), V[:, 2].min(), V[:, 2].max()))
    print("nearest sim-vertex distance: mean=%.2f  median=%.2f  max=%.2f" % (
        dist.mean(), np.median(dist), dist.max()))

    data = {
        "V": np.round(V, 1).flatten().tolist(),
        "F": F.astype(int).flatten().tolist(),
        "map": vmap.astype(int).tolist(),
        "n_verts": int(len(V)), "n_faces": int(len(F)),
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("window.PODVIZ_RAW=" + json.dumps(data, separators=(",", ":")) + ";")
    print("wrote %s (%.0f KB)" % (OUT, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
