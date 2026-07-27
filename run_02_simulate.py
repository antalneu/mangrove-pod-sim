"""
Step 2 - grow roots once, simulate wall stress in MPa, and render heatmaps.

    py run_02_simulate.py [seed]
"""
import sys
import os
from mangrovesim.podmesh import PodMesh
from mangrovesim import growth, perforation as perf, pressure as pr, viz
from mangrovesim import proproots
from mangrovesim.physical import PhysicalContext

os.makedirs("outputs", exist_ok=True)
seed = int(sys.argv[1]) if len(sys.argv) > 1 else 2

pod = PodMesh.from_ply("pod_mesh.ply")
pattern = perf.PerforationPattern.detected(pod)
# Design point: seams scored 92% over a 50-degree band. Chosen for MARGIN -
# it still releases 100% of runs with every uncertainty set against it at
# once (weakest root force, strongest clay draw, perfect bond, thick wall).
pattern.seam_score, pattern.seam_width_deg = 0.92, 50.0
wm = pr.WallModel(pod, pattern.build_fields(pod))

sp = pr.SimParams()
phys = PhysicalContext.default()
# The load source is the propagule's own prop-root cage: the stilt roots emerge
# inside the bore and drive OUT through the wall, in the ligament band, which is
# what actually cracks the pod. `growth.grow` (the in-bore seedling root system)
# is still available and is what the root figure draws alongside.
roots = proproots.grow_prop_roots(pod, seed=seed)
res = pr.run_simulation(pod, wm, roots, sp, phys=phys)
mech = pr.mechanics_summary(res, wm, phys, pattern, sp)

print(f"{len(roots.strands)} prop-root strands -> {len(roots.nodes)} wall contact stations.")
print(f"First crack : step {res.first_crack_step} "
      f"at {res.site_labels[res.first_crack_site] if res.first_crack_site>=0 else 'n/a'}")
print(f"Breakthrough: step {res.breakthrough_step}")
print("Activation order:", [res.site_labels[s] for s in res.activation_order])
print(f"Governing seam stress: {mech['seam_stress_mpa']} MPa  vs "
      f"{mech['strength_end_mpa']} MPa remaining strength "
      f"(utilisation {mech['utilisation']:.0%}, net seam wall "
      f"{mech['seam_thickness_mm']} mm)")

# anchor the colour ramp to remaining strength, as the browser tool does, so the
# top of the scale literally means "at fracture"
field = res.stress_faces()
cmax = res.sigma_f_end_mpa
viz.render_root_system(pod, proproots.cage_render_tree(roots.strands),
                       "outputs/02_roots.png",
                       title="prop roots driving through the pod wall")
viz.render_pressure_outer(pod, field, "outputs/02_stress_outer.png", vmax=cmax,
                          title=f"wall stress, MPa (seed {seed})")
viz.render_pressure_png(pod, field, "outputs/02_stress_cutaway.png", vmax=cmax,
                        title=f"wall stress + roots (seed {seed})", roots=roots)
viz.pressure_heatmap_html(pod, field, "outputs/02_stress_interactive.html",
                          roots=roots, vmax=cmax,
                          title=f"Mangrove pod wall stress, MPa (seed {seed})")
print("Wrote outputs/02_roots.png, 02_stress_outer.png, 02_stress_cutaway.png, "
      "02_stress_interactive.html")
