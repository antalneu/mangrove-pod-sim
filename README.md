# Mangrove Pod — Root-Growth Break-Away Simulation

A Python simulation that loads your real Rhino pod geometry (`mangrovepod.3dm`),
grows a branching root system inside it, computes the outward/downward pressure
the swelling roots exert on the pod wall, and predicts **where and when the pod
tears apart** at its perforations — so you can tune the slot/split pattern for a
pod that reliably breaks away as the sapling establishes (naturally or with a
gentle pull from a planting team).

> **Model status:** this is a transparent *reduced-order* engineering surrogate,
> not finite-element analysis. It is calibrated to be physically sensible and to
> respond correctly to design changes, and every assumption is exposed as a
> tunable parameter. Use it for *relative* comparison of perforation/material/
> species designs and for locating failure hot-spots — not for absolute load
> numbers.
>
> **Honesty first (industry design tool).** Every physical constant is tagged in a
> permanent **Data-provenance panel** as *Literature-sourced*, *Estimated — needs
> lab validation*, *Measured off the 3-D model*, or *Calibrated (relative
> surrogate)*. Nothing assumed is presented as verified fact. In particular, there
> is **no mangrove-specific root-force data in the literature**, so the root
> pressure default (0.5–1.0 MPa) is an estimate borrowed from general tree-root
> biomechanics — see the **Validation roadmap** below.

---

## What it does (matches the original brief)

1. **Load & parse the 3-D model.** Reads the `.3dm` solid Brep with `rhino3dm`,
   harvests Rhino's cached per-face render meshes (which already respect the
   trimmed slots/holes), and welds them into one triangle mesh via `trimesh`.
2. **Extract geometry & features.** Detects the central axis, the flared trumpet
   opening, the narrow waist, the **4 vertical slot perforations**, the **4
   splayed base feet**, the **split-lines** between the feet, and a per-face
   **wall-thickness** field.
3. **Simulate root growth.** Space-colonization branching from the top opening,
   growing down through the waist and out into the feet, with configurable growth
   rate, branching, and bias toward the slots/feet.
4. **Compute wall stress over time.** Roots swell each time-step; where a root
   body reaches the inner wall it bears outward at its turgor-limited growth
   pressure. That pressure is mapped onto the real inner-wall faces and turned
   into a **wall stress in MPa** (hoop + plate bending on the net scored
   section) — see *How the failure model works*.
5. **Visualize as a heatmap** on the actual mesh (static PNG + interactive HTML).
6. **Test perforation variations** (slot length/width/spacing/placement, number
   of slots, base split scoring) and rank which breaks earliest and most cleanly.
7. **Monte-Carlo** many randomized growths and report mean breakthrough time,
   which split points activate first, and run-to-run consistency.

---

## Install & run

The project ships a virtual environment recipe; from the project folder:

```powershell
py -m venv .venv
.venv\Scripts\python -m pip install rhino3dm numpy scipy trimesh matplotlib plotly rtree ^
    --trusted-host pypi.org --trusted-host files.pythonhosted.org
```

Then run the four steps (each writes to `outputs/`):

```powershell
.venv\Scripts\python run_01_load_visualize.py     # parse + feature-check figure
.venv\Scripts\python run_02_simulate.py 2         # one growth + heatmaps (arg = seed)
.venv\Scripts\python run_03_montecarlo.py 40      # N randomized runs + stats
.venv\Scripts\python run_04_perforation_sweep.py 24  # compare pattern variants
.venv\Scripts\python run_05_material_species.py 20   # per-(species x material) break report
```

(`py` is the Windows launcher for the real Python 3.11 install; the bare
`python` alias on this machine is the disabled Microsoft-Store stub.)

---

## Interactive web app (local host)

> **Live in your browser (no install):** the whole tool now also runs **100%
> client-side** at **https://antalneu.github.io/mangrove-pod-sim/** — the engine
> (growth, pressure, materials, species, Monte-Carlo, tube/seam/exploded geometry)
> is ported to JavaScript in `docs/`, so GitHub Pages serves it with no backend.
> The Flask app below is the same thing driven by the original Python engine; use
> it for full-fidelity runs. To preview the static build locally:
> `.venv\Scripts\python serve_docs.py` → http://127.0.0.1:8010 (or regenerate its
> geometry with `python export_geometry.py`).

A Flask app lets you drive the whole simulation from the browser — spin the pod
in 3-D, adjust the perforation / growth / failure parameters with sliders, and
watch where and when it breaks.

```powershell
.venv\Scripts\python -m pip install flask waitress ^
    --trusted-host pypi.org --trusted-host files.pythonhosted.org   # one-time
.venv\Scripts\python webapp\app.py
```

or just double-click **`start_web.bat`**, then open **http://127.0.0.1:5000**.

- **Left panel** — perforation preset or custom sliders (slot count / length /
  width / height / alignment / base score), **quarter-piece seam** depth / width /
  rotational offset, **material** (Clay / Concrete / Bioplastic), **species &
  salinity**, **root pressure (MPa) + Calibration Mode**, root-growth bias, and
  pressure/failure knobs (contact stiffness, time steps, planting-team pull).
- **Centre** — the real pod mesh in 3-D, softly lit so the trumpet/waist/feet form
  reads on its own. The **4 seam lines** (rim → slot → foot) are always drawn as
  raised gold tubes, and a **Intact / Exploded** toggle pulls the pod into its 4
  quarter-pieces so the intended split is clear before running anything.
  "▶ Run simulation" grows one root system — rendered as **tapered woody tubes**
  (thick at the base, tapering to the tips) rather than wireframe lines — and paints
  the wall-stress heatmap in MPa. The colour scale is **anchored to the material's
  remaining fracture strength**, so the top of the ramp literally means "at
  fracture" and switching material visibly recolours the pod.
- **Right panel** — the verdict (releases at month N, or *why not and what to
  change*), stat cards in MPa (seam stress, strength left, utilisation, net seam
  wall), the seam-stress-vs-remaining-strength chart, the per-break-site bar
  chart, and the activation order. "📊 Monte Carlo" samples randomized pods and
  reports a real release probability with the stress spread it came from.

The pod mesh loads once at startup; each run takes a fraction of a second, a
Monte-Carlo batch a few seconds.

---

## Industry design-tool layer (materials · species · provenance · calibration)

On top of the geometry/growth/failure engine, the tool lets you compare **real
material choices** and **real propagule species**, reports break timing in **real
elapsed months**, and keeps every constant honestly labelled. The pod is treated
as **4 seam-defined quarter-pieces** (rim → waist slot → base foot) with
adjustable **seam depth / width / rotational offset**.

### 1 · Material presets — *all values are engineering estimates, lab-verification required*

| material | fracture strength (flexural) | stiffness | wet/tidal loss | biodegradable |
|---|---|---|---|---|
| **Bioplastic** (marine-degradable PHA/PLA) | ~55 MPa (40–75) | ~2 800 MPa | ~5 %/mo | ✅ marine-biodegradable |
| **Clay** (low-fired earthenware) | ~15 MPa (8–25) | ~8 000 MPa | ~3 %/mo | ✅ inert mineral, benign |
| **Concrete** (unreinforced, thin-wall) | ~4 MPa (3–6) | ~25 000 MPa | ~0.4 %/mo | ⚠️ **not biodegradable — persistent** |

Concrete carries a visible **UI warning**: it is the least biodegradable option,
persists in the marine environment, and can leach alkalinity — it may crack at a
scored seam, but the fragments stay behind. A material acts on the physics through
two *relative* multipliers (capacity ∝ strength, and a wet-degradation term over
elapsed time), anchored so **bioplastic reproduces the original calibration**.

### 2 · Species growth calibration (real time, slow-start roots)

| species | outplant | mature growth | biological clock | optimal salinity |
|---|---|---|---|---|
| **Rhizophora mangle** | ~12 mo | 1–1.5 m/yr | slow-start roots (~0.1 mm at 4 wk, *R. mucronata*) | 5–25 ppt |
| **Avicennia marina** | ~10 mo | 0.6–1 m/yr | node interval ~37–38 days | 5–15 ppt |

The step axis maps to **real weeks/months** (shown alongside the step counter),
root **force ramps up slowly at first** (concave, not linear — matching early root
biology), and **salinity** outside the optimal band slows growth so the same steps
span more real time. Biological *timing* figures are literature-sourced (verify
the primary source before production use); the *force* they translate into is the
tree-root estimate, not a mangrove measurement.

### 3 · Root pressure — grounded default + Calibration Mode

Default working range **0.5–1.0 MPa**, labelled *"estimated from general tree-root
biomechanics (not mangrove-specific)"* — a starting point, not a measurement.
**Calibration Mode** lets you enter a real load-cell force (N) and root-tip
contact area (mm²); the tool converts it to MPa (1 MPa = 1 N/mm²), re-tags it
**MEASURED**, and uses it in place of the estimate.

### 4 · Data-provenance panel

A permanent, on-demand panel (🔬 in the header) lists **every constant** grouped by
role, each with its value, source/citation, and a colour-coded provenance tag, so
anyone making a production decision sees exactly what is proven vs. assumed.

### 5 · Validation roadmap

**Industry deployment requires physical prototype testing.** Published data covers
mangrove growth *timing* well, but not the mechanical *force* a propagule root
exerts against a substrate. Recommended path: grow real propagules of each
candidate species inside scored 4-piece pods of each candidate material, under
representative tidal wetting, and record the actual break timing and which seam
releases first. Feed the measured force back through **Calibration Mode** to turn
this relative design explorer into a quantitatively validated predictor.

### CLI report

```powershell
.venv\Scripts\python run_05_material_species.py 20   # per-(species x material) break table + provenance
```

## Detected geometry (from your model)

| feature | value (model units, ~11× a real 30 cm propagule) |
|---|---|
| height | 333.7 |
| waist outer / inner radius | 35.3 / 12.8 |
| waist z-band | 75 – 220 |
| median wall thickness | 21.5 |
| **waist slots** | 4, at θ ≈ −176°, −88°, −9°, +88°, z ≈ 147–222, ~15° wide |
| **base feet** | 4, at θ ≈ −179°, −90°, −1°, +89° |
| **split-lines** (between feet) | ±46°, ±134° |

Each slot sits **directly above a foot**. Confirm visually in
`outputs/01_confirmation.png`.

---

## Key findings for the current design

- **The pod breaks along the 4 slot→foot ligaments, not the between-feet
  split-lines.** The 4 slot ligaments tear in ~100% of runs; the base splits are
  a weak secondary path (they only participate when the feet splay hard).
- **The break is symmetric and reliable.** Across 40 randomized growths the
  as-drawn pattern reached breakthrough in 100% of runs, and the first ligament
  to go was evenly spread over all four slots — so the pod opens like a 4-petal
  flower rather than hinging to one side.
- **Failure is governed by overlap with the peak root-pressure band** — the upper
  waist (z ≈ 150–210), where the thickening trunk presses the narrow bore. The
  design breaks fastest when a slot's tearing ligament spans that band.
- **Design levers** (from `run_04`, breakthrough step, earlier = better):
  `shorter-slots` and `slots-higher` break soonest and most consistently;
  `slots-lower`, `slots-over-splits`, and `8-slots` break latest. Widening slots
  helps slightly (thinner ligament); a deep base score barely changes
  breakthrough because the slot ligaments release the pod first.

See `outputs/04_perforation_comparison.png` and `outputs/03_results_analysis.png`.

---

## Package layout

```
mangrovesim/
  podmesh.py      load .3dm -> mesh, detect waist/slots/feet/thickness, region masks
  growth.py       space-colonization root growth (GrowthParams)
  perforation.py  parametric slots + base split-lines + quarter-piece seams -> strength field
  pressure.py     inflate roots over time -> wall stress -> failure (SimParams, optional phys)
  montecarlo.py   many randomized runs -> aggregated statistics; compare_patterns
  materials.py    Clay / Concrete / Bioplastic presets (all engineering estimates)
  species.py      Rhizophora / Avicennia growth calibration (real-time, slow-start ramp)
  physical.py     material/species/root-pressure -> per-step drive & capacity multipliers; Calibration Mode
  provenance.py   registry of every constant tagged proven vs. estimated; validation roadmap
  viz.py          matplotlib renders + Plotly interactive heatmaps
run_01..run_05    scripts for the pipeline stages (05 = per-material/species report)
webapp/           Flask web app (app.py) + static/ + templates/
start_web.bat     one-click launcher for the web app (Windows)
pod_mesh.ply      cached welded mesh (regenerated from the .3dm on first run)
outputs/          all generated figures, interactive HTML, and pod_features.json
```

## How the failure model works (so you can trust / tune it)

> **Two engines, and they are no longer the same model.** The live browser tool
> (`docs/static/engine.js`) runs the **shell-mechanics model (v2)** described
> below, in real MPa. The Python package under `mangrovesim/` still runs the
> original cumulative-impulse surrogate and is kept for the offline render
> pipeline (`run_01`..`run_05`) — it has **not** been ported to v2, so its
> numbers will not match the website. Trust the browser tool for mechanics.

### Why v2 replaced the original surrogate

The original model integrated contact pressure over time (`cum += p·dt`) and
failed a face when `cum × scf ≥ thickness`. Because `cum` grows explosively once
roots reach the ligament, break time was set almost entirely by *when roots
arrive* — a **22× material-strength range (concrete 4 MPa → PLA 90 MPa) produced
only a 25% difference in break time**, and Monte-Carlo reliability was 100% for
everything. The comparison the tool exists to make was not actually working.

### v2 — real units

The Rhino model is authored in millimetres (334 mm pod, ⌀26 mm bore, ~24 mm
wall), so every quantity below is a real MPa. The unit scale is surfaced in the
provenance panel as the tool's single most load-bearing assumption.

- **Pressure.** A root node's bearing pressure saturates at its **turgor-limited
  growth pressure**: `p = p_root · (1 − e^(−δ/δ₀))`, where δ is radial
  indentation into the bore. However far a root swells it can never bear harder
  than ~1 MPa — the original `k × penetration` was unbounded. Base roots add a
  wedging term that splays the feet.
- **Stress.** Per inner face,
  `σ = SCF · p · [ r_bore/t_eff + β·(L/t_eff)² ]` — membrane hoop on a
  pressurised shell plus transverse plate bending (β ≈ 0.31, clamped plate).
  `t_eff` is the **net section left after scoring**, so a score is a real notch
  rather than a strength multiplier. `L` is the span the bending reacts over: a
  continuous shell localises it to the boundary layer `√(r·t)`, but once the
  vertical seams are scored the wall hinges there and the whole sector reacts at
  the score. This is why **scoring depth, not material, dominates** whether the
  pod opens at all.
- **Failure.** Two paths: brittle overload (`σ ≥ σ_f`) and **static fatigue** —
  `D += (σ/σ_f)^n · dt/t_ref` integrated in real months, with `n` ≈ 12 for
  polymers and 24–30 for ceramics. A wall held just under strength still fails
  eventually; one held well under it never does. `σ_f` decays over the window
  with wet degradation, so a biodegradable pod releases because **the wall
  weakens into the root load** — the actual design mechanism.
- **Crack propagation.** Once a fraction φ of a seam's z-bands have cracked, the
  survivors carry the whole section (`σ ×= 1/(1−φ)`, capped at 8×). A crack
  initiates at the slot-tip stress raiser and then *runs* across the ligament.
- **Break sites.** A **slot→foot ligament** tears when cracking spans
  `span_frac` of its stacked z-bands. Base **split-lines** are banded and judged
  by the same rule.
- **Breakthrough** = when `breakthrough_frac` (default 75%) of the slot ligaments
  have torn.
- **Monte Carlo** resamples fracture strength across the material's published
  range (triangular), root pressure over 0.5–1.0 MPa (skipped when Calibration
  Mode supplies a measured value), a ±5% wall-thickness tolerance, and the root
  architecture — so "release rate" is a probability rather than a restatement of
  one deterministic run.
- **Design guidance.** When a design does not release, the tool back-solves the
  **seam scoring depth** that would release it and reports the net wall in mm.

### What v2 concludes

As moulded, the ~24 mm wall sees only ~0.2 MPa at the seam against 22 MPa of
remaining strength — **no material releases without deep scoring**. Required
scoring depth: concrete/clay ≈ 55%, PHA ≈ 85% (3.6 mm of wall), PLA ≈ 95%. At
the 85% default, PHA releases at ~month 9 while PLA never does and clay/concrete
release around month 6–7, early enough to flag against the ~12-month
outplant-readiness window.

### Main tunable knobs

`GrowthParams`: `step_size`, `influence_radius`, `kill_radius`, `n_attractors`,
`down_bias`, `slot_bias`, `wall_bias`, `tip_radius`, `pipe_exponent`,
`radius_gain`.

`SimParams`: `n_time_steps`, `maturation`, `swell_rate`, `max_swell`,
`contact_stiffness` (in the browser engine this sets the indentation δ₀ at which
a root reaches full bearing pressure), `base_wedge`, `span_frac`,
`breakthrough_frac`, `pull_assist` (an extra bearing pressure in MPa below the
waist, modelling a planting team helping the pod open).

Browser-engine mechanics constants: `MM_PER_UNIT` (unit scale), `PLATE_BETA`,
`T_REF_MONTHS` (static-fatigue reference), `NET_SECTION_FLOOR`, and each
material's `fatigue_exponent`.

`PerforationPattern.parametric(...)`: `n_slots`, `slot_length_frac`,
`slot_width_deg`, `slot_z_center_frac`, `theta_offset_deg`, `align` ("feet" or
"split"), `split_depth_frac`, `split_score`.

---

## Caveats

- The browser engine reads the model's units as **millimetres** (334 mm pod,
  ⌀26 mm bore, ~24 mm wall). Every stress it reports is a real MPa and every
  one of them scales with that assumption, so confirm it against the physical
  prototype before quoting a number. Breakthrough is reported both as a
  time-step and as real elapsed months of the species growth window.
- The extracted mesh is Rhino's render tessellation and is not watertight at the
  slot cuts; this is fine for wall-contact pressure but means volumes/normals near
  slot edges are approximate.
- Absolute stiffness/strength constants are calibrated for sensible *relative*
  behaviour, not measured material properties. Plug in real values (and ideally a
  real FEA cross-check) before trusting absolute margins.
- The **material and species constants are engineering estimates**, not datasheet
  or pod-measured values; the material→physics coupling is a *relative* mapping,
  not calibrated absolute physics. The Data-provenance panel tags each constant,
  and the Validation-roadmap explains what physical testing is required before
  these drive a real production decision.
