"use strict";
/* ============================================================================
 * engine.js — client-side port of the mangrove-pod break simulator
 * ----------------------------------------------------------------------------
 * A faithful JavaScript re-implementation of the Python engine (growth.py,
 * perforation.py, pressure.py, physical.py, materials/species/provenance,
 * render3d.py) so the whole tool runs in the browser with NO backend.
 *
 * The physics/logic mirror the Python 1:1 and use the same calibration
 * constants. The only unavoidable difference: JavaScript can't reproduce NumPy's
 * exact random stream, so for a given seed the specific root realisation differs
 * from Python — but the algorithm, constants and statistics are the same, so
 * results land in the same range. (Disclosed as the "tiny numeric drift".)
 * ========================================================================== */

// ---------------------------------------------------------------------------
//  small math helpers
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeNormal(rng) {
  let spare = null;
  return function () {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0, s = 0;
    do { u = 2 * rng() - 1; v = 2 * rng() - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = v * m; return u * m;
  };
}
function interp(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}
function angdiff(a, b) { return Math.abs(((a - b + 180) % 360 + 360) % 360 - 180); }
function clip(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function percentile(arr, p) {
  const a = Array.from(arr).filter(v => v > 0).sort((x, y) => x - y);
  if (!a.length) return 1;
  const idx = clip((p / 100) * (a.length - 1), 0, a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

// ---------------------------------------------------------------------------
//  uniform-grid spatial index (nearest + ball queries)
// ---------------------------------------------------------------------------
class Grid {
  constructor(pts, n, cell) {
    this.pts = pts; this.n = n; this.cell = cell; this.map = new Map();
    for (let i = 0; i < n; i++) {
      const k = this._key(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]);
      let a = this.map.get(k); if (!a) { a = []; this.map.set(k, a); } a.push(i);
    }
  }
  _key(x, y, z) {
    const c = this.cell;
    return Math.floor(x / c) + "|" + Math.floor(y / c) + "|" + Math.floor(z / c);
  }
  _d2(i, x, y, z) {
    const p = this.pts, dx = p[3 * i] - x, dy = p[3 * i + 1] - y, dz = p[3 * i + 2] - z;
    return dx * dx + dy * dy + dz * dz;
  }
  nearest(x, y, z, maxRing) {
    if (maxRing === undefined) maxRing = 200;
    const c = this.cell, cx = Math.floor(x / c), cy = Math.floor(y / c), cz = Math.floor(z / c);
    let best = -1, bd = Infinity;
    for (let ring = 0; ring <= maxRing; ring++) {
      if (best >= 0 && (ring - 1) * c > Math.sqrt(bd)) break;
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++)
          for (let dz = -ring; dz <= ring; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
            const a = this.map.get((cx + dx) + "|" + (cy + dy) + "|" + (cz + dz));
            if (!a) continue;
            for (let t = 0; t < a.length; t++) {
              const d = this._d2(a[t], x, y, z); if (d < bd) { bd = d; best = a[t]; }
            }
          }
    }
    return { idx: best, dist: Math.sqrt(bd) };
  }
  ball(x, y, z, r) {
    const c = this.cell, cr = Math.ceil(r / c), r2 = r * r;
    const cx = Math.floor(x / c), cy = Math.floor(y / c), cz = Math.floor(z / c), out = [];
    for (let dx = -cr; dx <= cr; dx++)
      for (let dy = -cr; dy <= cr; dy++)
        for (let dz = -cr; dz <= cr; dz++) {
          const a = this.map.get((cx + dx) + "|" + (cy + dy) + "|" + (cz + dz));
          if (!a) continue;
          for (let t = 0; t < a.length; t++) if (this._d2(a[t], x, y, z) <= r2) out.push(a[t]);
        }
    return out;
  }
}

// ---------------------------------------------------------------------------
//  pod geometry (derived from the exported static JSON)
// ---------------------------------------------------------------------------
let POD = null;

function buildPod(raw) {
  const V = Float64Array.from(raw.V), F = Int32Array.from(raw.F);
  const nV = raw.n_verts, nF = raw.n_faces;
  const cx = new Float64Array(nF), cy = new Float64Array(nF), cz = new Float64Array(nF);
  const rFace = new Float64Array(nF), thetaFace = new Float64Array(nF), zFace = new Float64Array(nF);
  const area = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
    const ax = V[3 * a], ay = V[3 * a + 1], az = V[3 * a + 2];
    const bx = V[3 * b], by = V[3 * b + 1], bz = V[3 * b + 2];
    const dx2 = V[3 * c], dy2 = V[3 * c + 1], dz2 = V[3 * c + 2];
    const mx = (ax + bx + dx2) / 3, my = (ay + by + dy2) / 3, mz = (az + bz + dz2) / 3;
    cx[f] = mx; cy[f] = my; cz[f] = mz;
    rFace[f] = Math.hypot(mx, my); thetaFace[f] = Math.atan2(my, mx); zFace[f] = mz;
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = dx2 - ax, e2y = dy2 - ay, e2z = dz2 - az;
    const crx = e1y * e2z - e1z * e2y, cry = e1z * e2x - e1x * e2z, crz = e1x * e2y - e1y * e2x;
    area[f] = 0.5 * Math.hypot(crx, cry, crz);
  }
  const radialDot = Float64Array.from(raw.radial_dot);
  const innerMask = new Uint8Array(nF), outerMask = new Uint8Array(nF), innerIdxArr = [];
  for (let f = 0; f < nF; f++) {
    if (radialDot[f] < -0.30) { innerMask[f] = 1; innerIdxArr.push(f); }
    if (radialDot[f] > 0.30) outerMask[f] = 1;
  }
  POD = {
    V, F, nV, nF, cx, cy, cz, rFace, thetaFace, zFace, area, radialDot,
    innerMask, outerMask, innerIdx: Int32Array.from(innerIdxArr),
    thickness: Float64Array.from(raw.thickness),
    features: raw.features, innerProf: raw.inner_prof, outerProf: raw.outer_prof,
  };
  return POD;
}
function rInnerAt(z) { return interp(POD.innerProf.z, POD.innerProf.r, z); }
function rOuterAt(z) { return interp(POD.outerProf.z, POD.outerProf.r, z); }

// ---------------------------------------------------------------------------
//  default parameter sets (match the Python dataclasses exactly)
// ---------------------------------------------------------------------------
const G_DEFAULT = {
  step_size: 7, n_attractors: 2600, max_steps: 200, n_seeds: 3,
  jitter: 0.30, down_bias: 0.55, slot_bias: 2.2, wall_bias: 0.75,
  seed_depth_frac: 0.92,
  // architecture
  max_order: 3, branch_angle_deg: 68, branch_angle_sd: 13,
  lateral_spacing: 31, length_falloff: 0.42, apical_unbranched: 16,
  // basal anchoring zone (the root ball that splays the feet)
  basal_zone_frac: 1.7, basal_flare: 0.55, basal_branch_factor: 0.60,
  basal_lateral_len: 46, wall_friction: 0.45, wall_seek_frac: 0.80,
  // thickening (pipe model)
  tip_radius: 1.4, pipe_exponent: 2.3, radius_gain: 1.7,
  order_radius_falloff: 0.72,
};
const S_DEFAULT = {
  n_time_steps: 120, growth_fraction: 0.6, maturation: 30, swell_rate: 0.012,
  max_swell: 2.6, contact_stiffness: 20, base_wedge: 0.6, contact_patch_factor: 1.6,
  min_patch_radius: 7, dt: 1, span_frac: 0.6,
  breakthrough_frac: 0.75, pull_assist: 0,
};
const MAT_PARAMS = {
  slot_tip_scf: 3, split_scf: 1.8, tip_zone: 22,
  ligament_halfwidth_deg: 26,
};

// ---------------------------------------------------------------------------
//  PHYSICAL SCALE + WALL MECHANICS
// ---------------------------------------------------------------------------
//  The Rhino model is authored in MILLIMETRES: the pod is 333.7 units tall
//  (334 mm), its bore is ⌀25.6 mm at the waist (a Rhizophora propagule is
//  ~15-25 mm across) and the feet span ⌀210 mm. Every pressure and stress below
//  is therefore a real MPa (N/mm²) — not a surrogate unit.
//
//  Wall stress under a locally-bearing root, per inner face:
//
//      σ = SCF · p · [  r_bore / t_eff        <- membrane hoop (thin shell)
//                     + β · (L_b / t_eff)² ]  <- transverse plate bending
//
//  where t_eff is the NET section left after scoring, and L_b is the span the
//  bending reacts over. An unscored shell is continuous, so local bending decays
//  over the shell boundary layer √(r·t); scoring vertical seams turns the wall
//  into panels hinged at the scores, and the whole sector width then reacts at
//  the hinge. L_b blends between the two with scoring depth. This is what gives
//  scoring its real, dominant t⁻² leverage.
// ---------------------------------------------------------------------------
const MM_PER_UNIT = 1.0;
// Clamped rectangular plate, peak bending stress σ = β·p·(L/t)² (Roark, clamped
// edges, a/b ≈ 1 → β ≈ 0.308).
const PLATE_BETA = 0.31;
// Static fatigue / subcritical crack growth: at σ = σ_f the section ruptures in
// T_REF_MONTHS; below that, time-to-rupture scales as (σ_f/σ)^n.
const T_REF_MONTHS = 0.5;
const MIN_T_EFF_MM = 0.15;          // a score cannot thin the wall below this
const NET_SECTION_FLOOR = 0.12;     // cap on net-section amplification (≈8×)
// Crack propagation, K = Y·σ·√(πa). What advances a crack front is the stress
// INTENSITY there — the load applied to the section times the square root of the
// crack already formed — not the stress that happens to sit ahead of the tip.
// That distinction decides whether a DISCRETE load can open a seam at all: a
// prop root driving through the wall at one point raises almost no stress in the
// next band along, so a local-stress rule stalls at one cracked band.
const CRACK_GEOM_Y = 1.15;          // geometry factor Y (order 1)
// Indentation at which a swelling root develops its full bearing pressure. Tied
// to the "contact stiffness" control so that slider keeps its meaning: a stiffer
// contact reaches full pressure after a smaller indentation.
function contactRefMm(stiffness) { return clip(10 / Math.max(stiffness, 1e-3), 0.12, 4); }

// ---------------------------------------------------------------------------
//  materials / species / provenance  (data + coupling)
// ---------------------------------------------------------------------------
const REF_ROOT_PRESSURE_MPA = 0.75;

const MATERIALS = {
  // PHA / PHBV — genuinely marine-biodegradable; the calibration reference
  // material — the design-intent baseline this whole project is built around.
  pha: {
    key: "pha", name: "PHA / PHBV (marine-degradable)",
    fracture_strength_mpa: 55, fracture_range_mpa: [40, 75], stiffness_mpa: 2800,
    fatigue_exponent: 12,   // ductile-ish polymer: slow crack growth, forgiving
    wet_strength_loss_per_month: 0.05, biodegradable: true,
    biodegradability: "Marine-biodegradable — months to ~1 yr",
    biodegradability_note: "PHA (incl. PHBV) genuinely biodegrades in seawater — field studies show full marine degradation on the order of months to a few years (within ~1 yr for some formulations), depending on thickness, formulation and site. This is the design-intent baseline that holds shape, then dissolves to release the seedling. Estimate — verify with immersion testing.",
    warn: false, warn_text: "",
    blurb: "Strong at first, then genuinely biodegrades in seawater to release the seedling. The design-intent baseline.",
  },
  // PLA — mechanically stronger/stiffer, but NOT reliably marine-degradable:
  // needs the heat of industrial composting. Distinct preset, distinct claim.
  pla: {
    key: "pla", name: "PLA (industrial-compost only)",
    fracture_strength_mpa: 90, fracture_range_mpa: [70, 110], stiffness_mpa: 3500,
    fatigue_exponent: 14,   // stiffer, more brittle polymer than PHA
    wet_strength_loss_per_month: 0.006, biodegradable: false,
    biodegradability: "NOT marine-degradable — industrial composting only",
    biodegradability_note: "PLA does NOT reliably biodegrade in ambient marine or soil conditions — it needs the elevated heat of industrial composting. In side-by-side testing PLA did not meet standard marine-biodegradation thresholds where PHA did. It persists in seawater over the establishment window. Estimate.",
    warn: true,
    warn_text: "PLA is NOT marine-degradable: it requires industrial composting heat and does not reliably break down in ambient seawater or soil. For a leave-in-place ocean pod, choose PHA instead.",
    blurb: "Stiffer and stronger than PHA — but it only composts industrially, so it won't dissolve at sea.",
  },
  clay: {
    key: "clay", name: "Clay (low-fired earthenware)",
    fracture_strength_mpa: 6, fracture_range_mpa: [1, 25], stiffness_mpa: 8000,
    fatigue_exponent: 30,   // ceramic static fatigue — very sharp threshold
    strength_note: "Flexural strength across fired-clay studies spans roughly 1–25 MPa; true low-fired earthenware sits toward the LOW/weak end (intentionally more porous and less vitrified than higher-fired stoneware), so ~6 MPa is more representative than the mid-range. Treat the low end as the working value; verify by testing notched samples.",
    wet_strength_loss_per_month: 0.03, biodegradable: true,
    biodegradability: "Inert mineral — environmentally benign",
    biodegradability_note: "Fired clay is not 'biodegradable' in the polymer sense, but it is an inert, non-toxic mineral that breaks down to sediment. Unfired/low-fired clay slakes faster in water (higher degradation). Estimate.",
    warn: false, warn_text: "",
    blurb: "Brittle, porous low-fired ceramic; cracks readily at a scored seam. Benign if it stays behind.",
  },
  concrete: {
    key: "concrete", name: "Concrete (unreinforced, thin-wall)",
    fracture_strength_mpa: 4, fracture_range_mpa: [3, 6], stiffness_mpa: 25000,
    fatigue_exponent: 24,   // concrete static fatigue
    wet_strength_loss_per_month: 0.004, biodegradable: false,
    biodegradability: "Not biodegradable — persistent",
    biodegradability_note: "LEAST biodegradable option. Persists in the marine environment for decades; alkaline leachate can locally raise pH. Cracks in tension at a scored seam, but the fragments remain. Not recommended for leave-in-place / dissolving pod designs. Estimate.",
    warn: true,
    warn_text: "Concrete is the LEAST biodegradable material: it persists in the marine environment and can leach alkalinity. It may crack at the seam, but fragments stay behind — avoid for leave-in-place pods.",
    blurb: "Durable and cheap, but persistent. Weak in tension so a thin scored seam still cracks.",
  },
};
function matDegrade(m, months) { return Math.max(0.05, 1 - m.wet_strength_loss_per_month * Math.max(months, 0)); }
function materialCard(m) {
  return Object.assign({}, m, { estimate_disclaimer: "Engineering estimate — requires lab verification." });
}

const SPECIES = {
  rhizophora: {
    key: "rhizophora", name: "Rhizophora mangle", latin: "Rhizophora mangle",
    window_months: 12, outplant_months: 12, mature_growth_m_yr: [1.0, 1.5],
    salinity_optimum_ppt: [5, 25], node_interval_days: null,
    early_root_note: "Early root growth very slow (~0.1 mm at 4 weeks, R. mucronata).",
    ramp_base: 0.20, ramp_exp: 1.5, ramp_peak: 1.15,
    blurb: "Red mangrove; the tall propagule this pod is shaped for. Slow-start roots.",
  },
  avicennia: {
    key: "avicennia", name: "Avicennia marina", latin: "Avicennia marina",
    window_months: 11, outplant_months: 10, mature_growth_m_yr: [0.6, 1.0],
    salinity_optimum_ppt: [5, 15], node_interval_days: 37.5,
    early_root_note: "Node-paced growth; ~37-38 day node interval as a biological clock.",
    ramp_base: 0.30, ramp_exp: 1.2, ramp_peak: 1.12,
    blurb: "Grey mangrove; steady node-paced growth, salinity-sensitive early on.",
  },
};
function spForceRamp(sp, frac) {
  frac = clip(frac, 0, 1);
  return sp.ramp_base + (sp.ramp_peak - sp.ramp_base) * Math.pow(frac, sp.ramp_exp);
}
// Same concave slow-start shape, normalised to 1.0 at maturity, so the root
// pressure the user sets IS the peak turgor-limited pressure a root can exert
// rather than something the ramp overshoots.
function spForceRampNorm(sp, frac) { return spForceRamp(sp, frac) / sp.ramp_peak; }
function spGrowthMod(sp, sal) {
  if (sal === null || sal === undefined) return 1;
  const [lo, hi] = sp.salinity_optimum_ppt;
  if (sal >= lo && sal <= hi) return 1;
  const half = Math.max(0.5 * (hi - lo), 1e-6);
  const d = (sal - (sal > hi ? hi : lo)) / half;
  return Math.max(0.4, Math.exp(-0.5 * d * d));
}
function spElapsedMonths(sp, frac, sal) { return frac * sp.window_months / Math.max(spGrowthMod(sp, sal), 1e-6); }
function spTimeContext(sp, step, T, sal) {
  if (step === null || !isFinite(step)) return { months: null, weeks: null, nodes: null, label: "—" };
  const frac = step / Math.max(T, 1);
  const months = spElapsedMonths(sp, frac, sal), weeks = months * 4.345;
  const nodes = sp.node_interval_days ? months * 30.437 / sp.node_interval_days : null;
  let label = months < 3 ? `~${weeks.toFixed(0)} weeks` : `~${months.toFixed(1)} months`;
  if (nodes !== null) label += ` · ~${nodes.toFixed(0)} nodes`;
  return { months: +months.toFixed(2), weeks: +weeks.toFixed(1), nodes: nodes === null ? null : +nodes.toFixed(1), label };
}

// physical context
function physFromCfg(cfg) {
  const material = MATERIALS[cfg.material] || MATERIALS.pha;
  const species = SPECIES[cfg.species] || SPECIES.rhizophora;
  let sal = (cfg.salinity_ppt === "" || cfg.salinity_ppt == null) ? null : +cfg.salinity_ppt;
  let p = (cfg.root_pressure_mpa === "" || cfg.root_pressure_mpa == null) ? REF_ROOT_PRESSURE_MPA : +cfg.root_pressure_mpa;
  const f = (cfg.calibration_force_n === "" || cfg.calibration_force_n == null) ? null : +cfg.calibration_force_n;
  const a = (cfg.calibration_area_mm2 === "" || cfg.calibration_area_mm2 == null) ? null : +cfg.calibration_area_mm2;
  let active = !!cfg.calibration_active && !!(f && a);
  if (active) p = f / Math.max(a, 1e-6);
  // sigma_f_mpa / thickness_factor let Monte Carlo sample the published strength
  // range and a wall-thickness tolerance without disturbing the nominal run.
  return {
    material, species, root_pressure_mpa: p, salinity_ppt: sal, calibration_active: active,
    sigma_f_mpa: cfg.sigma_f_mpa != null ? +cfg.sigma_f_mpa : material.fracture_strength_mpa,
    thickness_factor: cfg.thickness_factor != null ? +cfg.thickness_factor : 1,
    fatigue_n: material.fatigue_exponent || 15,
  };
}
function physLoadFactor(ph) { return ph.root_pressure_mpa / REF_ROOT_PRESSURE_MPA; }
// Per-step drive (MPa of available root bearing pressure) and capacity (MPa of
// remaining fracture strength after wet degradation), plus the real elapsed
// months each step lands on.
function physPerStep(ph, T) {
  const drive = new Float64Array(T), cap = new Float64Array(T), months = new Float64Array(T);
  for (let t = 1; t <= T; t++) {
    const fr = t / T;
    drive[t - 1] = ph.root_pressure_mpa * spForceRampNorm(ph.species, fr);
    months[t - 1] = spElapsedMonths(ph.species, fr, ph.salinity_ppt);
    cap[t - 1] = Math.max(ph.sigma_f_mpa * matDegrade(ph.material, months[t - 1]), 1e-6);
  }
  return { drive, cap, months };
}
function physSummary(ph) {
  return {
    material: ph.material.key, material_name: ph.material.name,
    species: ph.species.key, species_name: ph.species.name,
    root_pressure_mpa: +ph.root_pressure_mpa.toFixed(3), salinity_ppt: ph.salinity_ppt,
    calibration_active: ph.calibration_active, window_months: ph.species.window_months,
    load_factor: +physLoadFactor(ph).toFixed(3),
    sigma_f_mpa: +ph.sigma_f_mpa.toFixed(2), fatigue_n: ph.fatigue_n,
  };
}

// ---------------------------------------------------------------------------
//  provenance registry
// ---------------------------------------------------------------------------
const LEVELS = {
  literature: { label: "Literature-sourced", color: "#5aa469", blurb: "Published / well-established; citation given." },
  estimate: { label: "Estimated — needs lab validation", color: "#c98a3a", blurb: "Engineering estimate or adjacent-field proxy. Validate physically." },
  geometry: { label: "Measured off the 3-D model", color: "#5a8fce", blurb: "A shape fact from your Rhino model, not a material property." },
  calibrated: { label: "Calibrated (relative surrogate)", color: "#8a7bd8", blurb: "Chosen for sensible relative behaviour; not a measured quantity." },
  measured: { label: "Measured (your prototype)", color: "#48c9b0", blurb: "From your physical Calibration-Mode input; overrides the estimate." },
};
const VALIDATION_ROADMAP = "Industry deployment requires physical prototype testing to replace the estimated root-force constants with measured ones. Published data covers mangrove growth TIMING well, but not the mechanical FORCE a propagule root exerts against a substrate. Recommended path: grow real propagules of each candidate species inside scored 4-piece pods of each candidate material, under representative tidal wetting, and record the actual break timing and which seam releases first. Feed the measured root force (N) back through Calibration Mode to convert this tool from a relative design explorer into a quantitatively validated predictor.";

function C(key, label, value, unit, level, citation, note, group) {
  return { key, label, value, unit: unit || "", level, level_label: LEVELS[level].label, level_color: LEVELS[level].color, citation: citation || "", note: note || "", group: group || "general" };
}
function buildRegistry(cfg) {
  const ph = physFromCfg(cfg || {});
  const f = POD.features, cs = [];
  cs.push(C("model_type", "Failure model", "Reduced-order shell mechanics (not FEA)", "", "calibrated", "This project's own transparent model.", "Wall stress is computed from thin-shell hoop tension plus transverse plate bending on the NET section left after scoring, then compared with the material's remaining fracture strength both instantaneously and through a static-fatigue damage integral. Real MPa throughout, but a reduced-order surrogate: an FEA cross-check is recommended before trusting absolute margins.", "model"));
  cs.push(C("unit_scale", "Model unit scale", `1 unit = ${MM_PER_UNIT} mm`, "", "geometry", "Read off the Rhino model's own dimensions.", `The pod measures ${f.height.toFixed(0)} units tall with a ${(2 * f.inner_r_waist).toFixed(0)}-unit bore — i.e. a ${(f.height * MM_PER_UNIT).toFixed(0)} mm pod around a ⌀${(2 * f.inner_r_waist * MM_PER_UNIT).toFixed(0)} mm propagule. THE SINGLE MOST LOAD-BEARING ASSUMPTION IN THE TOOL: every stress below scales with it. Confirm it against the physical prototype.`, "model"));
  cs.push(C("stress_formula", "Wall stress relation", "σ = SCF · p · [ r/t + β·(L/t)² ]", "MPa", "calibrated", "Standard thin-shell + flat-plate relations, combined by this project.", "Membrane hoop stress on a pressurised shell superposed with the transverse bending of the wall panel. Superposition of the two is the modelling choice; each term on its own is textbook.", "model"));
  cs.push(C("plate_beta", "Plate bending coefficient β", String(PLATE_BETA), "", "literature", "Roark's Formulas for Stress and Strain — clamped rectangular plate, a/b ≈ 1.", "Peak bending stress under uniform pressure, σ = β·q·b²/t².", "model"));
  cs.push(C("bending_span", "Bending span L", "√(r·t) unscored → sector width when scored", "mm", "calibrated", "Shell boundary-layer length vs. hinged-panel width; blend is this project's choice.", "A continuous shell localises bending to its boundary layer √(r·t). Once the vertical seams are scored the wall hinges there and the whole sector between two seams reacts at the score, which is why scoring dominates the result.", "model"));
  cs.push(C("root_pressure_working_range", "Root-pressure working range (default)", "0.5 - 1.0", "MPa", "estimate", "General plant/tree root biomechanics literature (NOT mangrove-specific).", "Grounded proxy: general max axial root growth pressure ~0.1-1.0 MPa (turgor-limited), with ~0.5-0.6 MPa commonly cited for fully impeded roots; tree-specific values reach ~0.91 MPa radial / ~1.45 MPa axial. This is now a HARD CAP in the model: however far a root swells, it can never bear harder than this. Treat as a STARTING POINT pending physical validation.", "root force"));
  cs.push(C("contact_stiffness", "Contact engagement depth δ₀", contactRefMm(20).toFixed(2), "mm", "calibrated", "Chosen for sensible relative behaviour.", "Indentation at which a swelling root reaches its full bearing pressure, p = p_root·(1 − e^(−δ/δ₀)). Driven by the 'wall contact stiffness' control. Not a measured quantity.", "root force"));
  cs.push(C("slot_tip_scf", "Stress-concentration factor at slot tips", "3.0", "x", "estimate", "Order-of-magnitude fracture-mechanics estimate for a rounded notch.", "Real value depends on tip radius and material; verify with FEA / a notched-sample test.", "failure"));
  cs.push(C("fatigue_exponent", `Static-fatigue exponent n (${ph.material.name})`, String(ph.fatigue_n), "", "estimate", "Subcritical crack-growth exponents for the material class.", "Time to rupture scales as (σ_f/σ)^n, so a wall held just under strength still fails eventually and one held well under it never does. Ceramics/concrete sit high (20-40, very sharp threshold); polymers lower (8-15). Class-level estimate — verify with sustained-load testing.", "failure"));
  cs.push(C("t_ref_months", "Static-fatigue reference time", String(T_REF_MONTHS), "months", "calibrated", "Modelling choice.", "Time to rupture when stress exactly equals the remaining fracture strength. Sets the absolute pace of the delayed-failure branch.", "failure"));
  cs.push(C("net_section", "Net-section amplification", `1 / (1 − φ), capped at ${(1 / NET_SECTION_FLOOR).toFixed(0)}×`, "", "calibrated", "Net-section stress principle.", "Once a fraction φ of a seam's bands have cracked, the survivors carry the whole section. This is what makes a crack initiate at the slot-tip hot spot and then RUN across the ligament rather than stalling.", "failure"));
  cs.push(C("span_frac", "Seam tear criterion (crack span)", "0.6", "fraction", "calibrated", "Chosen so a taller bridge is genuinely harder to sever.", "A slot->foot seam/ligament 'tears' once failed faces span this fraction of its stacked z-bands.", "failure"));
  cs.push(C("breakthrough_frac", "Breakthrough criterion", "0.75", "fraction", "calibrated", "Design choice.", "Pod 'breaks through' once this fraction of the 4 seams have torn - the point it can release into petals.", "failure"));
  cs.push(C("geom_height", "Pod height", (f.height * MM_PER_UNIT).toFixed(0), "mm", "geometry", "Measured off mangrovepod.3dm.", "", "geometry"));
  cs.push(C("geom_wall", "Median wall thickness", (f.wall_thickness_median * MM_PER_UNIT).toFixed(1), "mm", "geometry", "Measured off mangrovepod.3dm.", "Local thickness sets the net section that carries the root load — the single most sensitive geometric input.", "geometry"));
  cs.push(C("geom_bore", "Bore diameter at the waist", (2 * f.inner_r_waist * MM_PER_UNIT).toFixed(1), "mm", "geometry", "Measured off mangrovepod.3dm.", "The lever arm for hoop stress, and the space the propagule has to thicken into.", "geometry"));
  cs.push(C("geom_slots", "Detected waist slots", String(f.slots.length), "count", "geometry", "Auto-detected from the mesh.", "", "geometry"));
  cs.push(C("geom_feet", "Detected base feet", String(f.feet.length), "count", "geometry", "Auto-detected from the mesh.", "", "geometry"));
  // material entries
  const m = ph.material, lo = m.fracture_range_mpa[0], hi = m.fracture_range_mpa[1];
  const strengthNote = m.strength_note || "NOT a datasheet value and NOT measured on a pod. Sets seam capacity relative to the reference material. Verify by testing notched samples.";
  const strengthVal = m.strength_note ? `${lo}-${hi} (≈${m.fracture_strength_mpa}, low end weighted)` : `${m.fracture_strength_mpa}  (range ${lo}-${hi})`;
  cs.push(C(`mat_${m.key}_strength`, `${m.name}: fracture strength (flexural)`, strengthVal, "MPa", "estimate", "Engineering estimate for a thin scored wall of this class.", strengthNote, "material"));
  cs.push(C(`mat_${m.key}_stiffness`, `${m.name}: stiffness (elastic modulus)`, `~${m.stiffness_mpa}`, "MPa", "estimate", "Order-of-magnitude estimate for the material class.", "Indicative only; verify by testing.", "material"));
  cs.push(C(`mat_${m.key}_degrade`, `${m.name}: wet/tidal strength loss`, `${m.wet_strength_loss_per_month * 100}`, "% per month", "estimate", "Engineering estimate of marine/tidal degradation.", "Strongly formulation- and site-dependent. Verify with immersion testing. Drives how the seam weakens over the window.", "material"));
  cs.push(C(`mat_${m.key}_biodeg`, `${m.name}: biodegradability`, m.biodegradability, "", "estimate", "Environmental classification (estimate).", m.biodegradability_note, "material"));
  // species entries
  const sp = ph.species, sl = sp.salinity_optimum_ppt, gr = sp.mature_growth_m_yr;
  cs.push(C(`sp_${sp.key}_outplant`, `${sp.name}: outplant-readiness`, `~${sp.outplant_months}`, "months", "literature", "Mangrove nursery/silviculture literature (verify primary source).", "Anchors the real-time window mapped across the step axis.", "species"));
  cs.push(C(`sp_${sp.key}_growth`, `${sp.name}: mature growth rate`, `${gr[0]}-${gr[1]}`, "m/year", "literature", "Mangrove growth studies on productive sites (verify primary source).", "Context for pacing; not used directly for force.", "species"));
  cs.push(C(`sp_${sp.key}_earlyroot`, `${sp.name}: early root growth`, "very slow initially", "", "literature", "R. mucronata early-root data (~0.1 mm at ~4 weeks); verify primary source.", "Justifies the concave (slow-start) root-force ramp — root force is NOT linear in time. The force magnitude itself is the general tree-root proxy (estimate), not mangrove-measured.", "species"));
  if (sp.node_interval_days) cs.push(C(`sp_${sp.key}_node`, `${sp.name}: node-production interval`, `~${sp.node_interval_days}`, "days/node", "literature", "Avicennia marina phenology (verify primary source).", "Biological clock used to pace growth stages and report node count.", "species"));
  cs.push(C(`sp_${sp.key}_salinity`, `${sp.name}: optimal early-growth salinity`, `${sl[0]}-${sl[1]}`, "ppt", "literature", "Mangrove salinity-response literature (verify primary source).", "Optional environmental input: outside this band growth slows, stretching real elapsed time (and thus wet degradation).", "species"));
  cs.push(C(`sp_${sp.key}_forcemap`, `${sp.name}: growth-stage → root-force map`, "concave ramp (modelling choice)", "", "calibrated", "This project's modelling choice.", "How biological growth stage translates to wall force is assumed, not measured. Calibration Mode + prototype testing should replace it.", "species"));
  // selected root pressure
  cs.push(C("root_pressure_selected", "Root pressure in use", ph.root_pressure_mpa.toFixed(2), "MPa", ph.calibration_active ? "measured" : "estimate", ph.calibration_active ? "Your Calibration-Mode measurement." : "General tree-root biomechanics proxy (not mangrove-specific).", ph.calibration_active ? "Derived from a measured load-cell force." : "Estimated - validate physically.", "root force"));
  const counts = {};
  for (const c of cs) counts[c.level] = (counts[c.level] || 0) + 1;
  return { levels: LEVELS, constants: cs, counts, validation_roadmap: VALIDATION_ROADMAP };
}

// ---------------------------------------------------------------------------
//  growth (seedling root architecture) — port of growth.py
// ---------------------------------------------------------------------------
//  A rule-based architectural model, not a space-filling tangle. Real seedling
//  roots are strongly structured and that structure decides where the wall gets
//  loaded, so it is reproduced explicitly: a dominant gravitropic taproot;
//  laterals emerging acropetally BEHIND the tip; a gravitropic set-point angle
//  per branch order (taproot near-vertical, laterals oblique, fine roots nearly
//  horizontal) that each tip relaxes toward, which is what makes roots curve;
//  golden-angle roll so laterals spiral around the parent instead of stacking;
//  tortuosity as a correlated random walk; and mechanical deflection along the
//  wall, because a root cannot bore through it.
// ---------------------------------------------------------------------------
const GSA_BY_ORDER_DEG = [-84, -32, -12, -6];
const DIVERGENCE_DEG = 137.507;

function _unit3(x, y, z) {
  const n = Math.hypot(x, y, z);
  return n > 1e-9 ? [x / n, y / n, z / n] : [0, 0, -1];
}
function _cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
// The direction a tip is "trying" to hold: its horizontal heading tilted to the
// gravitropic set-point angle for its order.
function _gsaDir(d, gsaDeg) {
  let hx = d[0], hy = d[1], nh = Math.hypot(hx, hy);
  if (nh < 1e-9) { hx = 1; hy = 0; nh = 1; }
  hx /= nh; hy /= nh;
  const a = gsaDeg * Math.PI / 180;
  return _unit3(hx * Math.cos(a), hy * Math.cos(a), Math.sin(a));
}
function _perpBasis(d) {
  const ref = Math.abs(d[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const c1 = _cross3(d, ref), u = _unit3(c1[0], c1[1], c1[2]);
  const c2 = _cross3(d, u), v = _unit3(c2[0], c2[1], c2[2]);
  return [u, v];
}
function _slotAzimuths() {
  const f = POD.features;
  if (f.slots && f.slots.length) return f.slots.map(s => s.theta_deg * Math.PI / 180);
  if (f.feet && f.feet.length) return f.feet.map(ft => ft.theta_deg * Math.PI / 180);
  return [];
}

function grow(gp, seed) {
  const rng = mulberry32(seed), nrm = makeNormal(rng);
  const H = POD.features.height, zBase = POD.features.z_base_top;
  const slotTh = _slotAzimuths();
  const nx = [], ny = [], nz = [], parent = [], birth = [], order = [];
  const add = (x, y, z, par, st, ord) => {
    nx.push(x); ny.push(y); nz.push(z); parent.push(par); birth.push(st); order.push(ord);
    return nx.length - 1;
  };
  // Density knob -> lateral spacing. More density = laterals closer together.
  const density = Math.max(gp.n_attractors, 1) / 2600;
  const spacing0 = Math.max(gp.lateral_spacing / Math.max(density, 0.25), gp.step_size);

  // primary axes from the hypocotyl base
  const zSeed = gp.seed_depth_frac * H, rSeed = Math.max(rInnerAt(zSeed) * 0.4, 3);
  const axisLen = 0.95 * (zSeed - 0.02 * H);
  let tips = [];
  const nSeeds = Math.max(1, gp.n_seeds);
  for (let k = 0; k < nSeeds; k++) {
    const th = 2 * Math.PI * k / nSeeds + rng();
    const ni = add(rSeed * Math.cos(th) * 0.3, rSeed * Math.sin(th) * 0.3, zSeed, -1, 0, 0);
    tips.push({ node: ni, dir: _unit3(Math.cos(th) * 0.12, Math.sin(th) * 0.12, -1),
                order: 0, remaining: axisLen * (0.9 + rng() * 0.15),
                sinceBranch: 0, roll: rng() * 2 * Math.PI });
  }

  for (let step = 1; step <= gp.max_steps; step++) {
    if (!tips.length) break;
    const spawned = [];
    for (const tip of tips) {
      if (tip.remaining <= 0) continue;
      const hx = nx[tip.node], hy = ny[tip.node], hz = nz[tip.node];
      let d = tip.dir;

      // relax toward the gravitropic set-point angle for this order
      const gsa = GSA_BY_ORDER_DEG[Math.min(tip.order, GSA_BY_ORDER_DEG.length - 1)];
      const t = _gsaDir(d, gsa), k1 = (0.25 + 0.75 * gp.down_bias) * 0.45;
      d = [d[0] + k1 * (t[0] - d[0]), d[1] + k1 * (t[1] - d[1]), d[2] + k1 * (t[2] - d[2])];
      // laterals steer toward the nearest slot / foot meridian
      if (tip.order >= 1 && slotTh.length) {
        const az = Math.atan2(hy, hx);
        let best = slotTh[0], bd = Infinity;
        for (const s of slotTh) {
          const dd = Math.abs(Math.atan2(Math.sin(s - az), Math.cos(s - az)));
          if (dd < bd) { bd = dd; best = s; }
        }
        const pull = 0.12 * gp.slot_bias / (1 + gp.slot_bias);
        d = [d[0] + pull * Math.cos(best), d[1] + pull * Math.sin(best), d[2]];
      }
      // outward SEEKING toward the wall; stops once the root has found it, since
      // a root already bearing on a surface is not driven further into it
      const rrH = Math.hypot(hx, hy);
      if (tip.order >= 1 && rrH > 1e-6 && rrH < gp.wall_seek_frac * rInnerAt(hz)) {
        const k2 = 0.10 * gp.wall_bias;
        d = [d[0] + k2 * hx / rrH, d[1] + k2 * hy / rrH, d[2]];
      }
      // basal root ball: once roots reach the base they flare OUT into the feet,
      // and that splaying is what loads the base split-lines
      const inBase = hz < zBase * gp.basal_zone_frac;
      if (inBase && rrH > 1e-6) {
        d = [d[0] + gp.basal_flare * hx / rrH, d[1] + gp.basal_flare * hy / rrH,
             d[2] + 0.25 * gp.basal_flare];
      }
      // tortuosity: a small correlated turn, not white noise
      d = _unit3(d[0] + gp.jitter * 0.30 * nrm(),
                 d[1] + gp.jitter * 0.30 * nrm(),
                 d[2] + gp.jitter * 0.30 * nrm());

      let px = hx + d[0] * gp.step_size, py = hy + d[1] * gp.step_size;
      let pz = clip(hz + d[2] * gp.step_size, 0.02 * H, 0.99 * H);

      // confinement + mechanical deflection along the wall
      const rHere = rInnerAt(pz), limit = 0.985 * rHere;
      const rr = Math.hypot(px, py);
      if (rr > limit && rr > 1e-6) {
        px *= limit / rr; py *= limit / rr;
        const nn = Math.hypot(px, py);
        if (nn > 1e-6) {
          const ndx = px / nn, ndy = py / nn;
          const out = d[0] * ndx + d[1] * ndy;
          if (out > 0) d = [d[0] - out * ndx, d[1] - out * ndy, d[2]];
          // friction: a root pinned to a surface does not slide freely sideways,
          // which stops tips spiralling round the bore and braiding into a rope
          const tgx = -ndy, tgy = ndx, circ = d[0] * tgx + d[1] * tgy;
          d = _unit3(d[0] - gp.wall_friction * circ * tgx,
                     d[1] - gp.wall_friction * circ * tgy, d[2]);
        }
      }

      const ni = add(px, py, pz, tip.node, step, tip.order);
      tip.node = ni; tip.dir = d;
      tip.remaining -= gp.step_size;
      tip.sinceBranch += gp.step_size;

      // acropetal lateral emergence; laterals crowd in the anchoring zone
      let spacing = spacing0 * (1 + 0.35 * tip.order);
      if (inBase) spacing *= gp.basal_branch_factor;
      const canBranch = (tip.remaining > gp.apical_unbranched) || (inBase && tip.order <= 1);
      if (tip.order < gp.max_order && tip.sinceBranch >= spacing && canBranch) {
        tip.sinceBranch = 0;
        tip.roll += DIVERGENCE_DEG * Math.PI / 180;
        const ang = Math.max(15, gp.branch_angle_deg + gp.branch_angle_sd * nrm()) * Math.PI / 180;
        const ub = _perpBasis(d), u = ub[0], v = ub[1];
        const cr = Math.cos(tip.roll), sr = Math.sin(tip.roll);
        const side = [cr * u[0] + sr * v[0], cr * u[1] + sr * v[1], cr * u[2] + sr * v[2]];
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const ld = _unit3(ca * d[0] + sa * side[0], ca * d[1] + sa * side[1], ca * d[2] + sa * side[2]);
        let llen = Math.max(2 * gp.step_size,
          gp.length_falloff * (tip.remaining + gp.step_size) * (0.75 + rng() * 0.5));
        // only the main axes throw the long anchoring roots; letting every order
        // do it in the base compounds into a runaway ball
        if (inBase && tip.order <= 1) {
          llen = Math.max(llen, gp.basal_lateral_len
            * Math.pow(gp.length_falloff, tip.order) * (0.7 + rng() * 0.6));
        }
        spawned.push({ node: ni, dir: ld, order: tip.order + 1, remaining: llen,
                       sinceBranch: 0, roll: rng() * 2 * Math.PI });
      }
    }
    tips = tips.filter(t => t.remaining > 0).concat(spawned);
  }

  // pipe-model radii; tip radius tapers with branch order so fine roots stay
  // fine and the taproot ends up genuinely dominant
  const n = nx.length, rad = new Float64Array(n), tipR = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    tipR[i] = gp.tip_radius * Math.pow(gp.order_radius_falloff, order[i]);
    rad[i] = tipR[i];
  }
  const children = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) if (parent[i] >= 0) children[parent[i]].push(i);
  const ord = [...Array(n).keys()].sort((a, b) => birth[b] - birth[a]);
  const pe = gp.pipe_exponent;
  for (const i of ord) {
    if (children[i].length) {
      let s = 0; for (const c of children[i]) s += Math.pow(rad[c], pe);
      rad[i] = Math.max(tipR[i], Math.pow(s, 1 / pe));
    }
  }
  for (let i = 0; i < n; i++) rad[i] *= gp.radius_gain;
  return { nx, ny, nz, parent, birth, order, radius: rad, n };
}

// ---------------------------------------------------------------------------
//  perforation fields — port of perforation.py
// ---------------------------------------------------------------------------
function detectedPattern() {
  const f = POD.features;
  return {
    slots: f.slots.map(s => ({ theta_deg: s.theta_deg, width_deg: s.width_deg, z_lo: s.z_lo, z_hi: s.z_hi })),
    split_lines: f.split_line_deg.map(a => ({ theta_deg: a, depth_frac: 1.3, score: 0.35 })),
    mat: Object.assign({}, MAT_PARAMS), seam_score: 0, seam_width_deg: 0, name: "as-drawn",
  };
}
function parametricPattern(o) {
  const f = POD.features, H = f.height, det = f.slots;
  const mean = (arr, fn) => arr.length ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0;
  const baseLen = det.length ? mean(det, s => s.z_hi - s.z_lo) : 0.22 * H;
  const baseWid = det.length ? mean(det, s => s.width_deg) : 15;
  const baseZc = det.length ? mean(det, s => 0.5 * (s.z_lo + s.z_hi)) : f.z_waist_mid + 20;
  const n_slots = o.n_slots != null ? o.n_slots : 4;
  const length = o.slot_length_frac != null ? o.slot_length_frac * H : baseLen;
  const width = o.slot_width_deg != null ? o.slot_width_deg : baseWid;
  const detTop = det.length ? mean(det, s => s.z_hi) : (baseZc + baseLen / 2);
  let zc;
  if (o.slot_z_center_frac != null) zc = o.slot_z_center_frac * H;
  else if (o.slot_length_frac != null) zc = detTop - length / 2;
  else zc = baseZc;
  let centers = (o.align === "split") ? f.split_line_deg.slice() : f.feet.map(ft => ft.theta_deg);
  if (centers.length !== n_slots || !centers.length) {
    centers = []; for (let i = 0; i < n_slots; i++) centers.push(-180 + 360 * i / n_slots);
  }
  const off = o.theta_offset_deg || 0;
  centers = centers.map(c => ((c + off + 180) % 360 + 360) % 360 - 180);
  const slots = centers.map(c => ({ theta_deg: c, width_deg: width, z_lo: zc - length / 2, z_hi: zc + length / 2 }));
  const sc = centers.slice().sort((a, b) => a - b), split_th = [];
  for (let i = 0; i < sc.length; i++) {
    const a = sc[i], b = sc[(i + 1) % sc.length] + (i === sc.length - 1 ? 360 : 0);
    split_th.push(((a + b) / 2 + 180) % 360 - 180);
  }
  const split_lines = split_th.map(a => ({ theta_deg: a, depth_frac: o.split_depth_frac != null ? o.split_depth_frac : 1.3, score: o.split_score != null ? o.split_score : 0.35 }));
  return {
    slots, split_lines, mat: Object.assign({}, MAT_PARAMS),
    seam_score: o.seam_score || 0, seam_width_deg: o.seam_width_deg || 0, name: o.name || "custom",
  };
}

function buildFields(pat) {
  const m = pat.mat, nF = POD.nF, th = POD.thetaFace, z = POD.zFace, r = POD.rFace;
  const inner = POD.innerMask, thickness = POD.thickness;
  const z_base_top = POD.features.z_base_top;
  const open_frac = new Float64Array(nF), scf = new Float64Array(nF).fill(1);
  const ligament = new Int32Array(nF).fill(-1);
  const thd = new Float64Array(nF);
  for (let i = 0; i < nF; i++) thd[i] = th[i] * 180 / Math.PI;
  for (let si = 0; si < pat.slots.length; si++) {
    const s = pat.slots[si];
    for (let i = 0; i < nF; i++) {
      const ad = angdiff(thd[i], s.theta_deg);
      if (ad < s.width_deg / 2 && z[i] > s.z_lo && z[i] < s.z_hi) open_frac[i] = 1;
    }
    for (const ztip of [s.z_lo, s.z_hi]) {
      for (let i = 0; i < nF; i++) {
        const ad = angdiff(thd[i], s.theta_deg) * Math.PI / 180 * Math.max(r[i], 1);
        const d = Math.hypot(ad, z[i] - ztip);
        const v = 1 + (m.slot_tip_scf - 1) * Math.exp(-((d / m.tip_zone) ** 2));
        if (v > scf[i]) scf[i] = v;
      }
    }
    let halfw = Math.max(m.ligament_halfwidth_deg, s.width_deg * 0.8);
    if (pat.seam_width_deg > 0) halfw = Math.max(halfw, pat.seam_width_deg / 2);
    for (let i = 0; i < nF; i++) {
      if (inner[i] && angdiff(thd[i], s.theta_deg) < halfw && z[i] < s.z_lo && z[i] > z_base_top)
        ligament[i] = si;
    }
  }
  for (const sp of pat.split_lines) {
    for (let i = 0; i < nF; i++) {
      if (angdiff(thd[i], sp.theta_deg) < 6 && z[i] < z_base_top * sp.depth_frac) {
        const v = 1 + (m.split_scf - 1); if (v > scf[i]) scf[i] = v;
      }
    }
  }
  const weaken = new Float64Array(nF);
  for (const sp of pat.split_lines)
    for (let i = 0; i < nF; i++)
      if (angdiff(thd[i], sp.theta_deg) < 6 && z[i] < z_base_top * sp.depth_frac)
        weaken[i] = Math.max(weaken[i], sp.score);
  if (pat.seam_score > 0) {
    const shw = pat.seam_width_deg > 0 ? pat.seam_width_deg / 2 : m.ligament_halfwidth_deg;
    for (const s of pat.slots)
      for (let i = 0; i < nF; i++)
        if (inner[i] && angdiff(thd[i], s.theta_deg) < shw) weaken[i] = Math.max(weaken[i], pat.seam_score);
  }
  // ---- section geometry, in millimetres -----------------------------------
  //  t_eff  net wall left after scoring — this is what carries the load
  //  r_bore local inner radius (the lever arm for membrane hoop stress)
  //  span   the length the transverse bending reacts over: a continuous shell
  //         localises bending to its boundary layer √(r·t), but once the
  //         vertical seams are scored the wall hinges there and the whole
  //         sector between two seams reacts at the score.
  const t_eff = new Float64Array(nF), span = new Float64Array(nF), r_bore = new Float64Array(nF);
  const nPieces = Math.max(pat.slots.length, 2), sectorRad = 2 * Math.PI / nPieces;
  for (let i = 0; i < nF; i++) {
    const t0 = Math.max(thickness[i] * MM_PER_UNIT, MIN_T_EFF_MM);
    const rb = Math.max(rInnerAt(z[i]) * MM_PER_UNIT, 1);
    const score = clip(weaken[i], 0, 0.98);
    const te = Math.max(t0 * (1 - score), MIN_T_EFF_MM);
    const hinge = _sstep(score / 0.6);
    const lShell = Math.sqrt(rb * t0);              // shell bending boundary layer
    const lSector = sectorRad * (rb + 0.5 * t0);    // hinged-panel width at mid-wall
    t_eff[i] = te; r_bore[i] = rb;
    span[i] = _lerp(lShell, lSector, hinge);
  }
  const split_site = new Int32Array(nF).fill(-1);
  for (let spi = 0; spi < pat.split_lines.length; spi++) {
    const sp = pat.split_lines[spi];
    for (let i = 0; i < nF; i++)
      if (inner[i] && angdiff(thd[i], sp.theta_deg) < m.ligament_halfwidth_deg * 0.6 && z[i] < z_base_top * sp.depth_frac)
        split_site[i] = spi;
  }
  const labels = pat.slots.map(s => `slot@${s.theta_deg.toFixed(0)}°`)
    .concat(pat.split_lines.map(s => `split@${s.theta_deg.toFixed(0)}°`));
  return { open_frac, t_eff, span, r_bore, weaken, scf, ligament, split_site,
    n_slots: pat.slots.length, n_splits: pat.split_lines.length, labels, pattern: pat };
}

// ---------------------------------------------------------------------------
//  wall model + pressure simulation — port of pressure.py
// ---------------------------------------------------------------------------
function buildWallModel(wall) {
  const innerIdx = POD.innerIdx, nIn = innerIdx.length;
  const Cin = new Float64Array(nIn * 3);
  const scf_in = new Float64Array(nIn), z_in = new Float64Array(nIn), r_in = new Float64Array(nIn);
  const t_in = new Float64Array(nIn), span_in = new Float64Array(nIn), rb_in = new Float64Array(nIn);
  const open_in = new Float64Array(nIn), score_in = new Float64Array(nIn);
  const lig = new Int32Array(nIn), split = new Int32Array(nIn);
  for (let l = 0; l < nIn; l++) {
    const g = innerIdx[l];
    Cin[3 * l] = POD.cx[g]; Cin[3 * l + 1] = POD.cy[g]; Cin[3 * l + 2] = POD.cz[g];
    scf_in[l] = wall.scf[g];
    t_in[l] = wall.t_eff[g]; span_in[l] = wall.span[g]; rb_in[l] = wall.r_bore[g];
    open_in[l] = wall.open_frac[g]; score_in[l] = wall.weaken[g];
    z_in[l] = POD.zFace[g]; r_in[l] = POD.rFace[g];
    lig[l] = wall.ligament[g]; split[l] = wall.split_site[g];
  }
  const grid = new Grid(Cin, nIn, 8);
  const n_slots = wall.n_slots, n_splits = wall.n_splits, n_sites = n_slots + n_splits;
  const site_faces = [], is_lig = [];
  for (let si = 0; si < n_slots; si++) { const fs = []; for (let l = 0; l < nIn; l++) if (lig[l] === si) fs.push(l); site_faces.push(fs); is_lig.push(true); }
  for (let spi = 0; spi < n_splits; spi++) { const fs = []; for (let l = 0; l < nIn; l++) if (split[l] === spi) fs.push(l); site_faces.push(fs); is_lig.push(false); }
  // Every site (slot ligament AND base split) is banded up its height, so both
  // fail by the same physical rule: a crack has to run across the section, not
  // just nick it somewhere.
  const band_h = 12, site_band = new Array(n_sites).fill(null), site_nbands = new Int32Array(n_sites).fill(1);
  for (let si = 0; si < n_sites; si++) {
    const fs = site_faces[si]; if (!fs.length) continue;
    let zlo = Infinity, zhi = -Infinity; for (const l of fs) { if (z_in[l] < zlo) zlo = z_in[l]; if (z_in[l] > zhi) zhi = z_in[l]; }
    const K = Math.max(3, Math.round((zhi - zlo) / band_h));
    const b = new Int32Array(fs.length);
    for (let t = 0; t < fs.length; t++) b[t] = clip(Math.floor((z_in[fs[t]] - zlo) / Math.max(zhi - zlo, 1e-6) * K), 0, K - 1);
    site_band[si] = b; site_nbands[si] = K;
  }
  // reverse index: which site (if any) each inner face belongs to, so the
  // net-section amplification can be looked up per face in the time loop
  const face_site = new Int32Array(nIn).fill(-1);
  for (let si = 0; si < n_sites; si++) for (const l of site_faces[si]) face_site[l] = si;
  return { innerIdx, nIn, Cin, grid, scf_in, z_in, r_in, t_in, span_in, rb_in, open_in, score_in,
    n_slots, n_splits, n_sites, labels: wall.labels, site_faces, is_lig, site_band, site_nbands, face_site };
}
// Wall stress (MPa) at one inner face under bearing pressure p (MPa): membrane
// hoop on the net section + transverse plate bending over its reacting span,
// amplified by the local stress-concentration factor and by the net-section
// loss where part of the site has already cracked. `tf` is a wall-thickness
// tolerance factor (1 = nominal) used by the Monte Carlo sweep.
function wallStress(wm, l, p, amp, tf) {
  if (p <= 0 || wm.open_in[l] > 0.5) return 0;
  const te = Math.max(wm.t_in[l] * (tf || 1), MIN_T_EFF_MM);
  const sl = wm.span_in[l] / te;
  return wm.scf_in[l] * amp * p * (wm.rb_in[l] / te + PLATE_BETA * sl * sl);
}

function nodeRadius(pipe, age, sp) {
  const mature = clip(age / sp.maturation, 0.05, 1);
  const swell = clip(1 + sp.swell_rate * Math.max(age - sp.maturation, 0), 1, sp.max_swell);
  return pipe * mature * swell;
}

// ---------------------------------------------------------------------------
//  The wall simulation.
//
//  Each step: every live root node develops a turgor-BOUNDED bearing pressure
//  (a root physically cannot push harder than its growth pressure, however far
//  it swells), that pressure is summed over the faces it bears on, converted to
//  a real MPa wall stress by hoop + plate bending on the net scored section,
//  and then compared with the material's remaining fracture strength — both
//  instantaneously (brittle overload) and through a power-law static-fatigue
//  damage integral in REAL months, so a wall held just under its strength still
//  fails eventually and one held well under it never does.
//
//  As bands of a seam crack, the surviving bands carry the whole section, so
//  their stress is amplified by 1/(1-φ). That is what makes a crack initiate at
//  the slot-tip hot spot and then RUN across the ligament.
// ---------------------------------------------------------------------------
function runSimulation(wm, roots, sp, ph, capFrames) {
  const T = sp.n_time_steps;
  const ps = physPerStep(ph, T), drive = ps.drive, cap = ps.cap, months = ps.months;
  const N = roots.n, Px = roots.nx, Py = roots.ny, Pz = roots.nz, pipe = roots.radius, birth = roots.birth;
  let maxBirth = 1; for (let i = 0; i < N; i++) if (birth[i] > maxBirth) maxBirth = birth[i];
  const birthTime = new Float64Array(N);
  for (let i = 0; i < N; i++) birthTime[i] = birth[i] / maxBirth * (sp.growth_fraction * T);
  const rNode = new Float64Array(N), rInnerHere = new Float64Array(N), baseNode = new Uint8Array(N);
  const zBase = POD.features.z_base_top;
  for (let i = 0; i < N; i++) { rNode[i] = Math.hypot(Px[i], Py[i]); rInnerHere[i] = rInnerAt(Pz[i]); baseNode[i] = Pz[i] < zBase * 1.25 ? 1 : 0; }
  // Contact kernel: a spatial falloff, NOT normalised to 1. Pressure is not
  // divided between the faces a root bears on — it acts across all of them.
  const contrib = Array.from({ length: wm.nIn }, () => []);
  for (let j = 0; j < N; j++) {
    const pr = Math.max(sp.contact_patch_factor * pipe[j], sp.min_patch_radius);
    let fs = wm.grid.ball(Px[j], Py[j], Pz[j], pr);
    if (!fs.length) fs = [wm.grid.nearest(Px[j], Py[j], Pz[j]).idx];
    for (let t = 0; t < fs.length; t++) {
      const l = fs[t], dx = wm.Cin[3 * l] - Px[j], dy = wm.Cin[3 * l + 1] - Py[j], dz = wm.Cin[3 * l + 2] - Pz[j];
      const d = Math.hypot(dx, dy, dz);
      contrib[l].push([j, clip(1 - d / Math.max(pr, 1e-6), 0.05, 1)]);
    }
  }
  const delta0 = contactRefMm(sp.contact_stiffness);          // mm of indentation for full bearing
  const pullMPa = Math.max(sp.pull_assist, 0);                // planting-team assist, MPa-equivalent
  const nExp = ph.fatigue_n, tf = ph.thickness_factor;
  const z_waist_hi = POD.features.z_waist_hi;
  const sigma = new Float64Array(wm.nIn), sigmaPeak = new Float64Array(wm.nIn), dmg = new Float64Array(wm.nIn);
  // effective crack-tip stress on bands at a crack front (K-based propagation);
  // zero where there is no front. Carried into the next step, like sitePhi.
  const crackTip = new Float64Array(wm.nIn);
  const pPeak = new Float64Array(wm.nIn);   // peak bearing pressure per face — feeds the design guidance
  const pressNode = new Float64Array(N);
  const bandFailed = [], sitePhi = new Float64Array(wm.n_sites);
  for (let si = 0; si < wm.n_sites; si++) bandFailed.push(new Uint8Array(wm.site_nbands[si]));
  const activation = new Float64Array(wm.n_sites).fill(Infinity), order = [];
  const nLig = wm.n_slots, needed = Math.max(1, Math.ceil(nLig * sp.breakthrough_frac));
  let breakthrough = Infinity;
  // per-step traces for the results panel: peak wall stress and the remaining
  // strength it is racing against, both in MPa
  const sigSeries = new Float64Array(T), capSeries = new Float64Array(T);

  for (let t = 1; t <= T; t++) {
    const pMax = drive[t - 1], sigF = cap[t - 1];
    const dMonths = Math.max(months[t - 1] - (t > 1 ? months[t - 2] : 0), 0);
    // --- 1. bearing pressure per root node (MPa, turgor-bounded) ---
    for (let i = 0; i < N; i++) {
      if (birthTime[i] > t) { pressNode[i] = 0; continue; }
      const age = t - birthTime[i], rad = nodeRadius(pipe[i], age, sp);
      const pen = (rNode[i] + rad) - rInnerHere[i];
      if (pen <= 0) { pressNode[i] = 0; continue; }
      // engagement saturates: once the root has indented the bore by a few
      // δ₀ it is bearing at its full growth pressure and can push no harder
      const engage = 1 - Math.exp(-pen * MM_PER_UNIT / delta0);
      pressNode[i] = pMax * engage * (baseNode[i] ? 1 + sp.base_wedge : 1);
    }
    // --- 2. face pressure → stress → damage ---
    let peakThisStep = 0;
    for (let l = 0; l < wm.nIn; l++) {
      let p = 0; const cc = contrib[l];
      for (let q = 0; q < cc.length; q++) p += cc[q][1] * pressNode[cc[q][0]];
      if (pullMPa > 0 && wm.z_in[l] < z_waist_hi) p += pullMPa;
      if (p > pMax + pullMPa) p = pMax + pullMPa;   // overlapping roots still cannot exceed turgor
      if (p > pPeak[l]) pPeak[l] = p;
      const si = wm.face_site[l];
      // NOMINAL stress on the intact section — this is the design demand, and
      // what the heatmap and the reported numbers show.
      const s = wallStress(wm, l, p, 1, tf);
      sigma[l] = s;
      if (s > sigmaPeak[l]) sigmaPeak[l] = s;
      if (s > peakThisStep) peakThisStep = s;
      // Damage sees the net-section amplification instead: once bands of this
      // seam have cracked, the survivors carry the whole section.
      const amp = si >= 0 ? 1 / Math.max(1 - sitePhi[si], NET_SECTION_FLOOR) : 1;
      // A band at a crack front is driven by the stress intensity there, from
      // the load on the seam and the crack already formed — not by the local
      // stress ahead of the tip. Whichever is worse governs.
      const sAmp = Math.max(s * amp, crackTip[l]);
      if (sAmp > 0 && dmg[l] < 1) {
        // brittle overload, then power-law subcritical crack growth
        if (sAmp >= sigF) dmg[l] = 1;
        else if (dMonths > 0) dmg[l] += Math.pow(sAmp / sigF, nExp) * dMonths / T_REF_MONTHS;
      }
    }
    capSeries[t - 1] = sigF;
    // --- 3. site state: which bands have cracked, and has the seam torn? ---
    let govNow = Infinity;
    for (let si = 0; si < wm.n_sites; si++) {
      const fs = wm.site_faces[si]; if (!fs.length) continue;
      const bands = wm.site_band[si], bf = bandFailed[si];
      // the stress that decides this seam: the span_frac-th highest band stress
      if (wm.is_lig[si]) {
        const nb = wm.site_nbands[si], bandMax = new Float64Array(nb);
        for (let q = 0; q < fs.length; q++) { const b = bands[q]; if (sigma[fs[q]] > bandMax[b]) bandMax[b] = sigma[fs[q]]; }
        const sorted = Array.from(bandMax).sort((a, b) => b - a);
        const gi = clip(Math.ceil(sp.span_frac * nb) - 1, 0, nb - 1);
        if (sorted[gi] < govNow) govNow = sorted[gi];
      }
      for (let q = 0; q < fs.length; q++) if (dmg[fs[q]] >= 1) bf[bands[q]] = 1;
      let nf = 0; for (let b = 0; b < bf.length; b++) if (bf[b]) nf++;
      sitePhi[si] = nf / wm.site_nbands[si];
      // --- crack propagation, K = Y·σ_drive·√a --------------------------------
      // σ_drive is the NOMINAL section stress (σ/SCF), not the peak: the peak
      // sits at the slot-tip raiser and already carries the concentration, and
      // once a crack exists it — not the notch — is the dominant feature, so
      // driving K with the concentrated value counts the concentration twice.
      const nb2 = wm.site_nbands[si];
      if (nf > 0 && nf < nb2) {
        const front = new Uint8Array(nb2);
        for (let b = 0; b < nb2; b++) if (bf[b]) {
          if (b > 0) front[b - 1] = 1;
          if (b < nb2 - 1) front[b + 1] = 1;
        }
        for (let b = 0; b < nb2; b++) if (bf[b]) front[b] = 0;
        let drive = 0;
        for (let q = 0; q < fs.length; q++) {
          const v = sigma[fs[q]] / Math.max(wm.scf_in[fs[q]], 1e-6);
          if (v > drive) drive = v;
        }
        const kEff = drive * CRACK_GEOM_Y * Math.sqrt(nf);
        for (let q = 0; q < fs.length; q++) crackTip[fs[q]] = front[bands[q]] ? kEff : 0;
      } else {
        for (let q = 0; q < fs.length; q++) crackTip[fs[q]] = 0;
      }
      if (sitePhi[si] >= sp.span_frac && !isFinite(activation[si])) { activation[si] = t; order.push(si); }
    }
    sigSeries[t - 1] = isFinite(govNow) ? govNow : peakThisStep;
    let nActive = 0; for (let si = 0; si < nLig; si++) if (isFinite(activation[si])) nActive++;
    if (nActive >= needed && !isFinite(breakthrough)) breakthrough = t;
    if (capFrames) capFrames.push(Float32Array.from(sigma));   // per-step MPa snapshot for playback
  }
  let firstSite = -1, firstStep = Infinity;
  for (let si = 0; si < wm.n_sites; si++) if (isFinite(activation[si]) && activation[si] < firstStep) { firstStep = activation[si]; firstSite = si; }
  const faceField = new Float64Array(POD.nF);
  for (let l = 0; l < wm.nIn; l++) faceField[wm.innerIdx[l]] = sigma[l];
  // headline engineering numbers: worst stress anywhere on a release seam, and
  // how much of the material's remaining strength that uses up
  let seamPeak = 0;
  for (let si = 0; si < wm.n_sites; si++)
    for (const l of wm.site_faces[si]) if (sigmaPeak[l] > seamPeak) seamPeak = sigmaPeak[l];
  const sigFEnd = cap[T - 1];
  return { faceField, sigmaPeak, pPeak, activation, order, firstStep, firstSite, breakthrough, nNodes: N,
    sigSeries, capSeries, months, seam_peak_mpa: seamPeak, sigma_f_end_mpa: sigFEnd,
    utilisation: seamPeak / Math.max(sigFEnd, 1e-9) };
}

// ---------------------------------------------------------------------------
//  design guidance: how deep would the seams have to be scored?
// ---------------------------------------------------------------------------
//  Stress scales as 1/t for hoop and 1/t² for bending, so scoring is by far the
//  strongest lever the designer has. Using the bearing pressure the run actually
//  delivered to each ligament face, re-evaluate the section analytically for a
//  sweep of candidate scoring depths and report the shallowest one at which a
//  seam would tear across span_frac of its bands. Cheap — no extra simulation.
// ---------------------------------------------------------------------------
function seamScoreSweep(wm, res, ph, sp, pat) {
  const sigF = res.sigma_f_end_mpa, nPieces = Math.max(pat.slots.length, 2);
  const sectorRad = 2 * Math.PI / nPieces, out = [];
  for (let s = 0; s <= 0.95001; s += 0.05) {
    let torn = 0;
    for (let si = 0; si < wm.n_sites; si++) {
      if (!wm.is_lig[si]) continue;
      const fs = wm.site_faces[si], bands = wm.site_band[si];
      if (!fs.length) continue;
      const bf = new Uint8Array(wm.site_nbands[si]);
      for (let q = 0; q < fs.length; q++) {
        const l = fs[q], p = res.pPeak[l];
        if (p <= 0) continue;
        const t0 = wm.t_in[l] / Math.max(1 - wm.score_in[l], 0.02);   // gross wall before scoring
        const te = Math.max(t0 * (1 - s), MIN_T_EFF_MM);
        const L = _lerp(Math.sqrt(wm.rb_in[l] * t0), sectorRad * (wm.rb_in[l] + 0.5 * t0), _sstep(s / 0.6));
        const sl = L / te;
        if (wm.scf_in[l] * p * (wm.rb_in[l] / te + PLATE_BETA * sl * sl) >= sigF) bf[bands[q]] = 1;
      }
      let nf = 0; for (let b = 0; b < bf.length; b++) if (bf[b]) nf++;
      if (nf / wm.site_nbands[si] >= sp.span_frac) torn++;
    }
    out.push({ score: +s.toFixed(2), seams_torn: torn });
  }
  const needed = Math.max(1, Math.ceil(wm.n_slots * sp.breakthrough_frac));
  const hit = out.find(o => o.seams_torn >= needed);
  return { sweep: out, required_score: hit ? hit.score : null, seams_needed: needed };
}
// The stress that GOVERNS release, as opposed to the peak at the slot-tip
// stress raiser. A seam only tears once cracking spans span_frac of its bands,
// so the deciding stress is the span_frac-th highest band stress — and the pod
// releases on whichever seam reaches that first. This is the number to compare
// against material strength when asking "will it open?".
function governingSeamStress(wm, res, sp) {
  let out = Infinity;
  for (let si = 0; si < wm.n_sites; si++) {
    if (!wm.is_lig[si]) continue;
    const fs = wm.site_faces[si], bands = wm.site_band[si], nb = wm.site_nbands[si];
    if (!fs.length) continue;
    const bandMax = new Float64Array(nb);
    for (let q = 0; q < fs.length; q++) { const b = bands[q], v = res.sigmaPeak[fs[q]]; if (v > bandMax[b]) bandMax[b] = v; }
    const sorted = Array.from(bandMax).sort((a, b) => b - a);
    const idx = clip(Math.ceil(sp.span_frac * nb) - 1, 0, nb - 1);
    if (sorted[idx] < out) out = sorted[idx];
  }
  return isFinite(out) ? out : 0;
}
// Net wall left at the seam for a given scoring depth, in mm — the number a
// designer actually has to draw.
function seamThicknessAt(wm, score) {
  let sum = 0, n = 0;
  for (let si = 0; si < wm.n_sites; si++) {
    if (!wm.is_lig[si]) continue;
    for (const l of wm.site_faces[si]) { sum += wm.t_in[l] / Math.max(1 - wm.score_in[l], 0.02); n++; }
  }
  return n ? (sum / n) * (1 - score) : null;
}

// Headline engineering numbers for the results panel.
function mechanicsSummary(res, wm, ph, pat, sp) {
  // net section left at the release seams, in mm
  let tMin = Infinity, tSum = 0, nT = 0;
  for (let si = 0; si < wm.n_sites; si++) {
    if (!wm.is_lig[si]) continue;
    for (const l of wm.site_faces[si]) { const t = wm.t_in[l] * ph.thickness_factor; if (t < tMin) tMin = t; tSum += t; nT++; }
  }
  const guide = sp ? seamScoreSweep(wm, res, ph, sp, pat) : null;
  const gov = sp ? governingSeamStress(wm, res, sp) : res.seam_peak_mpa;
  const util = gov / Math.max(res.sigma_f_end_mpa, 1e-9);
  const sf = gov > 0 ? res.sigma_f_end_mpa / gov : Infinity;
  return {
    unit_mm: MM_PER_UNIT,
    seam_stress_mpa: +gov.toFixed(2),        // governs whether the seam tears
    peak_stress_mpa: +res.seam_peak_mpa.toFixed(2),   // local peak at the slot tip
    tip_utilisation: +res.utilisation.toFixed(3),
    strength_start_mpa: +ph.sigma_f_mpa.toFixed(2),
    strength_end_mpa: +res.sigma_f_end_mpa.toFixed(2),
    utilisation: +util.toFixed(3),
    safety_factor: isFinite(sf) ? +sf.toFixed(2) : null,
    seam_thickness_mm: nT ? +(tSum / nT).toFixed(2) : null,
    seam_thickness_min_mm: isFinite(tMin) ? +tMin.toFixed(2) : null,
    seam_score: pat.seam_score || 0,
    fatigue_n: ph.fatigue_n,
    required_score: guide ? guide.required_score : null,
    required_seam_thickness_mm: (guide && guide.required_score != null)
      ? +seamThicknessAt(wm, guide.required_score).toFixed(2) : null,
    seams_needed: guide ? guide.seams_needed : null,
    stress_series: Array.from(res.sigSeries, v => +v.toFixed(3)),
    strength_series: Array.from(res.capSeries, v => +v.toFixed(3)),
    months_series: Array.from(res.months, v => +v.toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
//  vertex intensity + projection
// ---------------------------------------------------------------------------
function faceFieldToVertex(fv) {
  const nV = POD.nV, F = POD.F, area = POD.area, vv = new Float64Array(nV), ws = new Float64Array(nV);
  for (let f = 0; f < POD.nF; f++) {
    const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2], w = area[f], val = fv[f] * w;
    vv[a] += val; vv[b] += val; vv[c] += val; ws[a] += w; ws[b] += w; ws[c] += w;
  }
  for (let i = 0; i < nV; i++) vv[i] = ws[i] > 0 ? vv[i] / ws[i] : 0;
  return vv;
}
let _projMap = null;   // outer/other face -> nearest inner face index (static geometry)
function projectInnerToOuter(field) {
  if (!_projMap) {
    const nIn = POD.innerIdx.length, C = new Float64Array(nIn * 3);
    for (let l = 0; l < nIn; l++) { const g = POD.innerIdx[l]; C[3 * l] = POD.cx[g]; C[3 * l + 1] = POD.cy[g]; C[3 * l + 2] = POD.cz[g]; }
    const grid = new Grid(C, nIn, 8);
    _projMap = new Int32Array(POD.nF);
    for (let f = 0; f < POD.nF; f++) { const q = grid.nearest(POD.cx[f], POD.cy[f], POD.cz[f]); _projMap[f] = POD.innerIdx[q.idx]; }
  }
  const out = new Float64Array(POD.nF);
  for (let f = 0; f < POD.nF; f++) out[f] = field[_projMap[f]];
  return out;
}
// vertex adjacency (from faces) for smoothing the stress field
let _vadj = null;
function vertexAdj() {
  if (_vadj) return _vadj;
  const nV = POD.nV, F = POD.F, sets = Array.from({ length: nV }, () => new Set());
  for (let f = 0; f < POD.nF; f++) {
    const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
    sets[a].add(b); sets[a].add(c); sets[b].add(a); sets[b].add(c); sets[c].add(a); sets[c].add(b);
  }
  _vadj = sets.map(s => Array.from(s));
  return _vadj;
}
function smoothVertexField(vv, iters, w) {
  const adj = vertexAdj(), nV = vv.length; let cur = vv;
  for (let it = 0; it < iters; it++) {
    const nx = new Float64Array(nV);
    for (let i = 0; i < nV; i++) {
      const a = adj[i]; let s = 0; for (let t = 0; t < a.length; t++) s += cur[a[t]];
      nx[i] = a.length ? (1 - w) * cur[i] + w * (s / a.length) : cur[i];
    }
    cur = nx;
  }
  return cur;
}
// Per-vertex wall stress in MPa. cmaxAbs anchors the colour scale to a physical
// quantity (the material's remaining fracture strength), so the top of the ramp
// literally means "at fracture" and switching material visibly recolours the
// pod. Falls back to the old 99th-percentile auto-scale when no anchor is given.
function vertexIntensity(field, projectOuter, cmaxAbs) {
  let f = field;
  if (projectOuter) f = projectInnerToOuter(field);
  let vv = faceFieldToVertex(f);
  vv = smoothVertexField(vv, 2, 0.55);   // blend the heatmap so it radiates, not blobs
  const out = new Array(vv.length);
  for (let i = 0; i < vv.length; i++) out[i] = Math.round(vv[i] * 1000) / 1000;
  const cmax = cmaxAbs != null ? cmaxAbs : percentile(vv, 99);
  return { intensity: out, cmax: Math.max(cmax, 1e-9) };
}

// ---------------------------------------------------------------------------
//  render3d — tapered tubes, seams, exploded (port of render3d.py)
// ---------------------------------------------------------------------------
function frame(tx, ty, tz) {
  const L = Math.hypot(tx, ty, tz) || 1e-12; tx /= L; ty /= L; tz /= L;
  let rx = 0, ry = 0, rz = 1; if (Math.abs(tz) >= 0.9) { rx = 1; rz = 0; }
  let n1x = ty * rz - tz * ry, n1y = tz * rx - tx * rz, n1z = tx * ry - ty * rx;
  const l1 = Math.hypot(n1x, n1y, n1z) || 1e-12; n1x /= l1; n1y /= l1; n1z /= l1;
  const n2x = ty * n1z - tz * n1y, n2y = tz * n1x - tx * n1z, n2z = tx * n1y - ty * n1x;
  return [n1x, n1y, n1z, n2x, n2y, n2z];
}
class TubeAccum {
  constructor(sides) {
    this.sides = sides; this.cs = []; this.sn = [];
    for (let k = 0; k < sides; k++) { const a = 2 * Math.PI * k / sides; this.cs.push(Math.cos(a)); this.sn.push(Math.sin(a)); }
    this.x = []; this.y = []; this.z = []; this.i = []; this.j = []; this.k = []; this.n = 0;
  }
  addFrustum(ax, ay, az, bx, by, bz, ra, rb) {
    const tx = bx - ax, ty = by - ay, tz = bz - az, L = Math.hypot(tx, ty, tz);
    if (L < 1e-6) return;
    const [n1x, n1y, n1z, n2x, n2y, n2z] = frame(tx, ty, tz);
    const s = this.sides, base = this.n;
    ra = Math.max(ra, 1e-3); rb = Math.max(rb, 1e-3);
    for (let k = 0; k < s; k++) {
      this.x.push(ax + ra * (this.cs[k] * n1x + this.sn[k] * n2x));
      this.y.push(ay + ra * (this.cs[k] * n1y + this.sn[k] * n2y));
      this.z.push(az + ra * (this.cs[k] * n1z + this.sn[k] * n2z));
    }
    for (let k = 0; k < s; k++) {
      this.x.push(bx + rb * (this.cs[k] * n1x + this.sn[k] * n2x));
      this.y.push(by + rb * (this.cs[k] * n1y + this.sn[k] * n2y));
      this.z.push(bz + rb * (this.cs[k] * n1z + this.sn[k] * n2z));
    }
    this.n += 2 * s;
    for (let k = 0; k < s; k++) {
      const k2 = (k + 1) % s, a0 = base + k, a1 = base + k2, b0 = base + s + k, b1 = base + s + k2;
      this.i.push(a0, a0); this.j.push(a1, b1); this.k.push(b1, b0);
    }
  }
  addPolyline(pts, radii) {
    for (let i = 0; i < pts.length - 1; i++)
      this.addFrustum(pts[i][0], pts[i][1], pts[i][2], pts[i + 1][0], pts[i + 1][1], pts[i + 1][2], radii[i], radii[i + 1]);
  }
  payload() {
    if (!this.x.length) return null;
    const rnd = a => a.map(v => Math.round(v * 10) / 10);
    return { x: rnd(this.x), y: rnd(this.y), z: rnd(this.z), i: this.i, j: this.j, k: this.k };
  }
}
function rootTubeMesh(roots, sides = 6, scale = 1.35, rMin = 0.8, rMax = 7, iters = 2) {
  const n = roots.n; if (n < 2) return null;
  const parent = roots.parent, children = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) if (parent[i] >= 0) children[parent[i]].push(i);
  let Qx = roots.nx.slice(), Qy = roots.ny.slice(), Qz = roots.nz.slice();
  for (let it = 0; it < iters; it++) {
    const nx = Qx.slice(), ny = Qy.slice(), nz = Qz.slice();
    for (let i = 0; i < n; i++) {
      if (parent[i] < 0) continue;
      const neigh = children[i].slice(); neigh.push(parent[i]);
      let sx = 0, sy = 0, sz = 0; for (const g of neigh) { sx += Qx[g]; sy += Qy[g]; sz += Qz[g]; }
      const c = neigh.length, w = 0.45;
      nx[i] = (1 - w) * Qx[i] + w * sx / c; ny[i] = (1 - w) * Qy[i] + w * sy / c; nz[i] = (1 - w) * Qz[i] + w * sz / c;
    }
    Qx = nx; Qy = ny; Qz = nz;
  }
  const acc = new TubeAccum(sides);
  for (let i = 0; i < n; i++) {
    const p = parent[i]; if (p < 0) continue;
    acc.addFrustum(Qx[p], Qy[p], Qz[p], Qx[i], Qy[i], Qz[i],
      clip(roots.radius[p] * scale, rMin, rMax), clip(roots.radius[i] * scale, rMin, rMax));
  }
  return acc.payload();
}
// ---------------------------------------------------------------------------
//  Young Rhizophora prop-root generator  (RENDERING ONLY — the physics still
//  runs on the space-colonization node tree; this is a spline overlay).
//
//  Rebuilt from scratch to reproduce a naturally growing young (~1–2 yr)
//  Rhizophora: a broad radial CAGE of long, smooth structural arches. Each root
//  behaves like a bent support beam — it leaves the stem, curves OUTWARD, reaches
//  its maximum horizontal distance, then curves DOWN and enters the mud. No
//  straight segments: every arch is a Catmull-Rom spline through five
//  morphological waypoints. Roots emerge from FIVE stem heights (overlapping
//  generations), spread ~360° with irregular spacing, taper continuously
//  (100%→70%→30%), twist slightly out of plane, differ in length/reach, and some
//  stay aerial (never reaching the mud). `p` in [0,1] drives growth: each tip
//  EXTENDS first, then the root THICKENS, and higher generations emerge later.
//  Fully deterministic from _rzParams.seed.
// ---------------------------------------------------------------------------
const _RZ = {
  barkDark: [0.34, 0.20, 0.15],    // reddish-brown older wood near the stem
  barkTan:  [0.60, 0.45, 0.32],    // warm tan toward the arch / tip
  barkGrey: [0.30, 0.26, 0.22],    // weathered grey-brown mottle patches
  lenticel: [0.66, 0.55, 0.42],    // pale corky lenticel speckle (Rhizophora signature)
  soilDark: [0.29, 0.19, 0.145],   // underground planting root — darker
  soilDeep: [0.22, 0.15, 0.12],    // deepest underground tip
};
// tunable architecture (read/patch via ENGINE.rootParams). Radii are model units;
// heights are × pod height H and reaches are × foot radius footR, so the whole
// cage scales with the model.
let _rzParams = {
  seed: 6,
  // A tight COLLAR of overlapping generations on the LOWER stem — the roots all
  // sweep DOWN from a small vertical band to an even ground circle, the classic
  // upright Rhizophora stilt-cone (matches the reference photos). Anchored just
  // above the seedling's woody hypocotyl crown (z≈0.14·H) so the cone attaches to
  // the seed body — NOT sprouting from mid-air above it.
  levels: [0.18, 0.25, 0.32],  // stem heights (× H) of the emergence collar (low=old → high=new)
  rootsPerLevel: [2, 3],       // inclusive random count per level
  minRoots: 7, maxRoots: 9,    // ~8 clean stilts (reference young trees show ~6–9)
  stemRLow: 6.5, stemRHigh: 5.5, // attach ON the thin stem surface (shoot radius ≈6) so roots meet the trunk
  reach: [0.85, 1.15],         // ground landing radius (× footR) — even cone base
  overArch: [1.00, 1.05],      // apex horizontal reach (× landing) → lands near its widest point
  apexZ: [0.40, 0.52],         // apex height between mud (0) and origin (1) — max horizontal at mid
  baseR: [2.9, 3.7],           // near-stem tube radius — slender, fairly uniform reddish stilts
  olderThick: 0.6,             // extra base radius for older/lower roots
  taperMid: 0.72, taperTip: 0.32,   // continuous taper 100% → 72% (halfway) → 32% (tip)
  twist: 0.06,                 // out-of-plane drift — small, so arches stay ~in their radial plane
  swayAmp: 0.02,               // minimal organic wobble amplitude (× reach)
  shortFrac: 0.12,             // nearly all reach the mud (one young short root at most)
  genDelay: 0.42,              // higher generations emerge this much later in p
  growSpan: 0.55,              // per-root growth window length in p
  seg: 8,                      // spline samples per waypoint segment (smooth, no straight runs)
  ugDepth: 0.05,               // short planting plunge below the mud (× H)
  ugRun: 0.14,                 // its lateral run (× reach)
};
function rootParams(overrides) {
  if (overrides) { _rzParams = Object.assign({}, _rzParams, overrides); _rzCache = null; }
  return _rzParams;
}
function _sstep(t) { t = clip(t, 0, 1); return t * t * (3 - 2 * t); }
function _smoother(t) { t = clip(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
function _lerp(a, b, t) { return a + (b - a) * t; }
function _lerp3(a, b, t) { return [_lerp(a[0], b[0], t), _lerp(a[1], b[1], t), _lerp(a[2], b[2], t)]; }
function _rgb(c) { return `rgb(${Math.round(clip(c[0], 0, 1) * 255)},${Math.round(clip(c[1], 0, 1) * 255)},${Math.round(clip(c[2], 0, 1) * 255)})`; }

// cubic Bezier interpolation of three control points → one point
function _bez3(P, Q, R, S, t) {
  const m = 1 - t, a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
  return [a * P[0] + b * Q[0] + c * R[0] + d * S[0],
          a * P[1] + b * Q[1] + c * R[1] + d * S[1],
          a * P[2] + b * Q[2] + c * R[2] + d * S[2]];
}
// ---- small spline / vector helpers for the arches ----
function _rand(rng, ab) { return ab[0] + (ab[1] - ab[0]) * rng(); }
function _pol(r, az, z) { return [r * Math.cos(az), r * Math.sin(az), z]; }
function _dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function _tint(c, f) { return [c[0] * f, c[1] * f, c[2] * f]; }
// stateless integer hash → [0,1) for per-vertex bark speckle (deterministic)
function _rhash(a, b, c) {
  let h = (((a | 0) * 374761393) + ((b | 0) * 668265263) + ((c | 0) * 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function _landDir(pts) {
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l, 0];
}
// uniform Catmull-Rom through waypoints W (each [x,y,z]); clamped ends. Returns a
// smooth polyline of [x,y,z] — guarantees a continuous curve with no straight legs.
function _catmull(W, seg) {
  const n = W.length, out = [], pt = i => W[Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pt(i - 1), p1 = pt(i), p2 = pt(i + 1), p3 = pt(i + 2), last = i === n - 2;
    for (let s = 0; s < seg + (last ? 1 : 0); s++) {
      const t = s / seg, t2 = t * t, t3 = t2 * t, o = [0, 0, 0];
      for (let d = 0; d < 3; d++)
        o[d] = 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t +
               (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 +
               (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3);
      out.push(o);
    }
  }
  return out;
}
// smooth taper 100% (stem) → mid → tip along normalised arc length t
function _taper(t) {
  const P = _rzParams;
  return t < 0.5 ? _lerp(1, P.taperMid, _smoother(t / 0.5))
                 : _lerp(P.taperMid, P.taperTip, _smoother((t - 0.5) / 0.5));
}
// one aerial prop-root arch: a bent support beam. Five morphological waypoints —
// attach → rise out → MAX horizontal → curve down → enter mud — with the azimuth
// drifting along the arch (out-of-plane twist) and small organic asymmetry. If
// `short`, the arch ends in the air (never reaches the mud). Samples = [x,y,z,r,u].
function _archStrand(o) {
  const P = _rzParams, rng = o.rng, gz = o.gz, hz = o.hz, drop = hz - gz;
  const reach = o.reach, over = reach * _rand(rng, P.overArch);
  const apexZ = gz + drop * _rand(rng, P.apexZ);
  const tw = P.twist * o.twistSign;                       // azimuth drifts as it descends
  const azAt = f => o.az + tw * f + (rng() - 0.5) * 0.05;
  const landR = o.short ? reach * _lerp(0.45, 0.72, rng()) : reach;
  const landZ = o.short ? gz + drop * _lerp(0.14, 0.42, rng()) : gz;
  const W = [
    _pol(o.stemR,                               azAt(0.00), hz),
    _pol(o.stemR + 0.28 * (reach - o.stemR),    azAt(0.15), hz - drop * 0.03),   // leave: out, starts down
    _pol(over,                                  azAt(0.45), apexZ),              // max horizontal (mid height)
    _pol(o.short ? landR * 1.02 : reach * 0.99, azAt(0.76), _lerp(apexZ, landZ, 0.55)), // curve down
    _pol(landR,                                 azAt(1.00), landZ),             // enter mud / aerial tip
  ];
  const raw = _catmull(W, P.seg), N = raw.length, cum = [0];
  for (let i = 1; i < N; i++) cum.push(cum[i - 1] + _dist(raw[i], raw[i - 1]));
  const L = cum[N - 1] || 1, pts = [];
  for (let i = 0; i < N; i++) {
    const u = cum[i] / L, p = raw[i], env = Math.sin(Math.PI * u);
    const sway = o.sway * P.swayAmp * reach * env * Math.sin(2.4 * Math.PI * u + o.phase);
    const rr = Math.hypot(p[0], p[1]) || 1;               // wobble perpendicular to the radial dir
    pts.push([p[0] - (p[1] / rr) * sway, p[1] + (p[0] / rr) * sway, p[2], o.baseR * _taper(u), u]);
  }
  return { pts, land: o.short ? null : [pts[N - 1][0], pts[N - 1][1]],
           landDir: _landDir(pts), tipR: o.baseR * P.taperTip };
}
// short underground planting root: from the landing, curves down + slightly out
// and thins to a tip, so an arch plants into the mud instead of just touching a
// plane. Samples = [x,y,z,radius,u].
function _ugPlunge(land, dir, r0, rng, phase, reach) {
  const P = _rzParams, gz = groundZ(), depth = P.ugDepth * POD.features.height;
  const run = P.ugRun * reach * (0.7 + 0.5 * rng()), dx = dir[0], dy = dir[1];
  const W = [
    [land[0], land[1], gz],
    [land[0] + dx * run * 0.55, land[1] + dy * run * 0.55, gz - depth * 0.5],
    [land[0] + dx * run, land[1] + dy * run, gz - depth],
  ];
  const raw = _catmull(W, 5), N = raw.length, pts = [];
  for (let i = 0; i < N; i++) { const u = i / (N - 1); pts.push([raw[i][0], raw[i][1], raw[i][2], _lerp(r0, r0 * 0.4, u), u]); }
  return pts;
}

let _rzCache = null;
// Build the whole prop-root cage ONCE (deterministic; cached). Each entry is a
// strand {pts,colA,colB,phase,birthP,span} that the mesher reveals + tubes by the
// growth parameter p. Five stem levels (low→high = old→new generation) each emit
// a few arches at continuously-accumulating, irregular azimuths so generations
// interleave and the landing points form an irregular ~360° circle. Each grounded
// arch adds one short underground planting root; some upper arches stay aerial.
function _rzForest() {
  if (_rzCache) return _rzCache;
  const P = _rzParams, H = POD.features.height, footR = rOuterAt(0.05 * H), gz = groundZ();
  const rng = mulberry32(P.seed), strands = [], landings = [], nL = P.levels.length;
  // per-level counts, clamped so the total visible arch count lands in [min,max]
  const counts = P.levels.map(() => P.rootsPerLevel[0] +
    Math.floor(rng() * (P.rootsPerLevel[1] - P.rootsPerLevel[0] + 1)));
  let total = counts.reduce((a, b) => a + b, 0);
  while (total < P.minRoots) { counts[Math.floor(rng() * nL)]++; total++; }
  while (total > P.maxRoots) { const k = Math.floor(rng() * nL); if (counts[k] > 1) { counts[k]--; total--; } }
  let az = rng() * Math.PI * 2;                     // continuous azimuth accumulator
  const step = Math.PI * 2 / total;                 // even base spacing over all roots
  for (let li = 0; li < nL; li++) {
    const gen = nL > 1 ? li / (nL - 1) : 0, older = 1 - gen;
    const hz = P.levels[li] * H, stemR = _lerp(P.stemRLow, P.stemRHigh, gen);
    for (let r = 0; r < counts[li]; r++) {
      az += step * (0.82 + 0.36 * rng());                           // mild jitter — even cone, not chaotic
      const reach = footR * _rand(rng, P.reach) * (1 + older * 0.14);
      const baseR = _rand(rng, P.baseR) + older * P.olderThick;
      const short = rng() < P.shortFrac && li >= 1;                 // some upper roots stay aerial
      const phase = rng() * 6.283, tint = 0.9 + 0.2 * rng();
      const birthP = clip(gen * P.genDelay + (rng() - 0.5) * 0.06, 0, 0.9);   // higher emerge later
      const span = P.growSpan * (0.85 + 0.3 * rng());
      const a = _archStrand({ hz, az: az + (rng() - 0.5) * 0.12, stemR, reach, baseR, gz,
        twistSign: rng() < 0.5 ? -1 : 1, sway: 0.6 + 0.8 * rng(), phase, rng, short });
      strands.push({ pts: a.pts, colA: _tint(_RZ.barkDark, tint), colB: _tint(_RZ.barkTan, tint),
        phase, birthP, span: span * 0.62 });
      if (!short && a.land) {
        landings.push(a.land);
        strands.push({ pts: _ugPlunge(a.land, a.landDir, a.tipR, rng, phase, reach),
          colA: _tint(_RZ.soilDark, tint), colB: _RZ.soilDeep,
          phase, birthP: clip(birthP + span * 0.55, 0, 0.95), span: span * 0.5 });
      }
    }
  }
  _rzCache = { strands, landings };
  return _rzCache;
}
function rhizophoreStrands() { return _rzForest().strands; }

function stageRootMesh(p) {
  const strands = rhizophoreStrands();
  const gz = groundZ();
  const X = [], Y = [], Z = [], I = [], J = [], K = [], C = [];
  const sides = 8, cs = [], sn = [];
  for (let k = 0; k < sides; k++) { const A = 2 * Math.PI * k / sides; cs.push(Math.cos(A)); sn.push(Math.sin(A)); }
  for (let sIdx = 0; sIdx < strands.length; sIdx++) {
    const st = strands[sIdx];
    const gf = clip((p - st.birthP) / st.span, 0, 1);
    if (gf <= 0.02) continue;
    // growth order: the tip extends first (gf reveals length), then the root
    // thickens afterwards (thicken lags the length by ~35%).
    const thicken = 0.5 + 0.5 * clip((p - st.birthP) / (st.span * 1.35), 0, 1);
    const full = st.pts, nFull = full.length;
    const fT = gf * (nFull - 1), last = Math.floor(fT), frac = fT - last;
    const draw = [];
    for (let i = 0; i <= last; i++) draw.push(full[i]);
    if (frac > 1e-3 && last < nFull - 1) {
      const a = full[last], b = full[last + 1];
      draw.push([_lerp(a[0], b[0], frac), _lerp(a[1], b[1], frac), _lerp(a[2], b[2], frac),
                 _lerp(a[3], b[3], frac), _lerp(a[4], b[4], frac)]);
    }
    if (draw.length < 2) continue;
    const ringBase = [];
    for (let i = 0; i < draw.length; i++) {
      const P = draw[i], u = P[4];
      let tx, ty, tz;
      if (i < draw.length - 1) { tx = draw[i + 1][0] - P[0]; ty = draw[i + 1][1] - P[1]; tz = draw[i + 1][2] - P[2]; }
      else { tx = P[0] - draw[i - 1][0]; ty = P[1] - draw[i - 1][1]; tz = P[2] - draw[i - 1][2]; }
      const [n1x, n1y, n1z, n2x, n2y, n2z] = frame(tx, ty, tz);
      const base = _lerp3(st.colA, st.colB, u);
      let ao = 1;
      const dg = Math.abs(P[2] - gz);
      if (dg < 6) ao *= _lerp(0.82, 1, clip(dg / 6, 0, 1));    // mud-contact darkening
      if (u < 0.08) ao *= _lerp(0.8, 1, clip(u / 0.08, 0, 1)); // AO where the root meets the trunk
      ringBase.push(X.length);
      // irregular diameter (low-freq knuckling) so roots aren't perfect cylinders
      const knuck = 1 + 0.05 * (_vnoise(sIdx * 3.1 + i * 0.4, sIdx * 0.7) - 0.5) * 2;
      const rr = P[3] * thicken * knuck;
      for (let k = 0; k < sides; k++) {
        X.push(P[0] + rr * (cs[k] * n1x + sn[k] * n2x));
        Y.push(P[1] + rr * (cs[k] * n1y + sn[k] * n2y));
        Z.push(P[2] + rr * (cs[k] * n1z + sn[k] * n2z));
        const ang = 2 * Math.PI * k / sides;
        // bark relief: longitudinal furrows (two harmonics), shaded in the grooves
        const ridge = 1 + 0.06 * Math.cos(2 * ang + st.phase) + 0.03 * Math.cos(3 * ang - i * 0.6);
        // patchy grey-brown weathering
        let col = _lerp3(base, _RZ.barkGrey, 0.30 * _vnoise(sIdx * 5.7 + i * 0.8, k * 1.7 + sIdx * 2.3));
        // Rhizophora lenticels: sparse pale corky speckle + occasional dark pit
        const hsh = _rhash(sIdx, i, k);
        if (hsh > 0.90) col = _lerp3(col, _RZ.lenticel, 0.6);
        else if (hsh < 0.07) col = [col[0] * 0.72, col[1] * 0.72, col[2] * 0.72];
        const shade = ao * ridge;
        C.push(_rgb([col[0] * shade, col[1] * shade, col[2] * shade]));
      }
    }
    for (let i = 0; i < draw.length - 1; i++) {
      const s0 = ringBase[i], s1 = ringBase[i + 1];
      for (let k = 0; k < sides; k++) { const k2 = (k + 1) % sides; I.push(s0 + k, s0 + k); J.push(s0 + k2, s1 + k2); K.push(s1 + k2, s1 + k); }
    }
  }
  if (!X.length) return null;
  const rnd = v => Math.round(v * 10) / 10;
  return { x: X.map(rnd), y: Y.map(rnd), z: Z.map(rnd), i: I, j: J, k: K, vertexcolor: C };
}

// ---------------------------------------------------------------------------
//  substrate / tidal-mud ground plane. An organic (irregular, non-circular) mud
//  patch — mottled texture + micro-relief, patchy wet/dry tidal sheen, a
//  DIRECTIONAL cast shadow of the pod (offset opposite the sun), and small
//  mounds + ambient occlusion where each root presses into the mud so roots
//  blend in rather than meeting a hard plane. Baked into vertex colours + z;
//  `reveal` grows it in, `opts` = { sunx, suny, landings:[[x,y]…] }.
// ---------------------------------------------------------------------------
// mud surface sits just ABOVE the foot tips (which bottom out at z=0) so the 4
// feet visibly press into / are partly embedded in the mud, not floating over it
function groundZ() { return 0.03 * POD.features.height; }
function rootLandings() { return _rzForest().landings; }
// --- deterministic value-noise FBM (procedural mudflat terrain + texture) -----
function _vhash(ix, iy) { let h = (ix | 0) * 374761393 + (iy | 0) * 668265263; h = (h ^ (h >> 13)) * 1274126177; h ^= h >> 16; return ((h >>> 0) % 100003) / 100003; }
function _vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = _vhash(ix, iy), b = _vhash(ix + 1, iy), c = _vhash(ix, iy + 1), d = _vhash(ix + 1, iy + 1);
  return _lerp(_lerp(a, b, ux), _lerp(c, d, ux), uy);
}
function _fbm(x, y, oct) { let f = 0, amp = 0.5, freq = 1, sum = 0; const O = oct || 4; for (let o = 0; o < O; o++) { f += amp * _vnoise(x * freq, y * freq); sum += amp; amp *= 0.5; freq *= 2.03; } return f / sum; }
const _WATER_DROP = 4.5;                         // water sits this far below mean mud → puddles in troughs
function _waterZ() { return groundZ() - _WATER_DROP; }
// procedural mudflat surface height at (x,y): broad FBM elevation + finer ridges
// + shallow drainage channels + small sediment clumps + pressed-in root prints.
function _mudZ(x, y, landings) {
  const zG = groundZ(), footR = rOuterAt(0.05 * POD.features.height), sig = Math.max(9, 0.09 * footR);
  let z = zG + 6.0 * (_fbm(x * 0.012 + 3.1, y * 0.012 + 7.7, 5) - 0.5) * 2
             + 2.4 * (_fbm(x * 0.05 + 11, y * 0.05 + 2, 3) - 0.5) * 2;
  const ch = Math.abs(_fbm(x * 0.02 + 20, y * 0.02 + 40, 3) - 0.5);      // shallow drainage channels
  z -= 3.0 * clip(1 - ch / 0.06, 0, 1);
  const cl = _fbm(x * 0.13 + 50, y * 0.13 + 9, 2);                       // small sediment clumps
  if (cl > 0.70) z += 3.0 * (cl - 0.70) / 0.30;
  if (landings) for (const L of landings) {                             // root indentation: raised rim + deeper dip
    const dd = (x - L[0]) * (x - L[0]) + (y - L[1]) * (y - L[1]);
    z += 1.8 * Math.exp(-dd / (2 * sig * sig)) - 3.0 * Math.exp(-dd / (2 * (sig * 0.5) * (sig * 0.5)));
  }
  return z;
}
// Procedural mangrove MUDFLAT. Uneven FBM terrain (ridges, channels, puddles,
// sediment clumps), wet/dry albedo blended by distance-to-water (height above
// the water level), drying-crack network on the exposed mud, per-root wet rings
// + ripple + AO, pod contact-AO + directional cast shadow, and a shoreline that
// dissolves into the surrounding water. Everything is baked into vertex Z +
// vertexcolor (Plotly Mesh3d has no textures/normal/roughness maps).
function groundMesh(nR = 44, nT = 170, reveal = 1, opts) {
  opts = opts || {};
  reveal = clip(reveal, 0, 1);
  const H = POD.features.height, zG = groundZ(), footR = rOuterAt(0.05 * H), waterZ = _waterZ();
  const Rmax = 2.2 * footR * (0.14 + 0.86 * reveal);
  const sux = opts.sunx != null ? opts.sunx : 0.834, suy = opts.suny != null ? opts.suny : 0.551;
  const landings = opts.landings || [];
  const sig = Math.max(9, 0.09 * footR);
  const edgeDark = [0.05, 0.06, 0.07];
  const dryLo = [0.20, 0.15, 0.11], dryHi = [0.44, 0.33, 0.23];   // dry mud dark→light (exposed, lighter)
  const wetMud = [0.13, 0.13, 0.12], waterCol = [0.06, 0.095, 0.105];
  const rShIn = 0.28 * footR, rShOut = 1.5 * footR;
  const shcx = -sux * 0.5 * footR, shcy = -suy * 0.5 * footR;
  const sgx = sux * 0.55 * Rmax, sgy = suy * 0.55 * Rmax;
  const X = [], Y = [], Z = [], C = [], I = [], J = [], K = [];
  const bnd = (a) => 0.70 + 0.30 * (0.5 + 0.5 * (Math.sin(3 * a + 0.6) * 0.6 + Math.sin(5 * a - 1.3) * 0.4)) + 0.05 * Math.sin(11 * a + 2.0);
  const colAt = (x, y, z) => {
    const d = Math.hypot(x, y), rn = clip(d / Rmax, 0, 1);
    const grain = _fbm(x * 0.09 + 1, y * 0.09 + 4, 3);                  // fine mud grain (albedo)
    let c = _lerp3(dryLo, dryHi, clip(0.25 + 0.75 * grain, 0, 1));
    // wet/dry blend by distance-to-water (height above the water level)
    const w = clip((waterZ + 7 - z) / 7, 0, 1);
    c = _lerp3(c, wetMud, 0.85 * w);
    const pool = clip((waterZ - z) / 2.2, 0, 1);                        // standing water in the troughs
    c = _lerp3(c, waterCol, 0.92 * pool);
    // drying cracks: iso-contour of an FBM, only on dry exposed mud
    const cf = Math.abs(_fbm(x * 0.06 + 31, y * 0.06 + 63, 3) - 0.5);
    const crack = clip(1 - cf / 0.02, 0, 1) * (1 - w) * (1 - pool);
    c = [c[0] * (1 - 0.55 * crack), c[1] * (1 - 0.55 * crack), c[2] * (1 - 0.5 * crack)];
    // tight contact AO under the pod + directional cast shadow (opposite the sun)
    const ao = 0.55 + 0.45 * _smoother((d - rShIn) / (rShOut - rShIn));
    const dx = x - shcx, dy = y - shcy, along = dx * sux + dy * suy, across = -dx * suy + dy * sux;
    const cast = 0.5 + 0.5 * _smoother(clip(Math.hypot(along / (1.7 * footR), across / (0.85 * footR)), 0, 1));
    c = [c[0] * ao * cast, c[1] * ao * cast, c[2] * ao * cast];
    // wet sheen / soft reflection toward the sun (strong on wet + pooled mud)
    const sheen = Math.pow(clip(1 - Math.hypot(x - sgx, y - sgy) / (0.95 * Rmax), 0, 1), 2) * (0.35 + 0.65 * w) * (0.6 + 0.4 * pool);
    const s2 = 0.14 * sheen;
    c = [c[0] + s2 * 0.7, c[1] + s2, c[2] + s2 * 1.3];
    // per-root wet ring: darker wet mud + AO + a faint concentric ripple
    for (const L of landings) {
      const dr = Math.hypot(x - L[0], y - L[1]);
      if (dr < sig * 2.4) {
        const wr = clip(1 - dr / (sig * 2.4), 0, 1);
        c = _lerp3(c, wetMud, 0.5 * wr * wr);
        const ao2 = 0.6 + 0.4 * _smoother(dr / (sig * 1.3));
        const rip = 0.03 * Math.cos(dr * 0.45 - 2.0) * wr;
        c = [c[0] * ao2 + rip * 0.7, c[1] * ao2 + rip, c[2] * ao2 + rip * 1.2];
      }
    }
    // shoreline: mud blends into the surrounding water, then dissolves to background
    c = _lerp3(c, waterCol, _smoother((rn - 0.80) / 0.18));
    c = _lerp3(c, edgeDark, _smoother((rn - 0.93) / 0.07));
    return c;
  };
  { const z0 = _mudZ(0, 0, landings); X.push(0); Y.push(0); Z.push(z0); C.push(_rgb(colAt(0, 0, z0))); }
  const starts = [0];
  for (let ri = 1; ri <= nR; ri++) {
    starts.push(X.length);
    for (let t = 0; t < nT; t++) {
      const a = 2 * Math.PI * t / nT, rr = Rmax * bnd(a) * Math.pow(ri / nR, 1.15);
      const x = rr * Math.cos(a), y = rr * Math.sin(a), z = _mudZ(x, y, landings);
      X.push(x); Y.push(y); Z.push(z); C.push(_rgb(colAt(x, y, z)));
    }
  }
  const r1 = starts[1];
  for (let t = 0; t < nT; t++) { const t2 = (t + 1) % nT; I.push(0); J.push(r1 + t); K.push(r1 + t2); }
  for (let ri = 1; ri < nR; ri++) {
    const s0 = starts[ri], s1 = starts[ri + 1];
    for (let t = 0; t < nT; t++) { const t2 = (t + 1) % nT; I.push(s0 + t, s0 + t); J.push(s0 + t2, s1 + t2); K.push(s1 + t2, s1 + t); }
  }
  const rnd = v => Math.round(v * 10) / 10;
  return { x: X.map(rnd), y: Y.map(rnd), z: Z.map(rnd), i: I, j: J, k: K, vertexcolor: C };
}
// Surrounding shallow tidal water + the surface that fills the mud troughs. A
// large, gently-rippled disc at the water level that extends BEYOND the mud, so
// the shoreline dissolves into open water instead of ending on a hard edge.
// Baked sun-glint streaks read as soft reflections (Plotly has no real
// reflection/refraction); rendered with high specular for a wet sheen.
function waterMesh(nR = 26, nT = 120, reveal = 1, opts) {
  opts = opts || {};
  reveal = clip(reveal, 0, 1);
  const footR = rOuterAt(0.05 * POD.features.height), wZ = _waterZ();
  const Rw = 2.95 * footR * (0.2 + 0.8 * reveal);
  const sux = opts.sunx != null ? opts.sunx : 0.834, suy = opts.suny != null ? opts.suny : 0.551;
  const deep = [0.05, 0.085, 0.10], shallow = [0.09, 0.13, 0.14], bg = [0.05, 0.06, 0.07];
  const sgx = sux * 0.4 * Rw, sgy = suy * 0.4 * Rw;
  const X = [], Y = [], Z = [], C = [], I = [], J = [], K = [];
  const colAt = (x, y) => {
    const d = Math.hypot(x, y), rn = clip(d / Rw, 0, 1);
    let c = _lerp3(shallow, deep, _smoother(rn));
    const g = Math.pow(clip(1 - Math.hypot(x - sgx, y - sgy) / (0.8 * Rw), 0, 1), 2);   // sun-glint highlight
    const band = 0.5 + 0.5 * Math.sin((x * sux + y * suy) * 0.05);                       // broken into streaks
    const gl = 0.22 * g * (0.4 + 0.6 * band);
    c = [c[0] + gl * 0.8, c[1] + gl, c[2] + gl * 1.2];
    return _lerp3(c, bg, _smoother((rn - 0.82) / 0.18));               // dissolve at the far rim
  };
  const zAt = (x, y) => wZ + 0.6 * (_fbm(x * 0.03 + 80, y * 0.03 + 30, 3) - 0.5) * 2;   // tiny ripple
  { X.push(0); Y.push(0); Z.push(zAt(0, 0)); C.push(_rgb(colAt(0, 0))); }
  const starts = [0];
  for (let ri = 1; ri <= nR; ri++) {
    starts.push(X.length);
    for (let t = 0; t < nT; t++) {
      const a = 2 * Math.PI * t / nT, rr = Rw * Math.pow(ri / nR, 1.1);
      const x = rr * Math.cos(a), y = rr * Math.sin(a);
      X.push(x); Y.push(y); Z.push(zAt(x, y)); C.push(_rgb(colAt(x, y)));
    }
  }
  const r1 = starts[1];
  for (let t = 0; t < nT; t++) { const t2 = (t + 1) % nT; I.push(0); J.push(r1 + t); K.push(r1 + t2); }
  for (let ri = 1; ri < nR; ri++) {
    const s0 = starts[ri], s1 = starts[ri + 1];
    for (let t = 0; t < nT; t++) { const t2 = (t + 1) % nT; I.push(s0 + t, s0 + t); J.push(s0 + t2, s1 + t2); K.push(s1 + t2, s1 + t); }
  }
  const rnd = v => Math.round(v * 10) / 10;
  return { x: X.map(rnd), y: Y.map(rnd), z: Z.map(rnd), i: I, j: J, k: K, vertexcolor: C };
}
// Sparse scattered organic debris on the mudflat — shell + pebble bumps, fallen
// mangrove leaves, tiny sticks, algae patches. One welded mesh, deterministic
// placement, resting on the mud surface, kept clear of the pod base.
function debrisMesh(opts) {
  opts = opts || {};
  const footR = rOuterAt(0.05 * POD.features.height), Rmax = 2.2 * footR;
  const landings = opts.landings || [];
  const rng = mulberry32(opts.seed || 77);
  const M = { x: [], y: [], z: [], c: [], i: [], j: [], k: [] };
  const quad = (cx, cy, cz, l, w, ang, tilt, col) => {
    const ca = Math.cos(ang), sa = Math.sin(ang), b = M.x.length;
    for (const [u, v] of [[-l, -w], [l, -w], [l, w], [-l, w]]) {
      M.x.push(cx + u * ca - v * sa); M.y.push(cy + u * sa + v * ca); M.z.push(cz + tilt * u); M.c.push(col);
    }
    M.i.push(b, b); M.j.push(b + 1, b + 2); M.k.push(b + 2, b + 3);
  };
  const dome = (cx, cy, cz, r, h, col, colTop) => {
    const b = M.x.length;
    for (let k = 0; k < 5; k++) { const a = k * 2 * Math.PI / 5 + 0.3; M.x.push(cx + r * Math.cos(a)); M.y.push(cy + r * Math.sin(a)); M.z.push(cz); M.c.push(col); }
    M.x.push(cx); M.y.push(cy); M.z.push(cz + h); M.c.push(colTop); const ap = b + 5;
    for (let k = 0; k < 5; k++) { const k2 = (k + 1) % 5; M.i.push(b + k); M.j.push(b + k2); M.k.push(ap); }
  };
  const N = opts.count || 54;
  for (let n = 0; n < N; n++) {
    const a = rng() * 2 * Math.PI, rr = (0.42 + 0.5 * Math.sqrt(rng())) * Rmax;   // sqrt → even area density
    const x = rr * Math.cos(a), y = rr * Math.sin(a);
    if (Math.hypot(x, y) < 0.62 * footR) continue;                                // keep clear of the pod base
    const z = _mudZ(x, y, landings) + 0.4, rot = rng() * Math.PI * 2, sz = 3 + rng() * 4, kind = rng();
    if (kind < 0.30) { const g = 0.42 + 0.18 * rng(); dome(x, y, z, sz * 0.6, sz * 0.35, [g * 0.85, g * 0.82, g * 0.78], [g, g, g * 0.95]); }        // pebble
    else if (kind < 0.44) { const g = 0.70 + 0.15 * rng(); dome(x, y, z, sz * 0.55, sz * 0.3, [g * 0.8, g * 0.78, g * 0.7], [g, g * 0.97, g * 0.9]); } // shell
    else if (kind < 0.72) { const col = rng() < 0.5 ? [0.34, 0.26, 0.14] : [0.30, 0.33, 0.17]; quad(x, y, z, sz * 1.4, sz * 0.6, rot, 0.03 * sz, col); } // fallen leaf
    else if (kind < 0.88) { quad(x, y, z, sz * 1.9, sz * 0.16, rot, 0.02 * sz, [0.26, 0.19, 0.12]); }                                                    // stick
    else { quad(x, y, z - 0.2, sz * 1.1, sz * 0.8, rot, 0.0, [0.10, 0.20, 0.12]); }                                                                      // algae / seaweed
  }
  if (!M.x.length) return null;
  const rnd = v => Math.round(v * 10) / 10;
  return { x: M.x.map(rnd), y: M.y.map(rnd), z: M.z.map(rnd), i: M.i, j: M.j, k: M.k, vertexcolor: M.c.map(_rgb) };
}

// A soft CONTACT SHADOW disc for the Story page — the way a product page floats
// an object on a light plinth. A flat disc under the pod whose colour fades from
// a soft warm shadow at the centre to the exact page background at the rim (so
// the edge dissolves — no hard ellipse). Offset gently opposite the light and
// stretched into a soft ellipse. NOT the textured mud plane (that stays on the
// Design Tool where the substrate is functionally meaningful).
function contactShadow(opts) {
  opts = opts || {};
  const f = POD.features, footR = rOuterAt(0.05 * f.height);
  const R = (opts.radius || 1.42) * footR, z0 = opts.z != null ? opts.z : -0.4;
  const bg = opts.bg || [0.957, 0.937, 0.902];      // page background rgb (0..1)
  const sh = opts.shadow || [0.79, 0.75, 0.68];     // soft shadow centre
  const sux = opts.sunx != null ? opts.sunx : 0.83, suy = opts.suny != null ? opts.suny : 0.55;
  const nR = 44, nT = 100, X = [], Y = [], Z = [], C = [], I = [], J = [], K = [];
  const ocx = -sux * 0.22 * footR, ocy = -suy * 0.22 * footR;   // centre offset opposite the light
  const colAt = (x, y) => {
    const dx = x - ocx, dy = y - ocy;
    const along = dx * sux + dy * suy, across = -dx * suy + dy * sux;
    const e = Math.hypot(along / (1.14 * footR), across / (0.94 * footR));  // soft ellipse, longer away from light
    return _rgb(_lerp3(sh, bg, _smoother(clip(e, 0, 1))));
  };
  X.push(ocx); Y.push(ocy); Z.push(z0); C.push(colAt(ocx, ocy));
  const starts = [0];
  for (let ri = 1; ri <= nR; ri++) {
    starts.push(X.length);
    for (let t = 0; t < nT; t++) {
      const a = 2 * Math.PI * t / nT, rr = R * (ri / nR);
      const x = ocx + rr * Math.cos(a), y = ocy + rr * Math.sin(a);
      X.push(x); Y.push(y); Z.push(z0); C.push(colAt(x, y));
    }
  }
  const r1 = starts[1];
  for (let t = 0; t < nT; t++) { const t2 = (t + 1) % nT; I.push(0); J.push(r1 + t); K.push(r1 + t2); }
  for (let ri = 1; ri < nR; ri++) {
    const s0 = starts[ri], s1 = starts[ri + 1];
    for (let t = 0; t < nT; t++) { const t2 = (t + 1) % nT; I.push(s0 + t, s0 + t); J.push(s0 + t2, s1 + t2); K.push(s1 + t2, s1 + t); }
  }
  return { x: X, y: Y, z: Z, i: I, j: J, k: K, vertexcolor: C };
}

function seamAngles() {
  const s = POD.features.slots; return s.length ? s.map(x => x.theta_deg) : POD.features.split_line_deg.slice();
}
// A thin, uniform molded parting line running the full length of each seam
// (rim -> foot), sitting right at the surface so it reads as a deliberate
// scored/molded product feature rather than a raised gold pipe.
function seamTubeMesh(sides = 6, npt = 80, lift = 1.004) {
  const H = POD.features.height, angles = seamAngles();
  const radius = Math.max(0.5, 0.011 * POD.features.outer_r_waist);
  const acc = new TubeAccum(sides);
  const z = []; for (let i = 0; i < npt; i++) z.push(0.02 * H + (0.985 * H - 0.02 * H) * i / (npt - 1));
  for (const a of angles) {
    const ar = a * Math.PI / 180, pts = [], radii = [];
    for (let i = 0; i < npt; i++) { const rr = rOuterAt(z[i]) * lift; pts.push([rr * Math.cos(ar), rr * Math.sin(ar), z[i]]); radii.push(radius); }
    acc.addPolyline(pts, radii);
  }
  return acc.payload();
}

// Split the pod into 4 clean quarter-pieces by CLIPPING each triangle against
// the two seam-meridian half-planes that bound its wedge. New vertices land
// exactly on the seam line, so every piece has a straight, manufactured-looking
// score edge (independent of the shell's non-manifold slot cuts) — no jagged
// tear. Each piece is then drifted radially outward by `gapFrac` of the waist.
function _clipPoly(poly, dv) {
  const out = [], n = poly.length;
  for (let i = 0; i < n; i++) {
    const A = poly[i], B = poly[(i + 1) % n], dA = dv[i], dB = dv[(i + 1) % n];
    const inA = dA >= 0, inB = dB >= 0;
    if (inA) out.push(A);
    if (inA !== inB) {
      const t = dA / (dA - dB);
      out.push({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, z: A.z + (B.z - A.z) * t,
                 o: -1, orig: (t < 0.5 ? A.orig : B.orig) });
    }
  }
  return out;
}
function explodedSectors(gapFrac = 0.30) {
  let seams = seamAngles().map(a => ((a + 180) % 360 + 360) % 360 - 180).sort((a, b) => a - b);
  if (seams.length < 2) seams = [-135, -45, 45, 135];
  const K = seams.length, nF = POD.nF, V = POD.V, F = POD.F, D2R = Math.PI / 180;
  const gap = gapFrac * POD.features.outer_r_waist, sectors = [];
  for (let k = 0; k < K; k++) {
    const gLo = seams[k], gHi = seams[(k + 1) % K] + (k === K - 1 ? 360 : 0);
    const cc = (gLo + gHi) / 2 * D2R, cdx = Math.cos(cc), cdy = Math.sin(cc);
    const loC = gLo * D2R, hiC = gHi * D2R;
    const cosLo = Math.cos(loC), sinLo = Math.sin(loC), cosHi = Math.cos(hiC), sinHi = Math.sin(hiC);
    // inside the wedge (width < 180°): dLo >= 0 (above lower seam) & dHi >= 0 (below upper seam)
    const dLo = (x, y) => y * cosLo - x * sinLo;
    const dHi = (x, y) => x * sinHi - y * cosHi;
    const xs = [], ys = [], zs = [], orig = [], ii = [], jj = [], kk = [], remap = new Map();
    const emit = (P) => {
      if (P.o >= 0) {
        let id = remap.get(P.o);
        if (id === undefined) { id = xs.length; remap.set(P.o, id); xs.push(P.x + gap * cdx); ys.push(P.y + gap * cdy); zs.push(P.z); orig.push(P.orig); }
        return id;
      }
      const id = xs.length; xs.push(P.x + gap * cdx); ys.push(P.y + gap * cdy); zs.push(P.z); orig.push(P.orig);
      return id;
    };
    for (let f = 0; f < nF; f++) {
      let poly = [];
      for (let t = 0; t < 3; t++) { const v = F[3 * f + t]; poly.push({ x: V[3 * v], y: V[3 * v + 1], z: V[3 * v + 2], o: v, orig: v }); }
      poly = _clipPoly(poly, poly.map(p => dLo(p.x, p.y))); if (poly.length < 3) continue;
      poly = _clipPoly(poly, poly.map(p => dHi(p.x, p.y))); if (poly.length < 3) continue;
      const idx = poly.map(emit);
      for (let t = 1; t < idx.length - 1; t++) { ii.push(idx[0]); jj.push(idx[t]); kk.push(idx[t + 1]); }
    }
    if (!xs.length) continue;
    const rnd = v => Math.round(v * 10) / 10;
    sectors.push({ x: xs.map(rnd), y: ys.map(rnd), z: zs.map(rnd), i: ii, j: jj, k: kk, orig, cdx, cdy });
  }
  return sectors;
}

// ---------------------------------------------------------------------------
//  propagule / seedling body — fills the cavity (the pod is a thin shell; in
//  reality it houses the propagule the roots grow from). A tapered spindle
//  (surface of revolution) following the inner bore, pointed at the base.
// ---------------------------------------------------------------------------
function propaguleMesh(nTheta = 26, nZ = 48, fillFrac = 0.72) {
  const H = POD.features.height;
  const zTop = 0.955 * H, zBot = 0.06 * H;
  const maxR = 1.35 * POD.features.inner_r_waist;
  const X = [], Y = [], Z = [], I = [], J = [], K = [], ringStart = [];
  for (let k = 0; k < nZ; k++) {
    const t = k / (nZ - 1);
    const z = zBot + (zTop - zBot) * t;
    const botT = Math.min(1, t / 0.12);                         // pointed base
    const topT = Math.min(1, Math.pow(Math.max(1 - t, 0) / 0.16, 0.7)); // rounded tip
    const taper = Math.max(0, Math.min(botT, topT));
    const r = Math.min(fillFrac * rInnerAt(z), maxR) * taper;
    ringStart.push(X.length);
    for (let j = 0; j < nTheta; j++) {
      const a = 2 * Math.PI * j / nTheta;
      X.push(r * Math.cos(a)); Y.push(r * Math.sin(a)); Z.push(z);
    }
  }
  for (let k = 0; k < nZ - 1; k++) {
    for (let j = 0; j < nTheta; j++) {
      const j2 = (j + 1) % nTheta;
      const a0 = ringStart[k] + j, a1 = ringStart[k] + j2, b0 = ringStart[k + 1] + j, b1 = ringStart[k + 1] + j2;
      I.push(a0, a0); J.push(a1, b1); K.push(b1, b0);
    }
  }
  const topC = X.length; X.push(0); Y.push(0); Z.push(zTop);
  const botC = X.length; X.push(0); Y.push(0); Z.push(zBot);
  for (let j = 0; j < nTheta; j++) {
    const j2 = (j + 1) % nTheta;
    I.push(topC); J.push(ringStart[nZ - 1] + j2); K.push(ringStart[nZ - 1] + j);
    I.push(botC); J.push(ringStart[0] + j); K.push(ringStart[0] + j2);
  }
  const rnd = a => a.map(v => Math.round(v * 10) / 10);
  return { x: rnd(X), y: rnd(Y), z: rnd(Z), i: I, j: J, k: K };
}

// ---------------------------------------------------------------------------
//  base mesh trace (region-coloured) for the viewer
// ---------------------------------------------------------------------------
function regionLabels() {
  const f = POD.features, z = POD.zFace, nF = POD.nF, th = POD.thetaFace, lab = new Int32Array(nF).fill(1);
  for (let i = 0; i < nF; i++) {
    const zz = z[i];
    if (zz < f.z_base_top) lab[i] = 0;
    if (zz >= f.z_waist_lo && zz <= f.z_waist_hi) lab[i] = 2;
    if (zz > f.z_trumpet_bottom) lab[i] = 5;
    if (zz > f.z_waist_hi && zz <= f.z_trumpet_bottom) lab[i] = 4;
  }
  for (const s of f.slots)
    for (let i = 0; i < nF; i++) {
      const ad = angdiff(th[i] * 180 / Math.PI, s.theta_deg);
      if (ad < s.width_deg / 2 + 3 && z[i] > s.z_lo - 6 && z[i] < s.z_hi + 6) lab[i] = 3;
    }
  return lab;
}
function baseMesh() {
  const lab = regionLabels(), fv = new Float64Array(POD.nF);
  for (let i = 0; i < POD.nF; i++) fv[i] = lab[i];
  const vert = faceFieldToVertex(fv);
  const F = POD.F, nF = POD.nF;
  const ii = new Int32Array(nF), jj = new Int32Array(nF), kk = new Int32Array(nF);
  for (let f = 0; f < nF; f++) { ii[f] = F[3 * f]; jj[f] = F[3 * f + 1]; kk[f] = F[3 * f + 2]; }
  const x = new Float64Array(POD.nV), y = new Float64Array(POD.nV), z = new Float64Array(POD.nV);
  for (let v = 0; v < POD.nV; v++) { x[v] = POD.V[3 * v]; y[v] = POD.V[3 * v + 1]; z[v] = POD.V[3 * v + 2]; }
  return {
    type: "mesh3d", x: Array.from(x), y: Array.from(y), z: Array.from(z),
    i: Array.from(ii), j: Array.from(jj), k: Array.from(kk),
    intensity: Array.from(vert),
    colorscale: [[0.0, "#b5834a"], [0.2, "#9fb0bf"], [0.4, "#4a76b5"], [0.6, "#d63b3b"], [0.8, "#9fb0bf"], [1.0, "#5aa469"]],
    cmin: 0, cmax: 5, showscale: false, name: "pod wall", hoverinfo: "skip",
  };
}

// ---------------------------------------------------------------------------
//  cfg -> pattern / params
// ---------------------------------------------------------------------------
function patternFromCfg(cfg) {
  if ((cfg.pattern || "as-drawn") === "as-drawn") {
    const pat = detectedPattern();
    if (cfg.seam_score !== "" && cfg.seam_score != null) pat.seam_score = +cfg.seam_score;
    if (cfg.seam_width_deg !== "" && cfg.seam_width_deg != null) pat.seam_width_deg = +cfg.seam_width_deg;
    pat.name = "as-drawn"; return pat;
  }
  const o = { name: cfg.name || "custom", align: cfg.align || "feet" };
  for (const key of ["n_slots"]) if (cfg[key] != null && cfg[key] !== "") o[key] = Math.round(+cfg[key]);
  for (const key of ["slot_length_frac", "slot_width_deg", "slot_z_center_frac", "theta_offset_deg", "split_score", "split_depth_frac", "seam_score", "seam_width_deg"])
    if (cfg[key] != null && cfg[key] !== "") o[key] = +cfg[key];
  return parametricPattern(o);
}
function growthFromCfg(cfg) {
  const gp = Object.assign({}, G_DEFAULT);
  for (const key of ["down_bias", "slot_bias", "wall_bias", "step_size"]) if (cfg[key] != null && cfg[key] !== "") gp[key] = +cfg[key];
  if (cfg.n_attractors) gp.n_attractors = Math.round(+cfg.n_attractors);
  return gp;
}
function simFromCfg(cfg) {
  const sp = Object.assign({}, S_DEFAULT);
  for (const key of ["contact_stiffness", "base_wedge", "pull_assist", "span_frac"]) if (cfg[key] != null && cfg[key] !== "") sp[key] = +cfg[key];
  if (cfg.n_time_steps) sp.n_time_steps = Math.round(+cfg.n_time_steps);
  return sp;
}

// ---------------------------------------------------------------------------
//  public API — simulate / montecarlo (payloads match the old Flask endpoints)
// ---------------------------------------------------------------------------
function simulate(cfg) {
  const pat = patternFromCfg(cfg), gp = growthFromCfg(cfg), sp = simFromCfg(cfg), ph = physFromCfg(cfg);
  const wall = buildFields(pat), wm = buildWallModel(wall);
  const roots = grow(gp, +(cfg.seed || 1));
  const res = runSimulation(wm, roots, sp, ph);
  const { intensity, cmax } = vertexIntensity(res.faceField, !!cfg.project_outer, res.sigma_f_end_mpa);
  const roots_payload = rootTubeMesh(roots);
  const T = sp.n_time_steps;
  const sites = wm.labels.map((lab, i) => ({
    label: lab, is_ligament: !!wm.is_lig[i],
    activation_step: isFinite(res.activation[i]) ? res.activation[i] : null,
  }));
  const stats = {
    n_nodes: roots.n,
    mechanics: mechanicsSummary(res, wm, ph, pat, sp),
    first_crack_step: isFinite(res.firstStep) ? res.firstStep : null,
    first_crack_site: res.firstSite >= 0 ? wm.labels[res.firstSite] : null,
    breakthrough_step: isFinite(res.breakthrough) ? res.breakthrough : null,
    n_time_steps: T,
    activation_order: res.order.map(s => wm.labels[s]),
    sites, pattern: pat.name,
    slots: pat.slots.map(s => ({ theta: s.theta_deg, z_lo: s.z_lo, z_hi: s.z_hi, width: s.width_deg })),
    physical: physSummary(ph),
    breakthrough_time: spTimeContext(ph.species, isFinite(res.breakthrough) ? res.breakthrough : null, T, ph.salinity_ppt),
    first_crack_time: spTimeContext(ph.species, isFinite(res.firstStep) ? res.firstStep : null, T, ph.salinity_ppt),
    window_time: spTimeContext(ph.species, T, T, ph.salinity_ppt),
    material_card: materialCard(ph.material),
  };
  return { intensity, cmax, roots: roots_payload, stats };
}

// Triangular distribution from a published (min, best-estimate, max) — the
// standard choice when a range and a nominal are all the literature gives you.
function triangular(rng, lo, mode, hi) {
  lo = Math.min(lo, mode); hi = Math.max(hi, mode);
  const w = hi - lo; if (w < 1e-9) return mode;
  const u = rng(), c = (mode - lo) / w;
  return u < c ? lo + Math.sqrt(u * w * (mode - lo)) : hi - Math.sqrt((1 - u) * w * (hi - mode));
}
// ---------------------------------------------------------------------------
//  Monte Carlo — propagates the uncertainties that actually matter.
//  Every run resamples: the root architecture (seed + growth bias), the material
//  fracture strength across its PUBLISHED range, the root growth pressure across
//  its 0.5-1.0 MPa working range (unless you measured it in Calibration Mode),
//  and a wall-thickness moulding tolerance. "Reliability" is then a real
//  probability of release, not an artefact of one deterministic run.
// ---------------------------------------------------------------------------
// Runs as a GENERATOR so the caller can yield to the browser between draws —
// a 24-run sweep is seconds of work and must not freeze the tab.
function* montecarloIter(cfg, nRuns) {
  const pat = patternFromCfg(cfg), gp = growthFromCfg(cfg), sp = simFromCfg(cfg), ph0 = physFromCfg(cfg);
  const wall = buildFields(pat), wm = buildWallModel(wall);
  const n = clip(Math.round(nRuns || 24), 2, 120), T = sp.n_time_steps;
  const jitterRng = mulberry32(12345), jNorm = makeNormal(jitterRng);
  const mat = ph0.material, range = mat.fracture_range_mpa || [mat.fracture_strength_mpa, mat.fracture_strength_mpa];
  const first = [], brk = [], firstSite = [], orders = [], actSteps = [];
  const seamStress = [], safety = [], sampledStrength = [], sampledPressure = [];
  const cumAccum = new Float64Array(POD.nF);
  // Root architecture is by far the most expensive part of a draw and is
  // INDEPENDENT of the material properties, so cross a modest pool of grown
  // architectures against every property draw rather than regrowing each time.
  const nArch = Math.min(n, 12), archPool = [];
  // The reported mechanics must be the NOMINAL design, not whichever random
  // draw happened to be first.
  archPool[0] = grow(gp, +(cfg.seed || 1));
  const nomRes = runSimulation(wm, archPool[0], sp, ph0);
  yield { done: 0, total: n, phase: "nominal design" };
  for (let kk = 0; kk < n; kk++) {
    const ai = kk % nArch;
    if (!archPool[ai]) {
      const g = Object.assign({}, gp);
      g.slot_bias = Math.max(0.2, gp.slot_bias * (1 + 0.5 * jNorm() * 0.3));
      g.down_bias = clip(gp.down_bias * (1 + 0.5 * jNorm() * 0.3), 0.1, 1);
      archPool[ai] = grow(g, kk);
    }
    // physical uncertainty for this draw
    const ph = Object.assign({}, ph0);
    ph.sigma_f_mpa = triangular(jitterRng, range[0], mat.fracture_strength_mpa, range[1]);
    if (!ph0.calibration_active) ph.root_pressure_mpa = triangular(jitterRng, 0.5, ph0.root_pressure_mpa, 1.0);
    ph.thickness_factor = clip(1 + 0.05 * jNorm(), 0.85, 1.15);
    sampledStrength.push(+ph.sigma_f_mpa.toFixed(2));
    sampledPressure.push(+ph.root_pressure_mpa.toFixed(3));
    const res = runSimulation(wm, archPool[ai], sp, ph);
    first.push(isFinite(res.firstStep) ? res.firstStep : Infinity);
    brk.push(isFinite(res.breakthrough) ? res.breakthrough : Infinity);
    firstSite.push(res.firstSite);
    orders.push(res.order.slice());
    actSteps.push(res.activation.slice());
    // same metric the single-run panel reports, so the two agree
    const gov = governingSeamStress(wm, res, sp);
    seamStress.push(gov);
    safety.push(gov > 0 ? res.sigma_f_end_mpa / gov : Infinity);
    for (let f = 0; f < POD.nF; f++) cumAccum[f] += res.faceField[f];
    yield { done: kk + 1, total: n };
  }
  for (let f = 0; f < POD.nF; f++) cumAccum[f] /= n;
  const finite = a => a.filter(v => isFinite(v));
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : Infinity;
  const std = a => { if (!a.length) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length); };
  const reliability = brk.filter(v => isFinite(v)).length / n;
  const meanBrk = mean(finite(brk)), meanFirst = mean(finite(first));
  // first-site counts
  const fsc = {}; for (const s of firstSite) if (s >= 0) { const lab = wm.labels[s]; fsc[lab] = (fsc[lab] || 0) + 1; }
  const fscSorted = Object.fromEntries(Object.entries(fsc).sort((a, b) => b[1] - a[1]));
  // per-site activation rate + mean step
  const rate = {}, meanStep = {};
  for (let si = 0; si < wm.n_sites; si++) {
    let cnt = 0, ssum = 0, sc = 0;
    for (const as of actSteps) if (isFinite(as[si])) { cnt++; ssum += as[si]; sc++; }
    rate[wm.labels[si]] = cnt / n;
    meanStep[wm.labels[si]] = sc ? ssum / sc : null;
  }
  // top orders
  const oc = {};
  for (const o of orders) if (o.length) { const key = o.slice(0, 3).map(s => wm.labels[s]).join(" → "); oc[key] = (oc[key] || 0) + 1; }
  const topOrders = Object.entries(oc).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const { intensity, cmax } = vertexIntensity(cumAccum, !!cfg.project_outer, nomRes.sigma_f_end_mpa);
  const rep = grow(gp, 7), roots_payload = rootTubeMesh(rep);
  const pct = (a, p) => { const s = a.filter(isFinite).sort((x, y) => x - y); return s.length ? +s[clip(Math.round((p / 100) * (s.length - 1)), 0, s.length - 1)].toFixed(2) : null; };
  const stats = {
    pattern: pat.name, n_runs: n, reliability,
    mean_breakthrough: isFinite(meanBrk) ? meanBrk : null,
    std_breakthrough: isFinite(meanBrk) ? std(finite(brk)) : null,
    mean_first_crack: isFinite(meanFirst) ? meanFirst : null,
    n_time_steps: T,
    first_site_counts: fscSorted, site_activation_rate: rate,
    mean_site_activation_step: meanStep, top_orders: topOrders,
    breakthrough_samples: brk.map(v => isFinite(v) ? v : null),
    first_crack_samples: first.map(v => isFinite(v) ? v : null),
    physical: physSummary(ph0),
    // what was actually varied, and the spread it produced
    uncertainty: {
      strength_range_mpa: range, strength_p10: pct(sampledStrength, 10), strength_p90: pct(sampledStrength, 90),
      pressure_varied: !ph0.calibration_active,
      pressure_p10: pct(sampledPressure, 10), pressure_p90: pct(sampledPressure, 90),
      thickness_tolerance_pct: 5, n_architectures: nArch,
      seam_stress_p10: pct(seamStress, 10), seam_stress_median: pct(seamStress, 50), seam_stress_p90: pct(seamStress, 90),
      safety_median: pct(safety, 50), safety_p10: pct(safety, 10),
    },
    mechanics: mechanicsSummary(nomRes, wm, ph0, pat, sp),
    breakthrough_time: spTimeContext(ph0.species, isFinite(meanBrk) ? meanBrk : null, T, ph0.salinity_ppt),
    window_time: spTimeContext(ph0.species, T, T, ph0.salinity_ppt),
    material_card: materialCard(ph0.material),
  };
  return { intensity, cmax, roots: roots_payload, stats };
}
// Drain the generator in one go — for callers that don't need progress.
function montecarlo(cfg, nRuns) {
  const it = montecarloIter(cfg, nRuns);
  let r = it.next(); while (!r.done) r = it.next();
  return r.value;
}

// ---------------------------------------------------------------------------
//  simulateFrames — the SAME simulation, but capturing a per-step vertex-stress
//  snapshot so the UI can play the growth through time. Physics unchanged.
// ---------------------------------------------------------------------------
function simulateFrames(cfg) {
  const pat = patternFromCfg(cfg), gp = growthFromCfg(cfg), sp = simFromCfg(cfg), ph = physFromCfg(cfg);
  const wall = buildFields(pat), wm = buildWallModel(wall);
  const roots = grow(gp, +(cfg.seed || 1));
  const capFrames = [];
  const res = runSimulation(wm, roots, sp, ph, capFrames);
  const T = sp.n_time_steps, projectOuter = cfg.project_outer !== false;
  const ff = new Float64Array(POD.nF);
  const toVert = (cum) => {
    ff.fill(0);
    for (let l = 0; l < wm.nIn; l++) ff[wm.innerIdx[l]] = cum[l];
    const field = projectOuter ? projectInnerToOuter(ff) : ff;
    return smoothVertexField(faceFieldToVertex(field), 2, 0.55);
  };
  const nF2 = capFrames.length;
  // colour scale anchored to the material's remaining strength: the top of the
  // ramp is fracture, so the pod visibly recolours when you change material
  const cmax = Math.max(res.sigma_f_end_mpa, 1e-9);
  const frames = new Array(nF2);
  for (let t = 0; t < nF2; t++) {
    const vv = toVert(capFrames[t]);
    const arr = new Float32Array(vv.length); for (let i = 0; i < vv.length; i++) arr[i] = vv[i];
    frames[t] = arr;
  }
  const sites = wm.labels.map((lab, i) => ({ label: lab, is_ligament: !!wm.is_lig[i], activation_step: isFinite(res.activation[i]) ? res.activation[i] : null }));
  const stats = {
    n_nodes: roots.n,
    mechanics: mechanicsSummary(res, wm, ph, pat, sp),
    first_crack_step: isFinite(res.firstStep) ? res.firstStep : null,
    first_crack_site: res.firstSite >= 0 ? wm.labels[res.firstSite] : null,
    breakthrough_step: isFinite(res.breakthrough) ? res.breakthrough : null,
    n_time_steps: T, activation_order: res.order.map(s => wm.labels[s]),
    sites, pattern: pat.name,
    slots: pat.slots.map(s => ({ theta: s.theta_deg, z_lo: s.z_lo, z_hi: s.z_hi, width: s.width_deg })),
    physical: physSummary(ph),
    breakthrough_time: spTimeContext(ph.species, isFinite(res.breakthrough) ? res.breakthrough : null, T, ph.salinity_ppt),
    first_crack_time: spTimeContext(ph.species, isFinite(res.firstStep) ? res.firstStep : null, T, ph.salinity_ppt),
    window_time: spTimeContext(ph.species, T, T, ph.salinity_ppt),
    material_card: materialCard(ph.material),
  };
  // per-step real-time labels + root growth fraction (roots mature ~breakthrough)
  const brkStep = isFinite(res.breakthrough) ? res.breakthrough : T;
  const timeline = [];
  for (let t = 1; t <= T; t++) {
    const tc = spTimeContext(ph.species, t, T, ph.salinity_ppt);
    timeline.push({ step: t, months: tc.months, label: tc.label, root_p: clip(t / Math.max(brkStep, 1), 0, 1) });
  }
  return {
    frames, cmax, n_time_steps: T,
    breakthrough_step: isFinite(res.breakthrough) ? res.breakthrough : null,
    // Array.from, NOT .map: res.activation is a Float64Array, and a typed
    // array's map coerces the returned null back to 0 — which made every site
    // that never cracked look like it cracked at step 0.
    activation: Array.from(res.activation, a => isFinite(a) ? a : null),
    site_labels: wm.labels, is_lig: Array.from(wm.is_lig),
    timeline, stats, window_months: ph.species.window_months, species_name: ph.species.name,
  };
}

// ---------------------------------------------------------------------------
//  growing seedling shoot — built as ONE CONTINUOUS ORGANIC MESH (not stem-object
//  + leaf-object placed near each other). A single tube spine originates inside
//  the pod bore, rises through the opening with a gentle organic lean and taper,
//  closes at an apex vertex, and the paired cotyledon leaves are WELDED to that
//  apex vertex — so there is no seam or gap to float, at any growth stage or
//  camera angle. Each leaf is a lanceolate, midribbed, double-sided blade with an
//  upward arch, edge curl, a slight twist and per-leaf asymmetry (not flat mirror
//  planes). Olive stem, dark-green blades, lighter midrib.
// ---------------------------------------------------------------------------
const _SHOOT_STEM = [0.42, 0.55, 0.28], _SHOOT_LEAF = [0.15, 0.39, 0.18], _SHOOT_MIDRIB = [0.44, 0.61, 0.31];
function _cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function _nrm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function shootMesh(gfrac) {
  gfrac = clip(gfrac, 0, 1);
  if (gfrac <= 0.01) return null;
  const f = POD.features, H = f.height, top = f.top_center;
  const zT = top[2], cx0 = top[0], cy0 = top[1], stemH = 0.34 * H * gfrac;
  if (stemH < 1) return null;
  const X = [], Y = [], Z = [], I = [], J = [], K = [], C = [];
  const stemCol = _rgb(_SHOOT_STEM), leafCol = _rgb(_SHOOT_LEAF), midCol = _rgb(_SHOOT_MIDRIB);
  const crownColArr = [0.34, 0.26, 0.18], crownCol = _rgb(crownColArr);   // woody root-crown → blends into the roots

  // ----- hypocotyl + stem as ONE continuous tapered tube -----
  //  Starts DOWN at the root-cluster origin (z ≈ 0.14·H), runs up through the bore
  //  as a plump seedling body, exits the rim, then narrows to the growing tip. A
  //  crown cap closes the bottom (where the roots emerge) and the leaves weld onto
  //  the apex. Because the tube reaches all the way down to the roots, the seedling
  //  reads as one axis and cannot float in the exploded view — the earlier "stem
  //  starts at the rim" gap (z277→z47, ~69% of the height) is gone. The radius and
  //  colour transition brown/thick at the crown → green/slim at the tip so there is
  //  no thickness discontinuity where the stem meets the root crown either.
  const rCrown = 0.50 * f.inner_r_waist;     // thick woody base (fits the bore: rInner ≥ ~13)
  const rShoulder = 0.34 * f.inner_r_waist;  // body radius where it exits the rim
  const rTip = 0.07 * f.inner_r_waist;       // slim growing tip
  const zRoot = groundZ() - 0.03 * H;         // hypocotyl base — planted DOWN into the mud (was 0.14·H, floating)
  const apexZ = zT + stemH, span = apexZ - zRoot;
  const leanAz = 0.7, leanMag = 0.05 * H * gfrac;   // gentle S-lean, only above the rim
  const centerAt = (zc) => {
    if (zc <= zT) {                          // below the rim: drift from the bore axis up to the rim centre
      const u = _smoother(clip((zc - zRoot) / Math.max(zT - zRoot, 1), 0, 1));
      return [_lerp(0, cx0, u), _lerp(0, cy0, u)];
    }
    const a = clip((zc - zT) / Math.max(stemH, 1), 0, 1), lat = leanMag * (a * a * (3 - 2 * a));
    return [cx0 + Math.cos(leanAz) * lat, cy0 + Math.sin(leanAz) * lat];
  };
  const spineAt = (t) => { const zc = zRoot + span * t, c = centerAt(zc); return [c[0], c[1], zc]; };
  const stemR = (zc) => {
    if (zc <= zT) { const u = clip((zc - zRoot) / Math.max(zT - zRoot, 1), 0, 1); return _lerp(rCrown, rShoulder, _smoother(u)); }
    const a = clip((zc - zT) / Math.max(stemH, 1), 0, 1); return _lerp(rShoulder, rTip, a);
  };
  const stemColAt = (zc) => {
    if (zc >= zT) return stemCol;
    const u = _smoother(clip((zc - zRoot) / Math.max(zT - zRoot, 1), 0, 1));
    return _rgb(_lerp3(crownColArr, _SHOOT_STEM, u));
  };
  const sides = 8, nSeg = 30;
  const ringStart = [];
  for (let s = 0; s <= nSeg; s++) {
    const t = s / nSeg, p = spineAt(t);
    const pn = spineAt(Math.min(t + 1e-3, 1)), pp = spineAt(Math.max(t - 1e-3, 0));
    const fr = frame(pn[0] - pp[0], pn[1] - pp[1], pn[2] - pp[2]), r = stemR(p[2]), col = stemColAt(p[2]);
    ringStart.push(X.length);
    for (let k = 0; k < sides; k++) {
      const g = 2 * Math.PI * k / sides, cc = Math.cos(g), ss = Math.sin(g);
      X.push(p[0] + r * (cc * fr[0] + ss * fr[3])); Y.push(p[1] + r * (cc * fr[1] + ss * fr[4])); Z.push(p[2] + r * (cc * fr[2] + ss * fr[5])); C.push(col);
    }
  }
  for (let s = 0; s < nSeg; s++) {
    const a = ringStart[s], b = ringStart[s + 1];
    for (let k = 0; k < sides; k++) { const k2 = (k + 1) % sides; I.push(a + k, a + k); J.push(a + k2, b + k2); K.push(b + k2, b + k); }
  }
  // crown cap at the bottom so the rod reads solid where the roots sprout
  const crown = spineAt(0), crownIdx = X.length;
  X.push(crown[0]); Y.push(crown[1]); Z.push(crown[2] - 0.4 * rCrown); C.push(crownCol);
  { const a = ringStart[0]; for (let k = 0; k < sides; k++) { const k2 = (k + 1) % sides; I.push(a + k2); J.push(a + k); K.push(crownIdx); } }
  const apex = spineAt(1), apexIdx = X.length;
  X.push(apex[0]); Y.push(apex[1]); Z.push(apex[2]); C.push(stemCol);
  { const a = ringStart[nSeg]; for (let k = 0; k < sides; k++) { const k2 = (k + 1) % sides; I.push(a + k); J.push(a + k2); K.push(apexIdx); } }

  // ----- leaf pair: each cotyledon welded to the apex vertex (=> one continuous,
  //       gap-free mesh). Lanceolate blade, raised midrib, upward arch, edge curl,
  //       slight twist; the two leaves differ in length / curl / bend / tilt so
  //       they read as a natural pair, not flat mirror planes -----
  const leafG = clip((gfrac - 0.34) / 0.66, 0, 1);
  if (leafG > 0.04) {
    const baseAz = leanAz + Math.PI / 2;
    const specs = [
      { az: baseAz,                  lenK: 1.00, curlK: 0.9, bend: +1, tilt: 0.60, twist: +0.12 },
      { az: baseAz + Math.PI * 0.96, lenK: 0.86, curlK: 1.3, bend: -1, tilt: 0.70, twist: -0.18 },
    ];
    for (const sp of specs) {
      const L = 0.15 * H * leafG * sp.lenK, thk = Math.max(0.3, 0.012 * L);
      const Fd = _nrm([Math.cos(sp.az) * 0.82, Math.sin(sp.az) * 0.82, sp.tilt]);
      let S = _nrm(_cross(Fd, [0, 0, 1])); if (!isFinite(S[0]) || (S[0] === 0 && S[1] === 0 && S[2] === 0)) S = [1, 0, 0];
      const Nn = _nrm(_cross(S, Fd));
      const nL = 9, nW = 2, cols = 2 * nW + 1, topR = [], botR = [];
      for (let i = 0; i <= nL; i++) {
        const t = i / nL;
        const w = 0.13 * L * Math.pow(t, 0.5) * Math.pow(1 - t, 0.72) * 2.35;   // lanceolate, pointed tip
        const arch = 0.14 * L * Math.sin(Math.PI * t);                          // upward arch
        const bend = sp.bend * 0.12 * L * Math.sin(Math.PI * t) * t;            // sideways bend (asymmetry)
        const cx = apex[0] + Fd[0] * L * t + Nn[0] * arch + S[0] * bend;
        const cy = apex[1] + Fd[1] * L * t + Nn[1] * arch + S[1] * bend;
        const cz = apex[2] + Fd[2] * L * t + Nn[2] * arch + S[2] * bend;
        topR.push([]); botR.push([]);
        for (let j = -nW; j <= nW; j++) {
          if (i === 0) { topR[i].push(apexIdx); botR[i].push(apexIdx); continue; }   // base welded to apex
          const sf = j / nW, off = w * sf, twist = sp.twist * t;
          const lift = sp.curlK * w * (0.28 + 0.55 * t) * sf * sf + 0.55 * w * (1 - Math.abs(sf));   // edge curl + raised midrib
          const mx = cx + S[0] * off + Nn[0] * lift + Fd[0] * twist * off;
          const my = cy + S[1] * off + Nn[1] * lift + Fd[1] * twist * off;
          const mz = cz + S[2] * off + Nn[2] * lift + Fd[2] * twist * off;
          const col = j === 0 ? midCol : leafCol;
          topR[i].push(X.length); X.push(mx + Nn[0] * thk); Y.push(my + Nn[1] * thk); Z.push(mz + Nn[2] * thk); C.push(col);
          botR[i].push(X.length); X.push(mx - Nn[0] * thk); Y.push(my - Nn[1] * thk); Z.push(mz - Nn[2] * thk); C.push(col);
        }
      }
      for (let i = 0; i < nL; i++) for (let j = 0; j < cols - 1; j++) {
        const ta = topR[i][j], tb = topR[i][j + 1], tc = topR[i + 1][j + 1], td = topR[i + 1][j];
        const bc = botR[i + 1][j + 1], bd = botR[i + 1][j];
        if (i === 0) { I.push(apexIdx, apexIdx); J.push(tc, bd); K.push(td, bc); }    // apex fan (top + bottom)
        else {
          const ba = botR[i][j], bb = botR[i][j + 1];
          I.push(ta, ta); J.push(tb, tc); K.push(tc, td);          // top
          I.push(ba, ba); J.push(bc, bb); K.push(bd, bc);          // bottom (reversed)
        }
      }
      const seam = (jj) => { for (let i = 0; i < nL; i++) { const t0 = topR[i][jj], t1 = topR[i + 1][jj], b0 = botR[i][jj], b1 = botR[i + 1][jj];
        if (t0 === b0) { I.push(t0); J.push(b1); K.push(t1); }      // base row is the apex point
        else { I.push(t0, t0); J.push(b0, b1); K.push(b1, t1); } } };
      seam(0); seam(cols - 1);                                       // close the two long edges → thin blade
    }
  }
  const rnd = v => Math.round(v * 100) / 100;
  return { x: X.map(rnd), y: Y.map(rnd), z: Z.map(rnd), i: I, j: J, k: K, vertexcolor: C };
}

// ---------------------------------------------------------------------------
//  material-specific crack analysis (plain-English report from Monte Carlo)
// ---------------------------------------------------------------------------
function _siteAngle(label) { const m = /(-?\d+)/.exec(label || ""); return m ? parseInt(m[1], 10) : null; }
function _seamPosWords(deg) {
  if (deg === null) return "";
  const d = ((deg + 180) % 360 + 360) % 360 - 180;
  const dir = Math.abs(d) < 25 ? "front (+X)" : Math.abs(d - 90) < 25 ? "left (+Y)" :
    Math.abs(d + 90) < 25 ? "right (−Y)" : Math.abs(Math.abs(d) - 180) < 25 ? "back (−X)" : "";
  return dir ? `${d}° (${dir})` : `${d}°`;
}
function* crackReportIter(cfg, nRuns) {
  const n = clip(Math.round(nRuns || 20), 4, 60);
  const cur = MATERIALS[cfg.material] ? cfg.material : "clay";
  const gp = growthFromCfg(cfg), sp = simFromCfg(cfg), pat = patternFromCfg(cfg);
  const wall = buildFields(pat), wm = buildWallModel(wall), T = sp.n_time_steps;
  // Grow the root systems ONCE (growth is material-independent) and reuse them
  // across all four materials. Growth dominates the cost, so cap the pool and
  // cycle it — the same crossed design the Monte Carlo sweep uses.
  const jitterRng = mulberry32(12345), jNorm = makeNormal(jitterRng), rootSys = [];
  const nArch = Math.min(n, 12);
  for (let kk = 0; kk < nArch; kk++) {
    const g = Object.assign({}, gp);
    g.slot_bias = Math.max(0.2, gp.slot_bias * (1 + 0.5 * jNorm() * 0.3));
    g.down_bias = clip(gp.down_bias * (1 + 0.5 * jNorm() * 0.3), 0.1, 1);
    rootSys.push(grow(g, kk));
    yield { done: kk + 1, total: nArch + 4, phase: "growing roots" };
  }
  // the nominal architecture, for the headline mechanics numbers — reporting
  // whichever random draw happened to be last would swing them wildly
  const nomRoots = grow(gp, +(cfg.seed || 1));
  const mats = ["pha", "pla", "clay", "concrete"], byMat = {};
  const finite = a => a.filter(v => isFinite(v)), mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : Infinity;
  for (const mk of mats) {
    const ph = physFromCfg(Object.assign({}, cfg, { material: mk }));
    const first = [], brk = [], firstSite = [];
    for (let kk = 0; kk < n; kk++) {
      const res = runSimulation(wm, rootSys[kk % nArch], sp, ph);
      first.push(isFinite(res.firstStep) ? res.firstStep : Infinity);
      brk.push(isFinite(res.breakthrough) ? res.breakthrough : Infinity);
      firstSite.push(res.firstSite);
    }
    const fsc = {}; for (const si of firstSite) if (si >= 0) { const lab = wm.labels[si]; fsc[lab] = (fsc[lab] || 0) + 1; }
    const fscSorted = Object.fromEntries(Object.entries(fsc).sort((a, b) => b[1] - a[1]));
    const mFirst = mean(finite(first)), mBrk = mean(finite(brk));
    const mech = mechanicsSummary(runSimulation(wm, nomRoots, sp, ph), wm, ph, pat, sp);
    byMat[mk] = {
      first_site_counts: fscSorted, reliability: finite(brk).length / n,
      mean_first_crack: isFinite(mFirst) ? mFirst : null, mean_breakthrough: isFinite(mBrk) ? mBrk : null,
      first_crack_months: spTimeContext(ph.species, isFinite(mFirst) ? mFirst : null, T, ph.salinity_ppt).months,
      breakthrough_months: spTimeContext(ph.species, isFinite(mBrk) ? mBrk : null, T, ph.salinity_ppt).months,
      strength: MATERIALS[mk].fracture_strength_mpa, mech,
    };
    yield { done: nArch + mats.indexOf(mk) + 1, total: nArch + 4, phase: MATERIALS[mk].name };
  }
  const s = byMat[cur], ph = physFromCfg(Object.assign({}, cfg, { material: cur }));
  const entries = Object.entries(s.first_site_counts);
  const topSite = entries.length ? entries[0][0] : null, topCount = entries.length ? entries[0][1] : 0;
  const consistency = Math.round(100 * topCount / n);
  const angle = _siteAngle(topSite), posWords = _seamPosWords(angle);
  const isLig = (topSite || "").startsWith("slot");
  const fcMonths = s.first_crack_months, brkMonths = s.breakthrough_months;
  const win = ph.species.window_months, outplant = ph.species.outplant_months;
  const rel = Math.round(100 * s.reliability);
  const strengthCur = MATERIALS[cur].fracture_strength_mpa, strengthRef = MATERIALS.pha.fracture_strength_mpa;
  const nm = v => v == null ? "—" : `month ${v.toFixed(1)}`;
  const matName = MATERIALS[cur].name;
  // ---- narrative ----
  const where = topSite
    ? `In ${matName} pods, cracking initiates at the ${isLig ? "upper-waist slot → foot ligament" : "base split-line"} seam at ${posWords}${consistency >= 60 ? ", consistently" : ", though the location varies"} — this seam is the first to fail in ${consistency}% of ${n} randomized runs.`
    : `No consistent first-crack site emerged in ${n} runs (the wall rarely reaches threshold for ${matName}).`;
  const M = s.mech;
  const why = `The roots bear hardest against the narrow inner bore in the upper waist, and that band overlaps the seam. On the ${M.seam_thickness_mm} mm of wall left there after scoring, the bearing pressure works out at a peak of <b>${M.peak_stress_mpa} MPa</b> — hoop tension plus transverse bending, concentrated at the slot tip. ${matName} starts at ${strengthCur} MPa and is down to ${M.strength_end_mpa} MPa by the end of the window after wet degradation, so the seam is running at <b>${Math.round(M.utilisation * 100)}%</b> of its remaining strength. Bending scales as 1/t², which is why the scoring depth — not the material — dominates whether it releases at all.`;
  const when = `Timing (${matName}): first crack at ~${nm(fcMonths)}, full 4-piece breakthrough at ~${nm(brkMonths)} of a ~${win}-month growth window (${rel}% of runs break within the window). By comparison — first crack: PHA ~${nm(byMat.pha.first_crack_months)}, PLA ~${nm(byMat.pla.first_crack_months)}, clay ~${nm(byMat.clay.first_crack_months)}, concrete ~${nm(byMat.concrete.first_crack_months)}.`;
  const consistencyText = consistency >= 80
    ? `This is a reliable, repeatable failure point: ${consistency}% of runs crack at the same seam.`
    : consistency >= 50
      ? `Moderately consistent: ${consistency}% of runs crack at this seam, the rest elsewhere.`
      : `Inconsistent: only ${consistency}% of runs crack at this seam — the first-crack location is not reliable for this design/material.`;
  const early = (brkMonths != null && outplant != null && brkMonths < 0.6 * outplant);
  const consAdverb = consistency >= 80 ? "consistently " : consistency >= 55 ? "most often " : "";
  const base = `In ${matName} pods, cracking ${consAdverb}initiates at the ${isLig ? "upper-waist slot ligaments" : "base split-lines"} at approximately ${nm(fcMonths)} of a ${win}-month cycle, with full 4-piece release by ~${nm(brkMonths)} (${consistency}% of ${n} runs crack first at the seam near ${posWords}).`;
  const varyClause = consistency < 55 ? ` The first-crack seam varies between the 4 near-symmetric slot ligaments, so there is no single dominant release point.` : "";
  const timingClause = early
    ? ` That is well before the seedling's roots are self-supporting (~month ${outplant}) — the current seam design releases the pod too early for ${matName}, and may need reinforced or deeper seam scoring for this material.`
    : ` This lands within the ~${outplant}-month establishment window, so the seam timing is broadly appropriate for ${matName}.${consistency < 55 ? ` Tuning the 4 seams so one releases first would give a more predictable, controlled split.` : ""}`;
  // If nothing releases, the useful answer is what to change — not a shrug.
  const noRelease = M.required_score != null
    ? `${matName} does not release under the current design: the seam runs at ${Math.round(M.utilisation * 100)}% of its remaining strength, short of fracture. Scoring the four seams to <b>${Math.round(M.required_score * 100)}%</b> depth — leaving about <b>${M.required_seam_thickness_mm} mm</b> of wall instead of ${M.seam_thickness_mm} mm — would bring ${M.seams_needed} of them to tearing inside the window.`
    : `${matName} does not release under the current design, and scoring alone will not get it there — even a 95%-deep seam leaves it short. This wall is too thick, or this material too strong, for root pressure to open. Thin the wall, widen the bore, or move to a weaker/faster-degrading material.`;
  const summary = topSite ? base + varyClause + timingClause : noRelease;
  return {
    material: cur, material_name: matName, n_runs: n,
    first_site: topSite, first_site_pos: posWords, consistency,
    first_crack_months: fcMonths, breakthrough_months: brkMonths,
    window_months: win, outplant_months: outplant, reliability: rel,
    mechanics: M,
    compare: mats.map(mk => ({ key: mk, name: MATERIALS[mk].name, strength: byMat[mk].strength,
      first_crack_months: byMat[mk].first_crack_months, breakthrough_months: byMat[mk].breakthrough_months,
      reliability: Math.round(100 * byMat[mk].reliability),
      peak_stress_mpa: byMat[mk].mech.peak_stress_mpa,
      utilisation: byMat[mk].mech.utilisation,
      required_score: byMat[mk].mech.required_score })),
    text: { where, why, when, consistency: consistencyText, summary },
    first_site_counts: s.first_site_counts,
  };
}
function crackReport(cfg, nRuns) {
  const it = crackReportIter(cfg, nRuns);
  let r = it.next(); while (!r.done) r = it.next();
  return r.value;
}

function features() {
  const f = POD.features;
  return {
    height: f.height, outer_r_waist: f.outer_r_waist, inner_r_waist: f.inner_r_waist,
    wall_thickness: f.wall_thickness_median, n_slots: f.slots.length, n_feet: f.feet.length,
    n_faces: POD.nF, n_verts: POD.nV,
    foot_r: rOuterAt(0.05 * f.height), ground_z: groundZ(), top_z: f.top_center[2],
  };
}

// ---------------------------------------------------------------------------
//  authored 4-piece asset (explode_4pieces_3d.3dm → data/pieces.js). Drives the
//  Exploded view instead of the procedural angular split. Already aligned to the
//  pod frame (feet z=0). Each piece carries an outward explode dir (dx,dy).
//  VISUAL-ONLY — different topology from the sim mesh, so no live stress mapping.
// ---------------------------------------------------------------------------
let POD_PIECES = null;
// Weld coincident vertices (the authored asset concatenates a render mesh per
// Brep face, leaving ~27% exactly-duplicated vertices along the face seams).
// Merging them lets Plotly's flatshading:false average normals ACROSS those
// seams, so curved surfaces shade smoothly instead of faceted. Positions are
// already quantised to 0.1 in the export, so an exact key merge is safe.
function weldMesh(x, y, z, ii, jj, kk) {
  const map = new Map(), nx = [], ny = [], nz = [], remap = new Int32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const key = x[i] + "," + y[i] + "," + z[i];
    let idx = map.get(key);
    if (idx === undefined) { idx = nx.length; map.set(key, idx); nx.push(x[i]); ny.push(y[i]); nz.push(z[i]); }
    remap[i] = idx;
  }
  return { x: nx, y: ny, z: nz, i: ii.map(v => remap[v]), j: jj.map(v => remap[v]), k: kk.map(v => remap[v]) };
}
function buildPieces(raw) {
  if (!raw || !raw.pieces) return null;
  POD_PIECES = raw.pieces.map(p => {
    const V = p.V, F = p.F, nV = V.length / 3, nF = F.length / 3;
    const x = new Array(nV), y = new Array(nV), z = new Array(nV);
    for (let i = 0; i < nV; i++) { x[i] = V[3 * i]; y[i] = V[3 * i + 1]; z[i] = V[3 * i + 2]; }
    const ii = new Array(nF), jj = new Array(nF), kk = new Array(nF);
    for (let f = 0; f < nF; f++) { ii[f] = F[3 * f]; jj[f] = F[3 * f + 1]; kk[f] = F[3 * f + 2]; }
    const w = weldMesh(x, y, z, ii, jj, kk);
    return { x: w.x, y: w.y, z: w.z, i: w.i, j: w.j, k: w.k, dx: p.dx, dy: p.dy };
  });
  return POD_PIECES;
}
// returns the 4 authored pieces (base geometry + outward dir); the app offsets
// each piece by gap*dir for the explode. null if the asset didn't load.
function assetPieces() { return POD_PIECES; }

// High-resolution VISUAL pod mesh (data/podviz.js) used to RENDER the intact pod
// so its curved surfaces read smooth. It is a denser, welded mesh authored in the
// modeller; the SIMULATION still runs on the sim mesh in POD (pod.js), untouched.
// `map[v]` = the nearest sim-mesh vertex for visual vertex v, so the app can show
// the per-sim-vertex stress field on this mesh (nearest-vertex, like the pieces).
let POD_VIZ = null;
function buildPodViz(raw) {
  if (!raw || !raw.V || !raw.F) return null;
  const nV = raw.n_verts, nF = raw.n_faces, V = raw.V, F = raw.F;
  const x = new Array(nV), y = new Array(nV), z = new Array(nV);
  for (let v = 0; v < nV; v++) { x[v] = V[3 * v]; y[v] = V[3 * v + 1]; z[v] = V[3 * v + 2]; }
  const i = new Array(nF), j = new Array(nF), k = new Array(nF);
  for (let f = 0; f < nF; f++) { i[f] = F[3 * f]; j[f] = F[3 * f + 1]; k[f] = F[3 * f + 2]; }
  POD_VIZ = { type: "mesh3d", x, y, z, i, j, k, map: raw.map, name: "pod wall", hoverinfo: "skip" };
  return POD_VIZ;
}
// the high-res visual pod geometry + nearest-sim-vertex map, or null if not loaded.
function vizPod() { return POD_VIZ; }

async function loadPod() {
  // geometry is provided by data/pod.js as window.POD_RAW (loaded via <script>,
  // which avoids the large-body fetch() reset in the in-app preview proxy).
  if (!window.POD_RAW) throw new Error("pod geometry (data/pod.js) not loaded");
  buildPod(window.POD_RAW);
  if (window.PIECES_RAW) buildPieces(window.PIECES_RAW);   // optional 4-piece asset
  if (window.PODVIZ_RAW) buildPodViz(window.PODVIZ_RAW);   // optional high-res visual pod
  return features();
}

window.ENGINE = {
  loadPod, features, simulate, montecarlo,
  materials: () => ({ materials: Object.fromEntries(Object.entries(MATERIALS).map(([k, m]) => [k, materialCard(m)])), default: "pha" }),
  species: () => ({ species: SPECIES, default: "rhizophora" }),
  provenance: buildRegistry,
  baseMesh, vizPod, seams: seamTubeMesh, exploded: explodedSectors, assetPieces, propagule: propaguleMesh,
  stageRoots: stageRootMesh, ground: groundMesh, water: waterMesh, debris: debrisMesh, rootLandings, rootParams, contactShadow,
  simulateFrames, shoot: shootMesh, crackReport,
  // generator forms — let the UI yield to the browser between runs
  montecarloIter, crackReportIter,
  unitMm: () => MM_PER_UNIT,
};
