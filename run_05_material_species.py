"""
run_05_material_species.py
==========================
Per-material / per-species break-away report (the industry-comparison view).

Runs the Monte-Carlo break simulation for every (species x material) combination
on the current perforation/seam pattern and prints a reproducible table:
reliability, mean breakthrough time in steps AND real months, and the first seam
to release. Also prints the data-provenance summary so the reader can see, in the
same report, which numbers are literature-backed and which are estimates awaiting
lab validation.

Usage:
    .venv\\Scripts\\python run_05_material_species.py [n_runs]

IMPORTANT: material constants are ENGINEERING ESTIMATES (see the provenance
block). This report ranks options and exposes trade-offs; it does not replace
physical prototype testing.
"""
import os
import sys
import json

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)

from mangrovesim.podmesh import PodMesh
from mangrovesim import perforation as perf, montecarlo as mc, provenance
from mangrovesim.physical import PhysicalContext
from mangrovesim.materials import MATERIALS
from mangrovesim.species import SPECIES

N_RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 20


def main():
    ply = os.path.join(ROOT, "pod_mesh.ply")
    src = os.path.join(ROOT, "mangrovepod.3dm")
    pod = PodMesh.from_ply(ply) if os.path.exists(ply) else PodMesh.from_3dm(src, cache_ply=ply)
    pod.wall_thickness_field()
    print(pod.summary())

    pattern = perf.PerforationPattern.detected(pod, name="as-drawn")
    print(f"\nPattern: {pattern.name}   |   {N_RUNS} runs per combination\n")

    header = f"{'species':<20}{'material':<26}{'reliab.':>8}{'break(step)':>13}{'break(time)':>14}{'first seam':>16}"
    print(header)
    print("-" * len(header))

    rows = []
    for sk, sp in SPECIES.items():
        for mk, mat in MATERIALS.items():
            phys = PhysicalContext(material=mat, species=sp)
            r = mc.run_montecarlo(pod, pattern, n_runs=N_RUNS,
                                  growth_jitter_scale=0.5, phys=phys)
            rel = r.reliability() * 100
            bt = r.mean_breakthrough()
            tctx = phys.elapsed_context(bt, 120)
            fs = r.first_site_counts()
            first = (next(iter(fs), "-") if fs else "-").replace("°", "deg")
            tlabel = (f"~{tctx['months']:.1f} mo" if np.isfinite(bt) else "-")
            btlabel = f"{bt:.1f}" if np.isfinite(bt) else "-"
            print(f"{sp.name:<20}{mat.name[:24]:<26}{rel:>7.0f}%{btlabel:>13}{tlabel:>14}{first:>16}")
            rows.append({"species": sk, "material": mk, "reliability": rel,
                         "mean_breakthrough_step": None if not np.isfinite(bt) else bt,
                         "mean_breakthrough_time": tctx["label"], "first_seam": first})

    # ---- provenance summary in the same report ----
    reg = provenance.build_registry(pod, material=MATERIALS["bioplastic"],
                                    species=SPECIES["rhizophora"])
    print("\nData provenance (constants used):")
    for lvl, n in reg["counts"].items():
        print(f"  {provenance.LEVELS[lvl]['label']:<38} {n}")
    print("\n" + reg["validation_roadmap"])

    out = os.path.join(ROOT, "outputs", "05_material_species.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"n_runs": N_RUNS, "rows": rows, "counts": reg["counts"]}, fh, indent=2)
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
