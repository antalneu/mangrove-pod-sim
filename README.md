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
4. **Compute wall pressure over time.** Roots swell each time-step; where a root
   body reaches the inner wall it presses outward. Pressure is mapped onto the
   real inner-wall faces and integrated into a cumulative-stress field.
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
  the cumulative wall-stress heatmap on a clear **calm → warning → critical** colour
  scale; toggles switch the seams/roots on/off and project the stress onto the outer
  surface.
- **Right panel** — the verdict (breaks at step N / no breakthrough), stat cards,
  the per-break-site bar chart, and the activation order. "📊 Monte Carlo" runs
  many randomized growths and reports reliability, mean ± std breakthrough time,
  which site cracks first, and the most common activation orders.

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

- **Pressure.** Each root node has a pipe-model radius that matures then keeps
  swelling. Radial penetration `= (r_node + radius) − r_inner(z)`; contact
  pressure `= contact_stiffness × penetration`, spread over the wall patch the
  root touches (a sparse node→face matrix). Base roots add a **wedging** term that
  splays the feet.
- **Stress.** Per inner face, pressure is integrated over time into a cumulative
  stress. A face "fails" when `cumulative_stress × scf ≥ strength`, where
  `strength ∝ local wall thickness` (zero inside a slot) and `scf` is a
  stress-concentration factor that peaks at slot tips and along scored splits.
- **Break sites.** A **slot→foot ligament** (the intact bridge below each slot)
  *tears through* when a crack spans it — i.e. failed faces appear across
  `span_frac` of its stacked z-bands (so a taller/lower-stress bridge is genuinely
  harder to sever). A **split-line** activates when feet-splaying hoop tension
  exceeds its (optionally scored) capacity.
- **Breakthrough** = when `breakthrough_frac` (default 75%) of the slot ligaments
  have torn — the point at which the pod can split into petals / fall away.

### Main tunable knobs

`GrowthParams`: `step_size`, `influence_radius`, `kill_radius`, `n_attractors`,
`down_bias`, `slot_bias`, `wall_bias`, `tip_radius`, `pipe_exponent`,
`radius_gain`.

`SimParams`: `n_time_steps`, `maturation`, `swell_rate`, `max_swell`,
`contact_stiffness`, `base_wedge`, `span_frac`, `hoop_factor`, `breakthrough_frac`,
`pull_assist` (steady external stress to model a planting team pulling the pod).

`PerforationPattern.parametric(...)`: `n_slots`, `slot_length_frac`,
`slot_width_deg`, `slot_z_center_frac`, `theta_offset_deg`, `align` ("feet" or
"split"), `split_depth_frac`, `split_score`.

---

## Caveats

- Units are the model's own (~11× life size); the physics is scale-relative, so
  breakthrough is reported in **time-steps**, not seconds.
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
