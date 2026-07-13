"""
Step 1 - load the Rhino pod, detect features, and render a confirmation figure.

    py run_01_load_visualize.py
"""
import os
from mangrovesim.podmesh import PodMesh
from mangrovesim import viz

SRC = "mangrovepod.3dm"
PLY = "pod_mesh.ply"
os.makedirs("outputs", exist_ok=True)

if os.path.exists(PLY):
    pod = PodMesh.from_ply(PLY)
    # re-run detection came from ply; but keep the welded mesh cache
else:
    pod = PodMesh.from_3dm(SRC, cache_ply=PLY)

print(pod.summary())
pod.save_features("outputs/pod_features.json")

viz.render_confirmation(pod, "outputs/01_confirmation.png")
print("\nWrote outputs/01_confirmation.png and outputs/pod_features.json")
