"""
Step 4 - test perforation-pattern variations and see which breaks earliest and
most cleanly. Each variant runs a Monte-Carlo batch; results are ranked by mean
breakthrough time and reliability.

    py run_04_perforation_sweep.py [n_runs]
"""
import sys
import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from mangrovesim.podmesh import PodMesh
from mangrovesim import perforation as perf, montecarlo as mc, viz

os.makedirs("outputs", exist_ok=True)
n_runs = int(sys.argv[1]) if len(sys.argv) > 1 else 24

pod = PodMesh.from_ply("pod_mesh.ply")
Hf = pod.features.height

# ---- define the variants to test (edit these to explore your own designs) ----
variants = [
    perf.PerforationPattern.detected(pod, name="as-drawn"),
    perf.PerforationPattern.parametric(pod, name="longer-slots",
                                       slot_length_frac=0.34),
    perf.PerforationPattern.parametric(pod, name="shorter-slots",
                                       slot_length_frac=0.12),
    perf.PerforationPattern.parametric(pod, name="wider-slots",
                                       slot_width_deg=26),
    perf.PerforationPattern.parametric(pod, name="narrower-slots",
                                       slot_width_deg=8),
    perf.PerforationPattern.parametric(pod, name="8-slots",
                                       n_slots=8),
    perf.PerforationPattern.parametric(pod, name="slots-higher",
                                       slot_z_center_frac=0.62),
    perf.PerforationPattern.parametric(pod, name="slots-lower",
                                       slot_z_center_frac=0.42),
    perf.PerforationPattern.parametric(pod, name="slots-over-splits",
                                       align="split"),
    perf.PerforationPattern.parametric(pod, name="deep-base-score",
                                       split_score=0.7, split_depth_frac=1.8),
]

print(f"Sweeping {len(variants)} perforation patterns x {n_runs} runs each...\n")
results = mc.compare_patterns(pod, variants, n_runs=n_runs, verbose=True)

# ---- ranking table ----
rows = []
for name, r in results.items():
    rows.append((name, r.mean_breakthrough(), r.std_breakthrough(),
                 r.mean_first_crack(), r.reliability()))
rows.sort(key=lambda x: (x[1], -x[4]))

print("\n" + "=" * 78)
print(f"{'pattern':22s} {'breakthrough':>13s} {'std':>6s} {'1st-crack':>10s} {'reliab':>7s}")
print("-" * 78)
for name, bt, sd, fc, rel in rows:
    bt_s = f"{bt:.1f}" if np.isfinite(bt) else "none"
    print(f"{name:22s} {bt_s:>13s} {sd:6.1f} {fc:10.1f} {rel*100:6.0f}%")
print("=" * 78)
best = rows[0][0]
print(f"\nEarliest, most reliable breaker: '{best}'")

# ---- comparison chart ----
fig, ax = plt.subplots(figsize=(11, 6))
names = [x[0] for x in rows]
bts = [x[1] if np.isfinite(x[1]) else np.nan for x in rows]
sds = [x[2] if np.isfinite(x[2]) else 0 for x in rows]
rels = [x[4] for x in rows]
colors = ["#2ca02c" if n == "as-drawn" else "#4a76b5" for n in names]
ax.barh(range(len(names)), bts, xerr=sds, color=colors, alpha=0.85)
for i, (n, rel) in enumerate(zip(names, rels)):
    ax.text(1, i, f"  {rel*100:.0f}% reliable", va="center", fontsize=8, color="w")
ax.set_yticks(range(len(names)))
ax.set_yticklabels(names)
ax.invert_yaxis()
ax.set_xlabel("mean breakthrough step (earlier = breaks sooner)")
ax.set_title(f"Perforation-pattern comparison ({n_runs} runs each) - green = as-drawn")
fig.tight_layout()
fig.savefig("outputs/04_perforation_comparison.png", dpi=120, bbox_inches="tight")
print("Wrote outputs/04_perforation_comparison.png")

# results-analysis figure for the best variant
best_pat = next(v for v in variants if v.name == best)
viz.render_results_analysis(pod, results[best], best_pat,
                            "outputs/04_best_variant_analysis.png",
                            title="Best variant - Monte-Carlo")
print("Wrote outputs/04_best_variant_analysis.png")
