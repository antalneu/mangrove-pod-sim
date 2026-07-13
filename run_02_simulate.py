"""
Step 2 - grow roots once, simulate wall pressure, and render heatmaps.

    py run_02_simulate.py [seed]
"""
import sys
import os
from mangrovesim.podmesh import PodMesh
from mangrovesim import growth, perforation as perf, pressure as pr, viz

os.makedirs("outputs", exist_ok=True)
seed = int(sys.argv[1]) if len(sys.argv) > 1 else 2

pod = PodMesh.from_ply("pod_mesh.ply")
pattern = perf.PerforationPattern.detected(pod)
wm = pr.WallModel(pod, pattern.build_fields(pod))

roots = growth.grow(pod, growth.GrowthParams(), seed=seed)
res = pr.run_simulation(pod, wm, roots, pr.SimParams())

print(f"Grew {len(roots.nodes)} root nodes.")
print(f"First crack : step {res.first_crack_step} "
      f"at {res.site_labels[res.first_crack_site] if res.first_crack_site>=0 else 'n/a'}")
print(f"Breakthrough: step {res.breakthrough_step}")
print("Activation order:", [res.site_labels[s] for s in res.activation_order])

field = res.cum_stress_faces()
viz.render_root_system(pod, roots, "outputs/02_roots.png")
viz.render_pressure_outer(pod, field, "outputs/02_stress_outer.png",
                          title=f"cumulative wall stress (seed {seed})")
viz.render_pressure_png(pod, field, "outputs/02_stress_cutaway.png",
                        title=f"wall stress + roots (seed {seed})", roots=roots)
viz.pressure_heatmap_html(pod, field, "outputs/02_stress_interactive.html",
                          roots=roots, title=f"Mangrove pod wall stress (seed {seed})")
print("Wrote outputs/02_roots.png, 02_stress_outer.png, 02_stress_cutaway.png, "
      "02_stress_interactive.html")
