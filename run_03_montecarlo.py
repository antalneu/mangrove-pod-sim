"""
Step 3 - Monte-Carlo over many randomized root growths for the as-drawn pattern.
Reports mean breakthrough time, which split points activate first, and run-to-run
consistency, and renders a results-analysis figure + interactive heatmap.

    py run_03_montecarlo.py [n_runs]
"""
import sys
import os
import numpy as np
from mangrovesim.podmesh import PodMesh
from mangrovesim import perforation as perf, montecarlo as mc, growth, viz

os.makedirs("outputs", exist_ok=True)
n_runs = int(sys.argv[1]) if len(sys.argv) > 1 else 40

pod = PodMesh.from_ply("pod_mesh.ply")
pattern = perf.PerforationPattern.detected(pod)

print(f"Running {n_runs} randomized simulations (as-drawn perforation)...")
r = mc.run_montecarlo(pod, pattern, n_runs=n_runs, growth_jitter_scale=0.5)
print()
print(r.summary())

# activation-order consistency
from collections import Counter
order_str = Counter(" -> ".join(r.site_labels[s] for s in o[:3])
                    for o in r.activation_orders if o)
print("\nMost common first-3 activation orders:")
for k, v in order_str.most_common(5):
    print(f"  {v:3d}x  {k}")

viz.render_results_analysis(pod, r, pattern, "outputs/03_results_analysis.png",
                            title="As-drawn perforation - Monte-Carlo")
rep = growth.grow(pod, growth.GrowthParams(), seed=7)
viz.pressure_heatmap_html(pod, r.mean_cum_stress_faces,
                          "outputs/03_mean_stress_interactive.html", roots=rep,
                          title="Mean wall stress (as-drawn, %d runs)" % n_runs)
print("\nWrote outputs/03_results_analysis.png and 03_mean_stress_interactive.html")
