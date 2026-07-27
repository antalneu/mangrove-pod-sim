# Mangrove Pod — Root-Growth Break-Away Simulation

A Python simulation that loads your real Rhino pod geometry (`mangrovepod.3dm`),
grows a branching root system inside it, computes the outward/downward pressure
the swelling roots exert on the pod wall, and predicts **where and when the pod
tears apart** at its perforations — so you can tune the slot/split pattern for a
pod that reliably breaks away as the sapling establishes (naturally or with a
gentle pull from a planting team).

> **Model status:** this is a transparent *reduced-order* shell-mechanics model,
> not finite-element analysis. It works in real MPa (hoop + plate bending on the
> net scored section), but those absolute numbers rest on the model's unit scale
> and on estimated material constants, and every assumption is exposed as a
> tunable parameter. Trust it for comparing perforation/material/species designs
> and locating failure hot-spots; confirm absolute margins with FEA and physical
> testing before a production decision.
>
> **Honesty first (industry design tool).** Every physical constant is tagged in a
> permanent **Data-provenance panel** as *Literature-sourced*, *Estimated — needs
> lab validation*, *Measured off the 3-D model*, or *Calibrated (modelling
> choice)*. Nothing assumed is presented as verified fact. In particular, there
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
3. **Grow the seedling's roots, paced to real growth stages.** Over a 12-month
   window a *Rhizophora* has a **primary root and little else** — laterals only
   begin at 1–2 years, prop roots at 3–5. `growth.py` gates branch order by the
   plant's age, so the pod is not loaded years early. (`proproots.py` builds the
   prop-root cage for multi-year windows, where it is the right structure.)
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

| material | fracture strength | fatigue *n* | wet loss → floor | biodegradable |
|---|---|---|---|---|
| **PHA / PHBV** (marine-degradable) | **32 MPa (25–58)** | 12 | 6 %/mo → holds 68% | ✅ marine-biodegradable |
| **PLA** (industrial-compost only) | **55 MPa (45–70)** | 14 | 0.4 %/mo → holds 90% | ⚠️ **not marine-degradable** |
| **Clay** (low-fired earthenware) | **5.5 MPa (2.0–9.5)** | 30 | 3 %/mo → holds 55% | ✅ inert mineral, benign |
| **Concrete** (unreinforced, thin-wall) | **3.2 MPa (2.2–4.2)** | 24 | 0.6 %/mo → holds 72% | ⚠️ **not biodegradable — persistent** |

All four are now **published values**, not class-level guesses: measured PHBV is
27–33 MPa (neat PHA reaches ~58); clay flexural spans 2.0–9.5; unreinforced
concrete tensile 2.2–4.2. Degradation **plateaus** rather than sliding to zero —
marine PHBV drops ~25% early then holds 17–22 MPa of an initial 27 — so each
material carries a strength floor.

PHA and PLA are **separate presets with separate claims**: PHA genuinely
biodegrades in seawater, PLA needs industrial-composting heat and persists over
the establishment window. Both PLA and concrete carry a visible **UI warning**.
A material enters the physics directly, in real units: its fracture strength *is*
the wall capacity the computed stress is compared against, decaying over elapsed
time with wet degradation, and its fatigue exponent *n* decides whether a wall
held just under strength eventually fails (low *n*, polymers) or effectively never
does (high *n*, ceramics).

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

| feature | value (model units, read as **millimetres**) |
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
  growth.py       architectural seedling-root growth: taproot + acropetal laterals
  perforation.py  parametric slots + base split-lines + quarter-piece seams -> net scored section
  pressure.py     inflate roots over time -> wall stress in MPa -> failure (SimParams, phys)
  montecarlo.py   many randomized runs (architecture + strength + pressure + wall tolerance)
  materials.py    PHA / PLA / Clay / Concrete presets (all engineering estimates)
  species.py      Rhizophora / Avicennia growth calibration (real-time, slow-start ramp)
  physical.py     material/species/root-pressure -> per-step drive & capacity in MPa; Calibration Mode
  provenance.py   mechanics constants + registry of every constant tagged proven vs. estimated
  viz.py          matplotlib renders + Plotly interactive heatmaps
run_01..run_05    scripts for the pipeline stages (05 = per-material/species report)
webapp/           Flask web app (app.py) + static/ + templates/
start_web.bat     one-click launcher for the web app (Windows)
pod_mesh.ply      cached welded mesh (regenerated from the .3dm on first run)
outputs/          all generated figures, interactive HTML, and pod_features.json
```

## How the failure model works (so you can trust / tune it)

> **Two engines, one model.** The live browser tool (`docs/static/engine.js`) and
> the Python package under `mangrovesim/` run the same shell-mechanics model in
> real MPa, on the same year-one root system (125 nodes, primary root only), and
> agree on every release verdict: PHA and PLA never open inside 12 months, clay
> and concrete only late and marginally.
>
> **Known gap:** absolute governing seam stress still differs — ~3.7 MPa in the
> browser against ~1.6–1.8 MPa in Python. The two are not yet doing identical
> arithmetic on the loaded-width calculation. Material *ranking* is unaffected;
> do not quote either to the megapascal until this is closed.

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
- **Crack propagation.** Two mechanisms. Once a fraction φ of a seam's z-bands
  have cracked the survivors carry the whole section (`σ ×= 1/(1−φ)`, capped at
  8×); and the band at a crack *front* is driven by the stress **intensity**
  there, `K = Y·σ_drive·√a`, where `a` is the crack already formed and `σ_drive`
  is the **nominal** section stress `σ/SCF` — not the peak, which sits at the
  slot-tip raiser and already carries the concentration. Net-section alone cannot
  propagate a crack started by a *discrete* load: one cracked band of eight gives
  only 1.14×, and the bands either side of a point load carry almost no stress.
  The K term is what lets a single prop root punching through the wall open a
  whole seam.
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

### The root system that loads the wall

**Root development is paced to real growth stages, and this dominates
everything else.** Field stages for *Rhizophora*: 0–1 yr the **primary root**
develops; 1–2 yr lateral roots *begin* to form; 2–3 yr they become numerous;
3–5 yr prop roots start. Branch order is therefore gated by the plant's age, not
by arc length — otherwise a 12-month window grows a three-year root system and
loads the pod years early.

Over a 12-month window the model produces what a 12-month plant actually has:
**125 nodes, branch order 0 only, the primary root, 2.4 mm at its thickest.**
Within that, the architecture is still explicit — a steeply gravitropic taproot
relaxing toward its set-point angle, correlated-random-walk tortuosity, and
mechanical deflection along the wall (a root cannot bore through it, so it
deflects and slides, with friction damping the slide).

Two timing corrections matter as much as the architecture:

- **Roots do not appear on contact.** Field observation puts emergence at
  **19–68 days** after stranding, sooner on sediment than in standing water. The
  pod carries *no* root load for the first ~6 weeks.
- **A root does not pressurise a whole panel.** The plate-bending term
  `β·(L/t)²` is Roark's case for pressure spread *uniformly* over a panel of
  width L. A root bears on a patch a few mm across, so the bending span is
  capped at the width actually loaded. Using the full 39 mm sector width
  overstated bending by ~4×, and worst exactly when the seedling is youngest.

`proproots.py` still builds the prop-root cage, bit-identically in both engines,
but it is a **3–5 year** structure and is not the load source for a 12-month
window.

### Four bonded pieces, and what the holes actually do

The pod is moulded as **4 quarter-pieces bonded along the seams**, not carved
from one shell, and a joint reaches only a fraction of the parent wall's
strength. That fraction — `seam_bond_efficiency` — is what the seam fails at,
and it is a strong lever:

| bond efficiency | effect |
|---|---|
| 1.00 (a perfect weld — i.e. monolithic) | no benefit at all |
| 0.55 (typical adhesive/weld, the default) | seam fails at ~55% of parent strength |
| 0.25 (weak mortar / slip joint) | seam fails at ~25% |

Note the top row: **four pieces do not help on their own.** At 100% joint
efficiency the pod behaves exactly like a one-piece shell. A bonded seam buys a
*deliberately weak* line — but with a year-one root system the wall is nowhere
near failing anyway, so bond efficiency shifts nothing inside 12 months. It
becomes a real lever only once the load is large enough to threaten the seam,
i.e. over a multi-year window.

**The slots** help in two ways the model already counts: they remove
load-bearing section, and their tips carry a 3x stress raiser that initiates the
crack. But they help through slot **length** — a longer slot leaves a shorter
ligament to tear — *not* width. Once a wide seam is scored, the seam and not the
slot sets the ligament, which is why `wider-slots` and `narrower-slots` return
identical results in `run_04` (in both engines — it is a real property of the
model, not a bug).

### What the model now concludes

**A first-year root system cannot open this pod.** With root development paced
to real growth stages, the governing seam stress is **~1.6–1.8 MPa** against
21.8 MPa of remaining PHA strength — the wall is loaded to about **8%** of
capacity. Over a 12-month window, at the 85% seam-scoring default:

| material | strength at 12 mo | releases in 12 months |
|---|---|---|
| **PHA / PHBV** | 21.8 MPa | **never** |
| **PLA** | 52.4 MPa | **never** |
| **clay** | 3.5 MPa | only late and marginally (~8–10 mo) |
| **concrete** | 3.0 MPa | only late and marginally (~8–9 mo) |

Nothing cracks before ~4.5 months in any material, and at 3–4 months the pod is
intact everywhere — consistent with a real 4-month-old propagule, which has a
primary root and little else.

**This moves the design question.** Release inside a 12-month window has to come
from **the wall degrading on schedule, not from the roots pushing** — the root
load is an order of magnitude short. Seam scoring, the strongest geometric lever
in the model, cannot bridge that gap on its own. Either:

- the pod is engineered to **dissolve** on schedule, making wall thickness and
  the PHA formulation the design variables (note PHA's marine degradation is
  *surface erosion*, ~0.1–0.15 mm/month per exposed face, which on a 3.75 mm
  scored seam removes most of the section in a year — a thinning mechanism the
  model does **not** yet include); or
- the release window is **2–3 years**, by which point laterals and then prop
  roots genuinely exist and root pressure becomes a real actuator.

Earlier versions of this README reported release at ~month 4–6. Those numbers
credited the seedling with years of root development it has not done.

### Main tunable knobs

`GrowthParams`: `step_size`, `n_attractors` (overall root *density*), `n_seeds`,
`down_bias` (gravitropism strength), `slot_bias`, `wall_bias`, `jitter`
(tortuosity); architecture — `max_order`, `branch_angle_deg`, `lateral_spacing`,
`length_falloff`, `apical_unbranched`; the basal anchoring zone —
`basal_zone_frac`, `basal_flare`, `basal_branch_factor`, `basal_lateral_len`;
wall interaction — `wall_friction`, `wall_seek_frac`; thickening — `tip_radius`,
`pipe_exponent`, `radius_gain`, `order_radius_falloff`.

`SimParams`: `n_time_steps`, `maturation`, `swell_rate`, `max_swell`,
`contact_stiffness` (sets the indentation δ₀ at which a root reaches full bearing
pressure), `base_wedge`, `span_frac`, `breakthrough_frac`, `pull_assist` (an extra
bearing pressure in MPa below the waist, modelling a planting team helping the pod
open).

Mechanics constants (`mangrovesim/provenance.py`, mirrored at the top of
`engine.js`): `MM_PER_UNIT` (unit scale), `PLATE_BETA`, `T_REF_MONTHS`
(static-fatigue reference), `MIN_T_EFF_MM`, `NET_SECTION_FLOOR`, and each
material's `fatigue_exponent`.

`PerforationPattern.parametric(...)`: `n_slots`, `slot_length_frac`,
`slot_width_deg`, `slot_z_center_frac`, `theta_offset_deg`, `align` ("feet" or
"split"), `split_depth_frac`, `split_score`, `seam_score`, `seam_width_deg`.

**Scoring dominates.** Because stress goes as 1/t for hoop and 1/t² for bending,
`seam_score` is by far the strongest lever — and once a wide seam band is scored
it, not the slot, sets the ligament, so `slot_width_deg` and `split_score` stop
moving the release at all. Both engines behave this way; `run_04` includes
`shallow-seam` / `deeper-seam` variants to show the effect that does matter.

---

## Caveats

- Both engines read the model's units as **millimetres** (334 mm pod, ⌀26 mm
  bore, ~21 mm wall). Every stress they report is a real MPa and every one of
  them scales with that assumption, so confirm it against the physical prototype
  before quoting a number. Breakthrough is reported both as a time-step and as
  real elapsed months of the species growth window.
- The extracted mesh is Rhino's render tessellation and is not watertight at the
  slot cuts; this is fine for wall-contact pressure but means volumes/normals near
  slot edges are approximate.
- Material strengths, the root pressure and the fatigue exponents are engineering
  estimates for a material *class*, not measured properties of your formulation.
  Plug in real values (and ideally an FEA cross-check) before trusting absolute
  margins.
- The **material and species constants are engineering estimates**, not datasheet
  or pod-measured values; the material→physics coupling is a *relative* mapping,
  not calibrated absolute physics. The Data-provenance panel tags each constant,
  and the Validation-roadmap explains what physical testing is required before
  these drive a real production decision.
