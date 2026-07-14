"""
viz.py
======
Visualization for the mangrove-pod simulation.

- render_confirmation : static multi-panel figure proving the mesh parsed and the
                        waist slots / base feet / split-lines were detected.
- render_pressure_png : matplotlib 3-D render of the pod coloured by a per-face
                        scalar field (pressure / cumulative stress / failure).
- pressure_heatmap_html : self-contained interactive Plotly 3-D heatmap.
- render_root_system    : overlay the grown root network inside a translucent pod.
"""
from __future__ import annotations

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection, Line3DCollection


REGION_COLORS = {
    0: "#b5834a",  # base / feet   (brown)
    1: "#9fb0bf",  # lower body     (grey-blue)
    2: "#4a76b5",  # waist wall     (blue)
    3: "#d63b3b",  # slot           (red)
    4: "#9fb0bf",  # upper body     (grey-blue)
    5: "#5aa469",  # trumpet        (green)
}


def _set_equal_pod_axes(ax, pod):
    H = pod.features.height
    rmax = max(np.hypot(pod.V[:, 0], pod.V[:, 1]).max(), 1.0)
    ax.set_xlim(-rmax, rmax)
    ax.set_ylim(-rmax, rmax)
    ax.set_zlim(0, H)
    ax.set_box_aspect((1, 1, H / (2 * rmax)))
    ax.set_axis_off()


def _add_mesh(ax, pod, facecolors, alpha=1.0, edge=False):
    tris = pod.V[pod.F]
    pc = Poly3DCollection(tris, alpha=alpha)
    pc.set_facecolor(facecolors)
    if edge:
        pc.set_edgecolor((0, 0, 0, 0.10))
        pc.set_linewidth(0.05)
    else:
        pc.set_edgecolor("none")
    ax.add_collection3d(pc)
    return pc


def render_confirmation(pod, path, title="Mangrove pod - parse & feature check"):
    """4-panel confirmation: two 3-D region renders, an unwrapped (theta,z)
    slot map, and a base top-down foot/split map."""
    f = pod.features
    lab = pod.region_labels()
    fcolors = np.array([matplotlib.colors.to_rgba(REGION_COLORS[l]) for l in lab])

    fig = plt.figure(figsize=(17, 8))

    for i, (el, az, ttl) in enumerate([(18, -65, "perspective"),
                                       (6, 0, "front (slot + feet)")]):
        ax = fig.add_subplot(2, 3, 1 + i * 3, projection="3d")
        _add_mesh(ax, pod, fcolors, alpha=1.0)
        _set_equal_pod_axes(ax, pod)
        ax.view_init(elev=el, azim=az)
        ax.set_title(ttl, fontsize=10)

    # --- unwrapped waist slot map ---
    ax3 = fig.add_subplot(2, 3, 2)
    th = np.degrees(pod.theta_face)
    outer = pod.radial_dot > 0.4
    sc = ax3.scatter(th[outer], pod.z_face[outer], s=3,
                     c=pod.r_face[outer], cmap="viridis")
    for s in f.slots:
        ax3.add_patch(plt.Rectangle((s.theta_deg - s.width_deg / 2, s.z_lo),
                                    s.width_deg, s.z_hi - s.z_lo,
                                    fill=False, edgecolor="red", lw=2))
        ax3.text(s.theta_deg, s.z_hi + 8, f"{s.theta_deg:.0f}°",
                 color="red", ha="center", fontsize=8)
    for ft in f.feet:
        ax3.axvline(ft.theta_deg, color="brown", ls=":", lw=0.8)
    ax3.set_xlim(-180, 180)
    ax3.set_xlabel("theta (deg)")
    ax3.set_ylabel("z")
    ax3.set_title(f"unwrapped outer wall - {len(f.slots)} slots (red)", fontsize=10)

    # --- base top-down feet + split lines ---
    ax4 = fig.add_subplot(2, 3, 5)
    base = pod.z_face < f.z_base_top * 1.2
    ax4.scatter(pod.face_centers[base, 0], pod.face_centers[base, 1],
                s=3, c=pod.z_face[base], cmap="plasma")
    rmax = max(ft.tip_radius for ft in f.feet) if f.feet else 100
    for ft in f.feet:
        a = np.radians(ft.theta_deg)
        ax4.plot([0, ft.tip_radius * np.cos(a)], [0, ft.tip_radius * np.sin(a)],
                 color="brown", lw=2)
        ax4.text(ft.tip_radius * 1.05 * np.cos(a), ft.tip_radius * 1.05 * np.sin(a),
                 "foot", color="brown", ha="center", fontsize=8)
    for a in f.split_line_deg:
        ar = np.radians(a)
        ax4.plot([0, rmax * 1.1 * np.cos(ar)], [0, rmax * 1.1 * np.sin(ar)],
                 color="red", ls="--", lw=1.5)
    ax4.set_aspect("equal")
    ax4.set_title("base: feet (brown) + split-lines (red)", fontsize=10)
    ax4.set_xlabel("x")
    ax4.set_ylabel("y")

    # --- legend / text panel ---
    ax5 = fig.add_subplot(2, 3, 3)
    ax5.axis("off")
    ax5.set_title("regions", fontsize=10)
    names = {0: "base / feet", 2: "waist wall", 3: "slot perforation",
             4: "body", 5: "trumpet opening"}
    for j, (k, nm) in enumerate(names.items()):
        ax5.add_patch(plt.Rectangle((0.05, 0.85 - j * 0.16), 0.12, 0.10,
                                    color=REGION_COLORS[k]))
        ax5.text(0.22, 0.90 - j * 0.16, nm, fontsize=10, va="center")
    ax5.set_xlim(0, 1)
    ax5.set_ylim(0, 1)

    ax6 = fig.add_subplot(2, 3, 6)
    ax6.axis("off")
    info = pod.summary()
    ax6.text(0.0, 1.0, info, fontsize=7.2, family="monospace", va="top")

    fig.suptitle(title, fontsize=13)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return path


def project_inner_to_outer(pod, face_field):
    """Give every face the stress of its nearest inner-wall face, so the stress
    computed on the inner wall can be shown on the (visible) outer surface."""
    from scipy.spatial import cKDTree
    inner_idx = np.where(pod.inner_mask)[0]
    if len(inner_idx) == 0:
        return face_field
    tree = cKDTree(pod.face_centers[inner_idx])
    _, loc = tree.query(pod.face_centers, k=1)
    return face_field[inner_idx][loc]


def render_pressure_outer(pod, inner_field, path, title="wall stress (outer view)",
                          cmap="inferno", views=((16, -60), (16, 60), (16, 180))):
    """Opaque outer-surface heatmap of an inner-wall scalar field."""
    proj = project_inner_to_outer(pod, inner_field)
    return render_pressure_png(pod, proj, path, title=title, cmap=cmap, views=views)


def render_pressure_png(pod, face_values, path, title="wall pressure",
                        cmap="inferno", views=((18, -65), (18, 115)),
                        roots=None, log=False):
    """Render the pod coloured by a per-face scalar (e.g. cumulative stress)."""
    v = np.asarray(face_values, float).copy()
    if log:
        v = np.log1p(np.maximum(v, 0))
    vmax = np.percentile(v[v > 0], 99) if np.any(v > 0) else 1.0
    vmax = max(vmax, 1e-9)
    norm = matplotlib.colors.Normalize(0, vmax)
    cm = matplotlib.colormaps[cmap]
    base = matplotlib.colors.to_rgba("#d9d9d9")
    fcolors = cm(norm(v))
    fcolors[v <= 1e-9] = base

    fig = plt.figure(figsize=(7 * len(views), 8))
    for i, (el, az) in enumerate(views):
        ax = fig.add_subplot(1, len(views), i + 1, projection="3d")
        _add_mesh(ax, pod, fcolors, alpha=(0.55 if roots is not None else 1.0))
        if roots is not None:
            _add_roots(ax, roots)
        _set_equal_pod_axes(ax, pod)
        ax.view_init(elev=el, azim=az)
    sm = plt.cm.ScalarMappable(norm=norm, cmap=cm)
    sm.set_array([])
    cbar = fig.colorbar(sm, ax=fig.axes, shrink=0.55, pad=0.02)
    cbar.set_label(("log " if log else "") + "cumulative stress")
    fig.suptitle(title, fontsize=13)
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return path


def _add_roots(ax, roots, color="#f5f0d0"):
    segs = roots.segments()
    if len(segs):
        lc = Line3DCollection(segs, colors=color, linewidths=0.6, alpha=0.9)
        ax.add_collection3d(lc)


def render_root_system(pod, roots, path, title="root growth in pod"):
    lab = pod.region_labels()
    fcolors = np.array([matplotlib.colors.to_rgba(REGION_COLORS[l]) for l in lab])
    fcolors[:, 3] = 0.18
    fig = plt.figure(figsize=(14, 8))
    for i, (el, az) in enumerate([(15, -65), (15, 115)]):
        ax = fig.add_subplot(1, 2, i + 1, projection="3d")
        _add_mesh(ax, pod, fcolors, alpha=0.18)
        _add_roots(ax, roots, color="#8a5a2b")
        _set_equal_pod_axes(ax, pod)
        ax.view_init(elev=el, azim=az)
    fig.suptitle(title, fontsize=13)
    fig.tight_layout()
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return path


def render_results_analysis(pod, mcresult, pattern, path,
                            title="break analysis"):
    """4-panel results figure for one Monte-Carlo batch:
    outer heatmap, unwrapped stress with slot boxes, per-site activation, and a
    breakthrough-time histogram."""
    field = mcresult.mean_cum_stress_faces
    proj = project_inner_to_outer(pod, field)

    fig = plt.figure(figsize=(16, 9))

    # A: outer heatmap (one view)
    axA = fig.add_subplot(2, 2, 1, projection="3d")
    v = proj.copy()
    vmax = np.percentile(v[v > 0], 99) if np.any(v > 0) else 1.0
    norm = matplotlib.colors.Normalize(0, max(vmax, 1e-9))
    cm = matplotlib.colormaps["inferno"]
    fcolors = cm(norm(v))
    fcolors[v <= 1e-9] = matplotlib.colors.to_rgba("#d9d9d9")
    _add_mesh(axA, pod, fcolors, alpha=1.0)
    _set_equal_pod_axes(axA, pod)
    axA.view_init(elev=16, azim=-60)
    axA.set_title("mean cumulative wall stress (outer surface)", fontsize=10)

    # B: unwrapped inner-wall stress with slot + ligament overlay
    axB = fig.add_subplot(2, 2, 2)
    inner = pod.inner_mask
    th = np.degrees(pod.theta_face)[inner]
    z = pod.z_face[inner]
    fv = field[inner]
    sc = axB.scatter(th, z, c=fv, s=5, cmap="inferno",
                     vmax=np.percentile(fv[fv > 0], 99) if np.any(fv > 0) else 1)
    for s in pattern.slots:
        axB.add_patch(plt.Rectangle((s.theta_deg - s.width_deg / 2, s.z_lo),
                                    s.width_deg, s.z_hi - s.z_lo, fill=False,
                                    edgecolor="cyan", lw=1.5))
    axB.axhline(pod.features.z_base_top, color="w", ls=":", lw=0.8)
    axB.set_xlim(-180, 180)
    axB.set_xlabel("theta (deg)")
    axB.set_ylabel("z")
    axB.set_title("unwrapped inner-wall stress (slots cyan)", fontsize=10)
    fig.colorbar(sc, ax=axB, shrink=0.8, label="cum. stress")

    # C: per-site activation rate + mean activation step
    axC = fig.add_subplot(2, 2, 3)
    labels = mcresult.site_labels
    rate = mcresult.site_activation_rate()
    msteps = mcresult.mean_site_activation_step()
    x = np.arange(len(labels))
    bars = axC.bar(x, [rate[l] * 100 for l in labels],
                   color=["#d64545" if "slot" in l else "#4a76b5" for l in labels])
    axC.set_xticks(x)
    axC.set_xticklabels(labels, rotation=45, ha="right", fontsize=7)
    axC.set_ylabel("activation rate (%)")
    axC.set_title("which break sites activate (red=slot ligament, blue=split)",
                  fontsize=10)
    for i, l in enumerate(labels):
        s = msteps[l]
        if np.isfinite(s):
            axC.text(i, rate[l] * 100 + 2, f"t{s:.0f}", ha="center", fontsize=7)

    # D: breakthrough-time histogram
    axD = fig.add_subplot(2, 2, 4)
    bt = mcresult.breakthrough[np.isfinite(mcresult.breakthrough)]
    fc = mcresult.first_crack[np.isfinite(mcresult.first_crack)]
    if len(fc):
        axD.hist(fc, bins=12, alpha=0.6, color="#f0a020", label="first crack")
    if len(bt):
        axD.hist(bt, bins=12, alpha=0.6, color="#d64545", label="breakthrough")
    axD.set_xlabel("time step")
    axD.set_ylabel("runs")
    axD.legend()
    axD.set_title(f"timing over {mcresult.n_runs} runs "
                  f"(reliability {mcresult.reliability()*100:.0f}%)", fontsize=10)

    fig.suptitle(f"{title} - pattern '{mcresult.pattern_name}'", fontsize=13)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    return path


def face_field_to_vertex(pod, face_values, log=False):
    """Area-weighted face scalar -> per-vertex scalar for smooth shading."""
    v = np.asarray(face_values, float).copy()
    if log:
        v = np.log1p(np.maximum(v, 0))
    vert_val = np.zeros(len(pod.V))
    wsum = np.zeros(len(pod.V))
    fa = pod.face_area
    np.add.at(vert_val, pod.F[:, 0], v * fa)
    np.add.at(vert_val, pod.F[:, 1], v * fa)
    np.add.at(vert_val, pod.F[:, 2], v * fa)
    np.add.at(wsum, pod.F[:, 0], fa)
    np.add.at(wsum, pod.F[:, 1], fa)
    np.add.at(wsum, pod.F[:, 2], fa)
    return np.where(wsum > 0, vert_val / np.maximum(wsum, 1e-9), 0)


def build_pressure_figure(pod, face_values, title="Mangrove pod wall stress",
                          roots=None, log=False, project_to_outer=False):
    """Return a Plotly Figure of the pod coloured by a per-face scalar field
    (optionally with the root network overlaid). Reused by the HTML export and
    the web app."""
    import plotly.graph_objects as go

    field = face_values
    if project_to_outer:
        field = project_inner_to_outer(pod, np.asarray(face_values, float))
    vert_val = face_field_to_vertex(pod, field, log=log)
    vmax = np.percentile(vert_val[vert_val > 0], 99) if np.any(vert_val > 0) else 1.0

    # 4-stop calm -> warning -> critical scale (reads clearly at a glance)
    stress_scale = [[0.0, "#2f6f5e"], [0.35, "#e9c46a"],
                    [0.7, "#e76f51"], [1.0, "#c1121f"]]
    mesh3d = go.Mesh3d(
        x=pod.V[:, 0], y=pod.V[:, 1], z=pod.V[:, 2],
        i=pod.F[:, 0], j=pod.F[:, 1], k=pod.F[:, 2],
        intensity=vert_val, colorscale=stress_scale, cmin=0, cmax=max(vmax, 1e-9),
        showscale=True, opacity=1.0,
        colorbar=dict(title=("log stress" if log else "stress")),
        lighting=dict(ambient=0.42, diffuse=0.9, specular=0.18,
                      roughness=0.55, fresnel=0.15),
        lightposition=dict(x=180, y=260, z=520),
        flatshading=False,
        name="pod wall", hoverinfo="skip",
    )
    data = [mesh3d]
    if roots is not None:
        xs, ys, zs = [], [], []
        for (a, b) in roots.segments():
            xs += [a[0], b[0], None]
            ys += [a[1], b[1], None]
            zs += [a[2], b[2], None]
        data.append(go.Scatter3d(x=xs, y=ys, z=zs, mode="lines",
                                 line=dict(color="#c98a3a", width=2),
                                 name="roots", hoverinfo="skip"))
    fig = go.Figure(data=data)
    fig.update_layout(title=title, scene=dict(aspectmode="data"),
                      margin=dict(l=0, r=0, t=40, b=0))
    return fig


def pressure_heatmap_html(pod, face_values, path, title="Mangrove pod wall stress",
                          roots=None, log=False):
    """Self-contained interactive Plotly 3-D heatmap written to `path`."""
    fig = build_pressure_figure(pod, face_values, title=title, roots=roots, log=log)
    fig.write_html(path, include_plotlyjs=True, full_html=True)
    return path
