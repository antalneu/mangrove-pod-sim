"""
Local web app for the mangrove-pod root-growth break-away simulation.

Run from the project root:
    .venv\\Scripts\\python webapp\\app.py
then open http://127.0.0.1:5000

The pod mesh is loaded once at startup; each request grows roots, runs the
pressure/failure simulation for the chosen perforation pattern, and returns an
interactive Plotly figure plus the break statistics.
"""
import os
import sys
import json

import numpy as np
from flask import Flask, render_template, request, jsonify, send_from_directory

# make the project package importable when run as `python webapp/app.py`
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from mangrovesim.podmesh import PodMesh
from mangrovesim import growth, perforation as perf, pressure as pr, montecarlo as mc, viz
from mangrovesim import materials as materials_mod, species as species_mod, provenance
from mangrovesim import render3d
from mangrovesim.physical import PhysicalContext

app = Flask(__name__)
STATIC = os.path.join(os.path.dirname(__file__), "static")

# ----------------------------------------------------------------------------- #
#  load pod once
# ----------------------------------------------------------------------------- #
PLY = os.path.join(ROOT, "pod_mesh.ply")
SRC = os.path.join(ROOT, "mangrovepod.3dm")
print("Loading pod ...")
POD = PodMesh.from_ply(PLY) if os.path.exists(PLY) else PodMesh.from_3dm(SRC, cache_ply=PLY)
POD.wall_thickness_field()   # warm the cache
print(POD.summary())

# write plotly.js locally so the page needs no network
PLOTLY_JS = os.path.join(STATIC, "plotly.min.js")
if not os.path.exists(PLOTLY_JS):
    try:
        from plotly.offline import get_plotlyjs
        with open(PLOTLY_JS, "w", encoding="utf-8") as fh:
            fh.write(get_plotlyjs())
        print("wrote", PLOTLY_JS)
    except Exception as e:
        print("could not write plotly.js:", e)


# ----------------------------------------------------------------------------- #
#  helpers
# ----------------------------------------------------------------------------- #
def build_pattern(cfg):
    """Build a PerforationPattern from a request config dict."""
    kind = cfg.get("pattern", "as-drawn")
    if kind == "as-drawn":
        pat = perf.PerforationPattern.detected(POD, name="as-drawn")
        if cfg.get("seam_score") not in (None, ""):
            pat.seam_score = float(cfg["seam_score"])
        if cfg.get("seam_width_deg") not in (None, ""):
            pat.seam_width_deg = float(cfg["seam_width_deg"])
        return pat
    kw = {}
    for key in ("n_slots",):
        if cfg.get(key) is not None:
            kw[key] = int(cfg[key])
    for key in ("slot_length_frac", "slot_width_deg", "slot_z_center_frac",
                "theta_offset_deg", "split_score", "split_depth_frac",
                "seam_score", "seam_width_deg"):
        if cfg.get(key) is not None and cfg.get(key) != "":
            kw[key] = float(cfg[key])
    kw["align"] = cfg.get("align", "feet")
    return perf.PerforationPattern.parametric(POD, name=cfg.get("name", "custom"), **kw)


def growth_params(cfg):
    gp = growth.GrowthParams()
    for key in ("down_bias", "slot_bias", "wall_bias", "step_size"):
        if cfg.get(key) is not None and cfg.get(key) != "":
            setattr(gp, key, float(cfg[key]))
    if cfg.get("n_attractors"):
        gp.n_attractors = int(cfg["n_attractors"])
    return gp


def sim_params(cfg):
    sp = pr.SimParams()
    for key in ("contact_stiffness", "base_wedge", "pull_assist", "span_frac"):
        if cfg.get(key) is not None and cfg.get(key) != "":
            setattr(sp, key, float(cfg[key]))
    if cfg.get("n_time_steps"):
        sp.n_time_steps = int(cfg["n_time_steps"])
    return sp


def physical_ctx(cfg):
    """Build the physical (material/species/root-pressure/calibration) context."""
    return PhysicalContext.from_config(cfg)


def jgz(obj):
    """Plain JSON response with an explicit Content-Length (served by waitress,
    which streams large bodies reliably)."""
    raw = json.dumps(obj).encode("utf-8")
    resp = app.response_class(raw, mimetype="application/json")
    resp.headers["Content-Length"] = str(len(raw))
    return resp


def fig_json(fig):
    return json.loads(fig.to_json())


def vertex_intensity(field, project_outer=False, log=False):
    """Per-vertex scalar (rounded to keep the payload small) + colour scale max."""
    f = field
    if project_outer:
        f = viz.project_inner_to_outer(POD, np.asarray(field, float))
    vv = viz.face_field_to_vertex(POD, f, log=log)
    vmax = float(np.percentile(vv[vv > 0], 99)) if np.any(vv > 0) else 1.0
    return np.round(vv, 2).tolist(), max(vmax, 1e-9)


def root_tubes(roots):
    """Tapered tube mesh (x/y/z + i/j/k) for a realistic 3-D root overlay."""
    return render3d.root_tube_mesh(roots)


# ----------------------------------------------------------------------------- #
#  routes
# ----------------------------------------------------------------------------- #
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/static/<path:fn>")
def static_files(fn):
    return send_from_directory(STATIC, fn)


@app.route("/api/features")
def api_features():
    f = POD.features
    return jgz({
        "height": f.height, "outer_r_waist": f.outer_r_waist,
        "inner_r_waist": f.inner_r_waist, "wall_thickness": f.wall_thickness_median,
        "z_waist_lo": f.z_waist_lo, "z_waist_hi": f.z_waist_hi,
        "n_slots": len(f.slots), "n_feet": len(f.feet),
        "slots": [{"theta": s.theta_deg, "z_lo": s.z_lo, "z_hi": s.z_hi,
                   "width": s.width_deg} for s in f.slots],
        "feet": [{"theta": ft.theta_deg, "tip_radius": ft.tip_radius} for ft in f.feet],
        "splits": f.split_line_deg,
        "n_faces": int(len(POD.F)), "n_verts": int(len(POD.V)),
    })


@app.route("/api/materials")
def api_materials():
    return jgz({"materials": materials_mod.materials_payload(),
                "default": materials_mod.DEFAULT_MATERIAL})


@app.route("/api/species")
def api_species():
    return jgz({"species": species_mod.species_payload(),
                "default": species_mod.DEFAULT_SPECIES})


@app.route("/api/provenance", methods=["POST", "GET"])
def api_provenance():
    cfg = request.get_json(force=True, silent=True) or {}
    phys = physical_ctx(cfg)
    reg = provenance.build_registry(
        POD, material=phys.material, species=phys.species,
        root_pressure_mpa=phys.root_pressure_mpa,
        calibration={"active": phys.calibration_active})
    return jgz(reg)


@app.route("/api/base_figure")
def api_base_figure():
    """Pod coloured by region (no simulation yet)."""
    lab = POD.region_labels().astype(float)
    fig = viz.build_pressure_figure(POD, np.zeros(len(POD.F)),
                                    title="Mangrove pod")
    # recolour by region instead of stress
    vert_reg = viz.face_field_to_vertex(POD, lab)
    fig.data[0].intensity = vert_reg
    fig.data[0].colorscale = [[0.0, "#b5834a"], [0.2, "#9fb0bf"], [0.4, "#4a76b5"],
                              [0.6, "#d63b3b"], [0.8, "#9fb0bf"], [1.0, "#5aa469"]]
    fig.data[0].showscale = False
    fig.data[0].cmin = 0
    fig.data[0].cmax = 5
    # richer shading so the trumpet/waist/feet silhouette reads on its own
    fig.data[0].lighting = dict(ambient=0.42, diffuse=0.9, specular=0.18,
                                roughness=0.55, fresnel=0.15)
    fig.data[0].lightposition = dict(x=180, y=260, z=520)
    fig.data[0].flatshading = False
    # Plotly encodes the numpy arrays as compact base64 typed-arrays; gzip does
    # the rest. Plotly.js on the client understands this encoding natively.
    return jgz(fig_json(fig))


@app.route("/api/seams")
def api_seams():
    """The 4 always-visible seam lines (rim -> slot -> foot) as a raised tube mesh."""
    return jgz({"seams": render3d.seam_tube_mesh(POD),
                "angles": render3d.seam_angles_deg(POD)})


@app.route("/api/exploded")
def api_exploded():
    """The pod wall split into its 4 quarter-pieces, pushed apart along the seams.
    Each sector carries per-vertex original indices so a stress field can be
    re-applied client-side."""
    return jgz({"sectors": render3d.exploded_sectors(POD)})


@app.route("/api/simulate", methods=["POST"])
def api_simulate():
    cfg = request.get_json(force=True)
    pattern = build_pattern(cfg)
    gp = growth_params(cfg)
    sp = sim_params(cfg)
    phys = physical_ctx(cfg)
    seed = int(cfg.get("seed", 1))
    show_roots = bool(cfg.get("show_roots", True))
    project_outer = bool(cfg.get("project_outer", False))

    wm = pr.WallModel(POD, pattern.build_fields(POD))
    roots = growth.grow(POD, gp, seed=seed)
    res = pr.run_simulation(POD, wm, roots, sp, phys=phys)

    field = res.cum_stress_faces()
    intensity, cmax = vertex_intensity(field, project_outer=project_outer)
    # always return the root tubes; the client toggles their visibility
    roots_payload = root_tubes(roots)

    T = sp.n_time_steps
    sites = []
    for i, lab in enumerate(res.site_labels):
        step = res.site_activation_step[i]
        sites.append({
            "label": lab,
            "is_ligament": bool(wm.is_ligament[i]),
            "activation_step": None if not np.isfinite(step) else int(step),
        })
    stats = {
        "n_nodes": int(len(roots.nodes)),
        "first_crack_step": None if not np.isfinite(res.first_crack_step) else int(res.first_crack_step),
        "first_crack_site": res.site_labels[res.first_crack_site] if res.first_crack_site >= 0 else None,
        "breakthrough_step": None if not np.isfinite(res.breakthrough_step) else int(res.breakthrough_step),
        "n_time_steps": T,
        "activation_order": [res.site_labels[s] for s in res.activation_order],
        "sites": sites,
        "pattern": pattern.name,
        "slots": [{"theta": s.theta_deg, "z_lo": s.z_lo, "z_hi": s.z_hi,
                   "width": s.width_deg} for s in pattern.slots],
        # --- physical context: real elapsed time + material/species ---
        "physical": phys.summary(),
        "breakthrough_time": phys.elapsed_context(res.breakthrough_step, T),
        "first_crack_time": phys.elapsed_context(res.first_crack_step, T),
        "window_time": phys.elapsed_context(T, T),
        "material_card": phys.material.as_dict(),
    }
    return jgz({"intensity": intensity, "cmax": cmax,
                    "roots": roots_payload, "stats": stats})


@app.route("/api/montecarlo", methods=["POST"])
def api_montecarlo():
    cfg = request.get_json(force=True)
    pattern = build_pattern(cfg)
    gp = growth_params(cfg)
    sp = sim_params(cfg)
    phys = physical_ctx(cfg)
    n_runs = int(cfg.get("n_runs", 24))
    n_runs = max(2, min(n_runs, 120))

    r = mc.run_montecarlo(POD, pattern, n_runs=n_runs, gparams=gp, sparams=sp,
                          growth_jitter_scale=0.5, phys=phys)
    rep = growth.grow(POD, gp, seed=7)
    intensity, cmax = vertex_intensity(r.mean_cum_stress_faces)
    roots_payload = root_tubes(rep)

    from collections import Counter
    orders = Counter(" → ".join(r.site_labels[s] for s in o[:3])
                     for o in r.activation_orders if o)
    stats = {
        "pattern": pattern.name,
        "n_runs": n_runs,
        "reliability": r.reliability(),
        "mean_breakthrough": None if not np.isfinite(r.mean_breakthrough()) else r.mean_breakthrough(),
        "std_breakthrough": None if not np.isfinite(r.std_breakthrough()) else r.std_breakthrough(),
        "mean_first_crack": None if not np.isfinite(r.mean_first_crack()) else r.mean_first_crack(),
        "n_time_steps": sp.n_time_steps,
        "first_site_counts": r.first_site_counts(),
        "site_activation_rate": r.site_activation_rate(),
        "mean_site_activation_step": {k: (None if not np.isfinite(v) else v)
                                      for k, v in r.mean_site_activation_step().items()},
        "top_orders": orders.most_common(5),
        "breakthrough_samples": [None if not np.isfinite(x) else float(x)
                                 for x in r.breakthrough],
        "first_crack_samples": [None if not np.isfinite(x) else float(x)
                                for x in r.first_crack],
        # --- physical context ---
        "physical": phys.summary(),
        "breakthrough_time": phys.elapsed_context(r.mean_breakthrough(), sp.n_time_steps),
        "window_time": phys.elapsed_context(sp.n_time_steps, sp.n_time_steps),
        "material_card": phys.material.as_dict(),
    }
    return jgz({"intensity": intensity, "cmax": cmax,
                    "roots": roots_payload, "stats": stats})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  Open  http://127.0.0.1:{port}\n")
    try:
        from waitress import serve
        serve(app, host="127.0.0.1", port=port, threads=8)
    except ImportError:
        app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
