"""
export_pieces.py
================
Parse explode_4pieces_3d.3dm (4 Brep quarter-pieces of the pod), extract each
piece's welded render mesh, align it to the tool's coordinate frame (feet at z=0,
central axis at x=y=0, same as the exported pod in docs/data/pod.js), record each
piece's outward explode direction, and write docs/data/pieces.js:

    window.PIECES_RAW = { pieces: [ {V:[...xyz...], F:[...tri idx...], dx, dy}, ... ] }

The tool (Plotly, not Three.js) loads this via <script> like pod.js and builds
one mesh3d trace per piece for the Exploded view. VISUAL-ONLY (no stress mapping).
"""
import json
import rhino3dm as r3

SRC = "explode_4pieces_3d.3dm"
OUT = "docs/data/pieces.js"

f = r3.File3dm.Read(SRC)
raw_pieces = []
for o in f.Objects:
    brep = o.Geometry
    V, F = [], []
    for fi in range(len(brep.Faces)):
        m = brep.Faces[fi].GetMesh(r3.MeshType.Render)
        if m is None:
            continue
        base = len(V)
        for vi in range(len(m.Vertices)):
            p = m.Vertices[vi]
            V.append([p.X, p.Y, p.Z])
        for qi in range(len(m.Faces)):
            fc = m.Faces[qi]
            a, b, c, d = fc[0], fc[1], fc[2], fc[3]
            F.append([base + a, base + b, base + c])
            if d != c:
                F.append([base + a, base + c, base + d])
    raw_pieces.append((V, F))

# ---- global alignment (feet -> z=0, axis -> x=y=0) ----
allV = [v for (V, _) in raw_pieces for v in V]
minZ = min(v[2] for v in allV)
meanX = sum(v[0] for v in allV) / len(allV)
meanY = sum(v[1] for v in allV) / len(allV)
zshift = -minZ

def align(v):
    return [v[0] - meanX, v[1] - meanY, v[2] + zshift]

pieces_out = []
for (V, F) in raw_pieces:
    Va = [align(v) for v in V]
    # outward explode direction = piece centroid (in the recentred frame), xy-normalised
    cx = sum(v[0] for v in Va) / len(Va)
    cy = sum(v[1] for v in Va) / len(Va)
    mag = (cx * cx + cy * cy) ** 0.5 or 1.0
    dx, dy = cx / mag, cy / mag
    flatV = []
    for v in Va:
        flatV += [round(v[0], 1), round(v[1], 1), round(v[2], 1)]
    flatF = []
    for t in F:
        flatF += [t[0], t[1], t[2]]
    pieces_out.append({"V": flatV, "F": flatF, "dx": round(dx, 4), "dy": round(dy, 4),
                       "nV": len(Va), "nF": len(F)})

# ---- report + write ----
zmax = max(align(v)[2] for v in allV)
print("aligned: feet z=0, top z=%.1f  (tool pod height 333.7)" % zmax)
for i, p in enumerate(pieces_out):
    print("piece %d: verts=%d tris=%d  dir=(%.2f,%.2f)" % (i, p["nV"], p["nF"], p["dx"], p["dy"]))

with open(OUT, "w", encoding="utf-8") as fh:
    fh.write("window.PIECES_RAW=" + json.dumps({"pieces": pieces_out}, separators=(",", ":")) + ";")
import os
print("wrote %s (%.0f KB)" % (OUT, os.path.getsize(OUT) / 1024))
