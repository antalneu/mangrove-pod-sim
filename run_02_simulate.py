"""
Step 2 - grow roots once, simulate wall stress in MPa, and render heatmaps.

    py run_02_simulate.py [seed] [window_months]
"""
import sys
import os
from mangrovesim.podmesh import PodMesh
from mangrovesim import growth, perforation as perf, pressure as pr, viz
from mangrovesim import hypocotyl
from mangrovesim.physical import PhysicalContext

os.makedirs("outputs", exist_ok=True)
seed = int(sys.argv[1]) if len(sys.argv) > 1 else 2
WINDOW_MONTHS = float(sys.argv[2]) if len(sys.argv) > 2 else 36.0

pod = PodMesh.from_ply("pod_mesh11.ply")
pattern = perf.PerforationPattern.detected(pod)
# Design point: seams scored 85% over a 50-degree band. The pod is a
# PROTECTIVE shell first - it has to survive waves and animals while the
# seedling establishes - so releasing early is a failure, not a success.
# At 0.85 nothing cracks before ~4.5 months and PHA releases at ~11.6,
# close to the ~12-month outplant window. Deeper scoring opens it sooner
# and leaves the seedling exposed.
pattern.seam_score, pattern.seam_width_deg = 0.85, 50.0
wm = pr.WallModel(pod, pattern.build_fields(pod))

sp = pr.SimParams()
phys = PhysicalContext.default()
phys.window_months = WINDOW_MONTHS
# Load source: the propagule's HYPOCOTYL thickening in the bore. At the pod's
# true scale the stem is an interference fit, so it grips from planting and
# loads the wall as it thickens - the roots leave through the open base and
# barely touch it. growth.grow stays available for the root-only picture.
roots = hypocotyl.grow_hypocotyl(pod, window_months=WINDOW_MONTHS)
res = pr.run_simulation(pod, wm, roots, sp, phys=phys)
mech = pr.mechanics_summary(res, wm, phys, pattern, sp)

print(f"Hypocotyl load over {WINDOW_MONTHS:.0f} months: {len(roots.nodes)} stations.")
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
viz.render_root_system(pod, growth.grow(pod, growth.GrowthParams(window_months=WINDOW_MONTHS), seed=seed),
                       "outputs/02_roots.png",
                       title=f"root system at {WINDOW_MONTHS:.0f} months")
viz.render_pressure_outer(pod, field, "outputs/02_stress_outer.png", vmax=cmax,
                          title=f"wall stress, MPa (seed {seed})")
viz.render_pressure_png(pod, field, "outputs/02_stress_cutaway.png", vmax=cmax,
                        title=f"wall stress + roots (seed {seed})", roots=roots)
viz.pressure_heatmap_html(pod, field, "outputs/02_stress_interactive.html",
                          roots=roots, vmax=cmax,
                          title=f"Mangrove pod wall stress, MPa (seed {seed})")
print("Wrote outputs/02_roots.png, 02_stress_outer.png, 02_stress_cutaway.png, "
      "02_stress_interactive.html")
