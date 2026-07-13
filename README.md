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
> tunable parameter. Use it for *relative* comparison of perforation designs and
> for locating failure hot-spots — not for absolute load numbers.

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
  width / height / alignment / base score), root-growth bias, and
  pressure/failure knobs (contact stiffness, time steps, planting-team pull).
- **Centre** — the real pod mesh in 3-D. "▶ Run simulation" grows one root system
  and paints the cumulative wall-stress heatmap with the roots overlaid; toggles
  switch the roots on/off and project the stress onto the outer surface.
- **Right panel** — the verdict (breaks at step N / no breakthrough), stat cards,
  the per-break-site bar chart, and the activation order. "📊 Monte Carlo" runs
  many randomized growths and reports reliability, mean ± std breakthrough time,
  which site cracks first, and the most common activation orders.

The pod mesh loads once at startup; each run takes a fraction of a second, a
Monte-Carlo batch a few seconds.

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
  perforation.py  parametric slots + base split-lines -> per-face strength field
  pressure.py     inflate roots over time -> wall stress -> failure (SimParams)
  montecarlo.py   many randomized runs -> aggregated statistics; compare_patterns
  viz.py          matplotlib renders + Plotly interactive heatmaps
run_01..run_04    scripts for the four stages
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
