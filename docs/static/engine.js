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
  step_size: 7, influence_radius: 45, kill_radius: 10, n_attractors: 2600,
  max_steps: 200, n_seeds: 3, jitter: 0.35, down_bias: 0.55, slot_bias: 2.2,
  wall_bias: 0.75, seed_depth_frac: 0.92, tip_radius: 1.4, pipe_exponent: 2.3,
  radius_gain: 1.7,
};
const S_DEFAULT = {
  n_time_steps: 120, growth_fraction: 0.6, maturation: 30, swell_rate: 0.012,
  max_swell: 2.6, contact_stiffness: 20, base_wedge: 0.6, contact_patch_factor: 1.6,
  min_patch_radius: 7, dt: 1, span_frac: 0.6, hoop_factor: 0.9,
  breakthrough_frac: 0.75, pull_assist: 0,
};
const MAT_PARAMS = {
  yield_stress: 1, slot_tip_scf: 3, split_scf: 1.8, tip_zone: 22,
  ligament_halfwidth_deg: 26,
};

// ---------------------------------------------------------------------------
//  materials / species / provenance  (data + coupling)
// ---------------------------------------------------------------------------
const REF_FRACTURE_MPA = 55, REF_ROOT_PRESSURE_MPA = 0.75, STRENGTH_SENSITIVITY = 0.9;

const MATERIALS = {
  bioplastic: {
    key: "bioplastic", name: "Bioplastic (marine-degradable PHA/PLA)",
    fracture_strength_mpa: 55, fracture_range_mpa: [40, 75], stiffness_mpa: 2800,
    wet_strength_loss_per_month: 0.05, biodegradable: true,
    biodegradability: "Marine-biodegradable (formulation-dependent)",
    biodegradability_note: "Designed to hold shape initially, then weaken and biodegrade over the establishment window. Real degradation rate is highly formulation/site-dependent (PHA degrades faster than PLA in seawater). Estimate — verify with immersion testing.",
    warn: false, warn_text: "",
    blurb: "Strong at first, then degrades to release the seedling cleanly. The design-intent baseline.",
  },
  clay: {
    key: "clay", name: "Clay (low-fired earthenware)",
    fracture_strength_mpa: 15, fracture_range_mpa: [8, 25], stiffness_mpa: 8000,
    wet_strength_loss_per_month: 0.03, biodegradable: true,
    biodegradability: "Inert mineral — environmentally benign",
    biodegradability_note: "Fired clay is not 'biodegradable' in the polymer sense, but it is an inert, non-toxic mineral that breaks down to sediment. Unfired/low-fired clay slakes faster in water (higher degradation). Estimate.",
    warn: false, warn_text: "",
    blurb: "Brittle ceramic; cracks readily at a scored seam. Benign if it stays behind.",
  },
  concrete: {
    key: "concrete", name: "Concrete (unreinforced, thin-wall)",
    fracture_strength_mpa: 4, fracture_range_mpa: [3, 6], stiffness_mpa: 25000,
    wet_strength_loss_per_month: 0.004, biodegradable: false,
    biodegradability: "Not biodegradable — persistent",
    biodegradability_note: "LEAST biodegradable option. Persists in the marine environment for decades; alkaline leachate can locally raise pH. Cracks in tension at a scored seam, but the fragments remain. Not recommended for leave-in-place / dissolving pod designs. Estimate.",
    warn: true,
    warn_text: "⚠ Concrete is the LEAST biodegradable material: it persists in the marine environment and can leach alkalinity. It may crack at the seam, but fragments stay behind — avoid for leave-in-place pods.",
    blurb: "Durable and cheap, but persistent. Weak in tension so a thin scored seam still cracks.",
  },
};
function matStrengthScale(m) { return Math.pow(m.fracture_strength_mpa / REF_FRACTURE_MPA, STRENGTH_SENSITIVITY); }
function matDegrade(m, months) { return Math.max(0.05, 1 - m.wet_strength_loss_per_month * Math.max(months, 0)); }
function materialCard(m) {
  return Object.assign({}, m, {
    strength_scale: Math.round(matStrengthScale(m) * 1000) / 1000,
    estimate_disclaimer: "Engineering estimate — requires lab verification.",
  });
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
  const material = MATERIALS[cfg.material] || MATERIALS.bioplastic;
  const species = SPECIES[cfg.species] || SPECIES.rhizophora;
  let sal = (cfg.salinity_ppt === "" || cfg.salinity_ppt == null) ? null : +cfg.salinity_ppt;
  let p = (cfg.root_pressure_mpa === "" || cfg.root_pressure_mpa == null) ? REF_ROOT_PRESSURE_MPA : +cfg.root_pressure_mpa;
  const f = (cfg.calibration_force_n === "" || cfg.calibration_force_n == null) ? null : +cfg.calibration_force_n;
  const a = (cfg.calibration_area_mm2 === "" || cfg.calibration_area_mm2 == null) ? null : +cfg.calibration_area_mm2;
  let active = !!cfg.calibration_active && !!(f && a);
  if (active) p = f / Math.max(a, 1e-6);
  return { material, species, root_pressure_mpa: p, salinity_ppt: sal, calibration_active: active };
}
function physLoadFactor(ph) { return ph.root_pressure_mpa / REF_ROOT_PRESSURE_MPA; }
function physPerStep(ph, T) {
  const drive = new Float64Array(T), cap = new Float64Array(T), months = new Float64Array(T);
  const lf = physLoadFactor(ph), ss = matStrengthScale(ph.material);
  for (let t = 1; t <= T; t++) {
    const fr = t / T;
    drive[t - 1] = lf * spForceRamp(ph.species, fr);
    months[t - 1] = spElapsedMonths(ph.species, fr, ph.salinity_ppt);
    cap[t - 1] = ss * matDegrade(ph.material, months[t - 1]);
  }
  return { drive, cap, months };
}
function physSummary(ph) {
  return {
    material: ph.material.key, material_name: ph.material.name,
    species: ph.species.key, species_name: ph.species.name,
    root_pressure_mpa: +ph.root_pressure_mpa.toFixed(3), salinity_ppt: ph.salinity_ppt,
    calibration_active: ph.calibration_active, window_months: ph.species.window_months,
    load_factor: +physLoadFactor(ph).toFixed(3), strength_scale: +matStrengthScale(ph.material).toFixed(3),
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
  cs.push(C("model_type", "Failure model", "Reduced-order engineering surrogate (not FEA)", "", "calibrated", "This project's own transparent model.", "Calibrated for RELATIVE comparison of designs/materials and to locate failure hot-spots - not for absolute load numbers. An FEA cross-check is recommended before trusting absolute margins.", "model"));
  cs.push(C("root_pressure_working_range", "Root-pressure working range (default)", "0.5 - 1.0", "MPa", "estimate", "General plant/tree root biomechanics literature (NOT mangrove-specific).", "Grounded proxy: general max axial root growth pressure ~0.1-1.0 MPa (turgor-limited), with ~0.5-0.6 MPa commonly cited for fully impeded roots; tree-specific values reach ~0.91 MPa radial / ~1.45 MPa axial. Treat as a STARTING POINT pending physical validation.", "root force"));
  cs.push(C("contact_stiffness", "Root contact stiffness", "20 (surrogate units)", "", "calibrated", "Chosen for sensible relative behaviour.", "Pressure per unit radial penetration of the swelling root into the wall. Scaled by (root pressure / reference) so the physical slider drives it; the base number itself is not a measured quantity.", "root force"));
  cs.push(C("slot_tip_scf", "Stress-concentration factor at slot tips", "3.0", "x", "estimate", "Order-of-magnitude fracture-mechanics estimate for a rounded notch.", "Real value depends on tip radius and material; verify with FEA / a notched-sample test.", "failure"));
  cs.push(C("span_frac", "Seam tear criterion (crack span)", "0.6", "fraction", "calibrated", "Chosen so a taller bridge is genuinely harder to sever.", "A slot->foot seam/ligament 'tears' once failed faces span this fraction of its stacked z-bands.", "failure"));
  cs.push(C("breakthrough_frac", "Breakthrough criterion", "0.75", "fraction", "calibrated", "Design choice.", "Pod 'breaks through' once this fraction of the 4 seams have torn - the point it can release into petals.", "failure"));
  cs.push(C("geom_height", "Pod height", f.height.toFixed(1), "model units (~11x a 30 cm propagule)", "geometry", "Measured off mangrovepod.3dm.", "", "geometry"));
  cs.push(C("geom_wall", "Median wall thickness", f.wall_thickness_median.toFixed(1), "model units", "geometry", "Measured off mangrovepod.3dm.", "Local thickness sets each face's baseline capacity.", "geometry"));
  cs.push(C("geom_slots", "Detected waist slots", String(f.slots.length), "count", "geometry", "Auto-detected from the mesh.", "", "geometry"));
  cs.push(C("geom_feet", "Detected base feet", String(f.feet.length), "count", "geometry", "Auto-detected from the mesh.", "", "geometry"));
  cs.push(C("ref_root_pressure", "Reference root pressure (surrogate anchor)", String(REF_ROOT_PRESSURE_MPA), "MPa", "calibrated", "Mid-point of the grounded working range.", "Root pressure enters the surrogate only as pressure/this-reference; at this value the drive equals the original calibration.", "coupling"));
  cs.push(C("ref_fracture", "Reference fracture strength (surrogate anchor)", String(REF_FRACTURE_MPA), "MPa", "calibrated", "Bioplastic flexural-strength estimate (see materials).", `Seam capacity scales as (material strength / this reference) ^ ${STRENGTH_SENSITIVITY}; bioplastic reproduces the original calibration.`, "coupling"));
  cs.push(C("strength_sensitivity", "Strength-to-capacity sensitivity", String(STRENGTH_SENSITIVITY), "exponent", "calibrated", "Modelling choice.", "Compresses the between-material capacity spread in this reduced-order surrogate. A tunable modelling knob, not a physical constant.", "coupling"));
  // material entries
  const m = ph.material, lo = m.fracture_range_mpa[0], hi = m.fracture_range_mpa[1];
  cs.push(C(`mat_${m.key}_strength`, `${m.name}: fracture strength (flexural)`, `${m.fracture_strength_mpa}  (range ${lo}-${hi})`, "MPa", "estimate", "Engineering estimate for a thin scored wall of this class.", "NOT a datasheet value and NOT measured on a pod. Sets seam capacity relative to the reference material. Verify by testing notched samples.", "material"));
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
//  growth (space colonization) — port of growth.py
// ---------------------------------------------------------------------------
function sampleAttractors(gp, rng, nrm) {
  const H = POD.features.height, zc = POD.innerProf.z, ri = POD.innerProf.r;
  const slotTh = POD.features.slots.map(s => s.theta_deg * Math.PI / 180);
  const x = [], y = [], z = []; let tries = 0; const n = gp.n_attractors;
  while (x.length < n && tries < n * 60) {
    tries++;
    const zz = 0.04 * H + rng() * (0.98 * H - 0.04 * H);
    const w = 1 - 0.7 * gp.down_bias * (zz / H);
    if (rng() > w) continue;
    const rIn = Math.max(interp(zc, ri, zz), 2);
    const frac = Math.pow(rng(), 1 - 0.85 * gp.wall_bias);
    const rad = frac * 0.95 * rIn;
    let th;
    if (slotTh.length && rng() < gp.slot_bias / (gp.slot_bias + 1))
      th = slotTh[Math.floor(rng() * slotTh.length)] + nrm() * (20 * Math.PI / 180);
    else th = -Math.PI + rng() * 2 * Math.PI;
    x.push(rad * Math.cos(th)); y.push(rad * Math.sin(th)); z.push(zz);
  }
  return { x, y, z, n: x.length };
}

function grow(gp, seed) {
  const rng = mulberry32(seed), nrm = makeNormal(rng);
  const H = POD.features.height;
  const attr = sampleAttractors(gp, rng, nrm);
  const nx = [], ny = [], nz = [], parent = [], birth = [];
  const add = (x, y, z, par, st) => { nx.push(x); ny.push(y); nz.push(z); parent.push(par); birth.push(st); };
  const zSeed = gp.seed_depth_frac * H, rSeed = Math.max(rInnerAt(zSeed) * 0.4, 3);
  for (let k = 0; k < gp.n_seeds; k++) {
    const th = 2 * Math.PI * k / gp.n_seeds + rng();
    add(rSeed * Math.cos(th) * 0.3, rSeed * Math.sin(th) * 0.3, zSeed, -1, 0);
  }
  const aAlive = new Uint8Array(attr.n).fill(1); let remaining = attr.n;
  // cell = influence_radius so any node within influence of an attractor is found
  // in a single 3x3x3 ring scan (capped) — avoids pathological ring expansion.
  const cell = gp.influence_radius;
  for (let step = 1; step <= gp.max_steps; step++) {
    if (remaining === 0) break;
    const npos = new Float64Array(nx.length * 3);
    for (let i = 0; i < nx.length; i++) { npos[3 * i] = nx[i]; npos[3 * i + 1] = ny[i]; npos[3 * i + 2] = nz[i]; }
    const grid = new Grid(npos, nx.length, cell);
    const near = new Int32Array(attr.n).fill(-1), dist = new Float64Array(attr.n).fill(Infinity);
    for (let a = 0; a < attr.n; a++) {
      if (!aAlive[a]) continue;
      const q = grid.nearest(attr.x[a], attr.y[a], attr.z[a], 1);
      near[a] = q.idx; dist[a] = q.dist;
    }
    let within = [];
    for (let a = 0; a < attr.n; a++) if (aAlive[a] && dist[a] < gp.influence_radius) within.push(a);
    if (!within.length) {
      // nothing within influence: advance the single globally-nearest tip
      // (linear scan; only reached early on when nodes are sparse — cheap)
      let bestA = -1, bestNi = -1, bestD = Infinity;
      for (let a = 0; a < attr.n; a++) {
        if (!aAlive[a]) continue;
        const ax = attr.x[a], ay = attr.y[a], az = attr.z[a];
        for (let i = 0; i < nx.length; i++) {
          const dx = nx[i] - ax, dy = ny[i] - ay, dz = nz[i] - az, d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; bestA = a; bestNi = i; }
        }
      }
      if (bestA < 0) break;
      near[bestA] = bestNi; dist[bestA] = Math.sqrt(bestD); within = [bestA];
    }
    const acc = new Map();
    for (const a of within) {
      const ni = near[a], dx = attr.x[a] - nx[ni], dy = attr.y[a] - ny[ni], dz = attr.z[a] - nz[ni];
      const m = Math.hypot(dx, dy, dz); if (m < 1e-6) continue;
      let o = acc.get(ni); if (!o) { o = { sx: 0, sy: 0, sz: 0, c: 0 }; acc.set(ni, o); }
      o.sx += dx / m; o.sy += dy / m; o.sz += dz / m; o.c++;
    }
    if (!acc.size) break;
    const newNodes = [];
    for (const [ni, o] of acc) {
      let vx = o.sx / o.c, vy = o.sy / o.c, vz = o.sz / o.c;
      vz += gp.down_bias * 0.5 * -1;
      vx += gp.jitter * nrm(); vy += gp.jitter * nrm(); vz += gp.jitter * nrm();
      const nv = Math.hypot(vx, vy, vz); if (nv < 1e-6) continue;
      vx /= nv; vy /= nv; vz /= nv;
      let px = nx[ni] + vx * gp.step_size, py = ny[ni] + vy * gp.step_size, pz = nz[ni] + vz * gp.step_size;
      const rHere = rInnerAt(pz), rr = Math.hypot(px, py);
      if (rr > 0.98 * rHere && rr > 1e-6) { px *= 0.98 * rHere / rr; py *= 0.98 * rHere / rr; }
      pz = clip(pz, 0.02 * H, 0.99 * H);
      newNodes.push([ni, px, py, pz]);
    }
    if (!newNodes.length) break;
    for (const [ni, px, py, pz] of newNodes) add(px, py, pz, ni, step);
    const npos2 = new Float64Array(nx.length * 3);
    for (let i = 0; i < nx.length; i++) { npos2[3 * i] = nx[i]; npos2[3 * i + 1] = ny[i]; npos2[3 * i + 2] = nz[i]; }
    const grid2 = new Grid(npos2, nx.length, cell);
    for (let a = 0; a < attr.n; a++) {
      if (!aAlive[a]) continue;
      const q = grid2.nearest(attr.x[a], attr.y[a], attr.z[a], 1);
      if (q.dist <= gp.kill_radius) { aAlive[a] = 0; remaining--; }
    }
  }
  // pipe-model radii
  const n = nx.length, rad = new Float64Array(n).fill(gp.tip_radius);
  const children = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) if (parent[i] >= 0) children[parent[i]].push(i);
  const order = [...Array(n).keys()].sort((a, b) => birth[b] - birth[a]);
  const p = gp.pipe_exponent;
  for (const i of order) {
    if (children[i].length) {
      let s = 0; for (const c of children[i]) s += Math.pow(rad[c], p);
      rad[i] = Math.max(gp.tip_radius, Math.pow(s, 1 / p));
    }
  }
  for (let i = 0; i < n; i++) rad[i] *= gp.radius_gain;
  return { nx, ny, nz, parent, birth, radius: rad, n };
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
  const ligament = new Int32Array(nF).fill(-1), ligScale = new Float64Array(nF).fill(1);
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
    const lw = 1 - 0.4 * clip(s.width_deg / 90, 0, 0.6);
    for (let i = 0; i < nF; i++) {
      if (inner[i] && angdiff(thd[i], s.theta_deg) < halfw && z[i] < s.z_lo && z[i] > z_base_top) {
        ligament[i] = si; ligScale[i] = lw;
      }
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
  const strength = new Float64Array(nF);
  for (let i = 0; i < nF; i++) {
    let v = thickness[i] * m.yield_stress * (1 - open_frac[i]) * (1 - weaken[i]) * ligScale[i];
    if (!inner[i]) v = Infinity;
    if (open_frac[i] > 0.5) v = 1e-6;
    strength[i] = v;
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
  return { open_frac, strength, scf, ligament, split_site, n_slots: pat.slots.length, n_splits: pat.split_lines.length, labels, pattern: pat };
}

// ---------------------------------------------------------------------------
//  wall model + pressure simulation — port of pressure.py
// ---------------------------------------------------------------------------
function buildWallModel(wall) {
  const innerIdx = POD.innerIdx, nIn = innerIdx.length;
  const Cin = new Float64Array(nIn * 3);
  const strength_in = new Float64Array(nIn), scf_in = new Float64Array(nIn), z_in = new Float64Array(nIn), r_in = new Float64Array(nIn);
  const lig = new Int32Array(nIn), split = new Int32Array(nIn);
  for (let l = 0; l < nIn; l++) {
    const g = innerIdx[l];
    Cin[3 * l] = POD.cx[g]; Cin[3 * l + 1] = POD.cy[g]; Cin[3 * l + 2] = POD.cz[g];
    strength_in[l] = wall.strength[g]; scf_in[l] = wall.scf[g];
    z_in[l] = POD.zFace[g]; r_in[l] = POD.rFace[g];
    lig[l] = wall.ligament[g]; split[l] = wall.split_site[g];
  }
  const grid = new Grid(Cin, nIn, 8);
  const n_slots = wall.n_slots, n_splits = wall.n_splits, n_sites = n_slots + n_splits;
  const site_faces = [], is_lig = [];
  for (let si = 0; si < n_slots; si++) { const fs = []; for (let l = 0; l < nIn; l++) if (lig[l] === si) fs.push(l); site_faces.push(fs); is_lig.push(true); }
  for (let spi = 0; spi < n_splits; spi++) { const fs = []; for (let l = 0; l < nIn; l++) if (split[l] === spi) fs.push(l); site_faces.push(fs); is_lig.push(false); }
  const band_h = 12, site_band = new Array(n_sites).fill(null), site_nbands = new Int32Array(n_sites).fill(1);
  for (let si = 0; si < n_sites; si++) {
    const fs = site_faces[si]; if (!is_lig[si] || !fs.length) continue;
    let zlo = Infinity, zhi = -Infinity; for (const l of fs) { if (z_in[l] < zlo) zlo = z_in[l]; if (z_in[l] > zhi) zhi = z_in[l]; }
    const K = Math.max(3, Math.round((zhi - zlo) / band_h));
    const b = new Int32Array(fs.length);
    for (let t = 0; t < fs.length; t++) b[t] = clip(Math.floor((z_in[fs[t]] - zlo) / Math.max(zhi - zlo, 1e-6) * K), 0, K - 1);
    site_band[si] = b; site_nbands[si] = K;
  }
  const split_capacity = new Float64Array(n_sites).fill(Infinity);
  for (let si = 0; si < n_sites; si++) {
    if (is_lig[si]) continue;
    const fs = site_faces[si]; if (!fs.length) continue;
    let cap = 0; for (const l of fs) if (isFinite(strength_in[l])) cap += strength_in[l];
    split_capacity[si] = cap > 0 ? cap : Infinity;
  }
  return { innerIdx, nIn, Cin, grid, strength_in, scf_in, z_in, r_in, n_slots, n_splits, n_sites, labels: wall.labels, site_faces, is_lig, site_band, site_nbands, split_capacity };
}

function nodeRadius(pipe, age, sp) {
  const mature = clip(age / sp.maturation, 0.05, 1);
  const swell = clip(1 + sp.swell_rate * Math.max(age - sp.maturation, 0), 1, sp.max_swell);
  return pipe * mature * swell;
}

function runSimulation(wm, roots, sp, ph, capFrames) {
  const T = sp.n_time_steps;
  let drive, cap;
  if (ph) { const ps = physPerStep(ph, T); drive = ps.drive; cap = ps.cap; }
  else { drive = new Float64Array(T).fill(1); cap = new Float64Array(T).fill(1); }
  const N = roots.n, Px = roots.nx, Py = roots.ny, Pz = roots.nz, pipe = roots.radius, birth = roots.birth;
  let maxBirth = 1; for (let i = 0; i < N; i++) if (birth[i] > maxBirth) maxBirth = birth[i];
  const birthTime = new Float64Array(N);
  for (let i = 0; i < N; i++) birthTime[i] = birth[i] / maxBirth * (sp.growth_fraction * T);
  const rNode = new Float64Array(N), rInnerHere = new Float64Array(N), baseNode = new Uint8Array(N);
  const zBase = POD.features.z_base_top;
  for (let i = 0; i < N; i++) { rNode[i] = Math.hypot(Px[i], Py[i]); rInnerHere[i] = rInnerAt(Pz[i]); baseNode[i] = Pz[i] < zBase * 1.25 ? 1 : 0; }
  // contact matrix: per inner-face contributions [nodeIdx, weight]
  const contrib = Array.from({ length: wm.nIn }, () => []);
  for (let j = 0; j < N; j++) {
    const pr = Math.max(sp.contact_patch_factor * pipe[j], sp.min_patch_radius);
    let fs = wm.grid.ball(Px[j], Py[j], Pz[j], pr);
    if (!fs.length) fs = [wm.grid.nearest(Px[j], Py[j], Pz[j]).idx];
    const w = new Float64Array(fs.length); let wsum = 0;
    for (let t = 0; t < fs.length; t++) {
      const l = fs[t], dx = wm.Cin[3 * l] - Px[j], dy = wm.Cin[3 * l + 1] - Py[j], dz = wm.Cin[3 * l + 2] - Pz[j];
      const d = Math.hypot(dx, dy, dz);
      w[t] = Math.max(1 - d / Math.max(pr, 1e-6), 0.05); wsum += w[t];
    }
    for (let t = 0; t < fs.length; t++) contrib[fs[t]].push([j, w[t] / wsum]);
  }
  const cum = new Float64Array(wm.nIn), peak = new Float64Array(wm.nIn);
  const ratioHist = []; // not needed for UI beyond final; keep light
  const activation = new Float64Array(wm.n_sites).fill(Infinity), order = [];
  let baseWedgeCum = 0;
  const z_waist_hi = POD.features.z_waist_hi;
  const nLig = wm.n_slots, needed = Math.max(1, Math.ceil(nLig * sp.breakthrough_frac));
  let breakthrough = Infinity;
  const pressNode = new Float64Array(N), stepPress = new Float64Array(wm.nIn);
  for (let t = 1; t <= T; t++) {
    const dmult = drive[t - 1], cmult = cap[t - 1];
    let wedgeSum = 0;
    for (let i = 0; i < N; i++) {
      const alive = birthTime[i] <= t;
      if (!alive) { pressNode[i] = 0; continue; }
      const age = t - birthTime[i], rad = nodeRadius(pipe[i], age, sp);
      const pen = (rNode[i] + rad) - rInnerHere[i];
      const radial = sp.contact_stiffness * Math.max(pen, 0);
      const wedge = baseNode[i] ? sp.base_wedge * rad : 0;
      pressNode[i] = (radial + wedge) * dmult;
      wedgeSum += wedge;
    }
    baseWedgeCum += wedgeSum * dmult * sp.dt;
    for (let l = 0; l < wm.nIn; l++) {
      let s = 0; const cc = contrib[l];
      for (let t2 = 0; t2 < cc.length; t2++) s += cc[t2][1] * pressNode[cc[t2][0]];
      if (sp.pull_assist > 0 && wm.z_in[l] < z_waist_hi) s += sp.pull_assist;
      stepPress[l] = s;
      if (s > peak[l]) peak[l] = s;
      cum[l] += s * sp.dt;
    }
    // per-site failure
    for (let si = 0; si < wm.n_sites; si++) {
      const fs = wm.site_faces[si]; if (!fs.length) continue;
      let ratio;
      if (wm.is_lig[si]) {
        const bands = wm.site_band[si], seen = new Set();
        for (let t2 = 0; t2 < fs.length; t2++) {
          const l = fs[t2];
          if (cum[l] * wm.scf_in[l] >= wm.strength_in[l] * cmult) seen.add(bands[t2]);
        }
        ratio = seen.size / wm.site_nbands[si];
      } else {
        ratio = (sp.hoop_factor * baseWedgeCum) / (wm.split_capacity[si] * cmult);
      }
      const thresh = wm.is_lig[si] ? sp.span_frac : 1;
      if (ratio >= thresh && !isFinite(activation[si])) { activation[si] = t; order.push(si); }
    }
    let nActive = 0; for (let si = 0; si < nLig; si++) if (isFinite(activation[si])) nActive++;
    if (nActive >= needed && !isFinite(breakthrough)) breakthrough = t;
    if (capFrames) capFrames.push(Float32Array.from(cum));   // per-step snapshot for playback
  }
  let firstSite = -1, firstStep = Infinity;
  for (let si = 0; si < wm.n_sites; si++) if (isFinite(activation[si]) && activation[si] < firstStep) { firstStep = activation[si]; firstSite = si; }
  // scatter cum to full-face field
  const faceField = new Float64Array(POD.nF);
  for (let l = 0; l < wm.nIn; l++) faceField[wm.innerIdx[l]] = cum[l];
  return { faceField, activation, order, firstStep, firstSite, breakthrough, nNodes: N };
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
function vertexIntensity(field, projectOuter) {
  let f = field;
  if (projectOuter) f = projectInnerToOuter(field);
  let vv = faceFieldToVertex(f);
  vv = smoothVertexField(vv, 2, 0.55);   // blend the heatmap so it radiates, not blobs
  const vmax = percentile(vv, 99);
  const out = new Array(vv.length);
  for (let i = 0; i < vv.length; i++) out[i] = Math.round(vv[i] * 100) / 100;
  return { intensity: out, cmax: Math.max(vmax, 1e-9) };
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
//  Young Rhizophora seedling prop-root cage  (RENDERING ONLY — the sim still
//  runs on the space-colonization node tree; this is a visual overlay).
//  Matches real early-stage propagules (reference photos): a tight radiating
//  cluster of 5-8 THIN, wiry, near-uniform-diameter roots that splay outward
//  and down from a single point near the base of the stem, forming a narrow
//  tripod/cage silhouette in the mud — NOT thick arched buttresses, and NOT a
//  mature tree's branched rhizophore system. Matte reddish-brown → tan bark.
//  These roots grow INSIDE the pod and only become visible once a seam cracks
//  open; `p` in [0,1] is the post-breakthrough emergence/extension fraction.
// ---------------------------------------------------------------------------
const _RZ = {
  base: [0.42, 0.25, 0.19],  // reddish-brown near the cluster / older wood
  tip:  [0.60, 0.45, 0.32],  // lighter reddish-tan toward the growing tips
};
function _sstep(t) { t = clip(t, 0, 1); return t * t * (3 - 2 * t); }
function _smoother(t) { t = clip(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); }
function _lerp(a, b, t) { return a + (b - a) * t; }
function _lerp3(a, b, t) { return [_lerp(a[0], b[0], t), _lerp(a[1], b[1], t), _lerp(a[2], b[2], t)]; }
function _rgb(c) { return `rgb(${Math.round(clip(c[0], 0, 1) * 255)},${Math.round(clip(c[1], 0, 1) * 255)},${Math.round(clip(c[2], 0, 1) * 255)})`; }

// One thin wiry root: samples of [x, y, z, tubeRadius, u]; u=0 at the cluster,
// 1 at the tip. Near-straight radial descent with a gentle outward bow. Shape
// is independent of growth p (only the drawn length changes) so we cache it.
function _wiryRoot(o) {
  const n = o.n, pts = [], a0 = o.azDeg * Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const r = _lerp(o.rStart, o.rEnd, Math.pow(t, 0.92)) + o.bow * Math.sin(Math.PI * t);
    const z = _lerp(o.z0, o.zEnd, t);
    const wig = o.wiggle ? o.wiggle * Math.PI / 180 * Math.sin(1.8 * Math.PI * t + o.wphase) : 0;
    const aa = a0 + (o.twist || 0) * Math.PI / 180 * t + wig;
    const tubeR = Math.max(_lerp(o.tubeBase, o.tubeTip, t), 0.35);   // near-uniform, slight taper
    pts.push([r * Math.cos(aa), r * Math.sin(aa), z, tubeR, t]);
  }
  return { pts, colA: o.colA, colB: o.colB, phase: o.phase, birthP: o.birthP, span: o.span };
}

let _rzCache = null;
function rhizophoreStrands() {
  if (_rzCache) return _rzCache;
  const H = POD.features.height, footR = rOuterAt(0.05 * H), gz = groundZ();
  const zTip = gz - 0.05 * H;                 // tips sink a little deeper into the substrate
  const clusterZ = 0.14 * H;                  // one tight origin near the base of the stem
  const rng = mulberry32(11), strands = [];
  const n = 9;                                // a fuller young-propagule tripod
  const baseReach = 0.62 * footR;             // wider, denser splay (still a tripod, not spider legs)
  for (let j = 0; j < n; j++) {
    const az = 360 * j / n + (rng() - 0.5) * 14;
    const reach = baseReach * (0.85 + 0.35 * rng());
    strands.push(_wiryRoot({
      azDeg: az, n: 24, rStart: 2.0, rEnd: reach, z0: clusterZ, zEnd: zTip * (0.92 + 0.16 * rng()),
      bow: footR * (0.03 + 0.045 * rng()), twist: (rng() - 0.5) * 8, wiggle: 2.5, wphase: rng() * 6.28,
      tubeBase: 2.1, tubeTip: 0.95, colA: _RZ.base, colB: _RZ.tip, phase: rng() * 6.28,
      birthP: 0.012 * j, span: 0.9,
    }));
  }
  _rzCache = strands;
  return strands;
}

function stageRootMesh(p) {
  const strands = rhizophoreStrands();
  const gz = groundZ();
  const X = [], Y = [], Z = [], I = [], J = [], K = [], C = [];
  const sides = 6, cs = [], sn = [];
  for (let k = 0; k < sides; k++) { const A = 2 * Math.PI * k / sides; cs.push(Math.cos(A)); sn.push(Math.sin(A)); }
  for (let sIdx = 0; sIdx < strands.length; sIdx++) {
    const st = strands[sIdx];
    const gf = clip((p - st.birthP) / st.span, 0, 1);
    if (gf <= 0.02) continue;
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
      if (dg < 6) ao *= _lerp(0.85, 1, clip(dg / 6, 0, 1));   // subtle mud-contact darkening
      ringBase.push(X.length);
      for (let k = 0; k < sides; k++) {
        X.push(P[0] + P[3] * (cs[k] * n1x + sn[k] * n2x));
        Y.push(P[1] + P[3] * (cs[k] * n1y + sn[k] * n2y));
        Z.push(P[2] + P[3] * (cs[k] * n1z + sn[k] * n2z));
        const shade = ao * (1 + 0.035 * Math.cos(2 * Math.PI * k / sides + st.phase));  // faint woody ridging
        C.push(_rgb([base[0] * shade, base[1] * shade, base[2] * shade]));
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
//  substrate / tidal-mud ground plane the roots plant into. Soft-edged (fades
//  into the backdrop rather than a hard ellipse silhouette), mottled mud texture
//  with micro-relief, a faint wet sheen offset toward the key light, and a wide
//  soft contact shadow (AO) under the pod so roots blend in rather than meeting
//  a hard line. Baked into vertex colours; `reveal` grows the disc in.
// ---------------------------------------------------------------------------
function groundZ() { return -0.075 * POD.features.height; }
function groundMesh(nR = 26, nT = 110, reveal = 1) {
  reveal = clip(reveal, 0, 1);
  const H = POD.features.height, zG = groundZ(), footR = rOuterAt(0.05 * H);
  const Rmax = 2.2 * footR * (0.14 + 0.86 * reveal);   // radial reveal
  const bg = [0.075, 0.095, 0.115];                    // viewpane backdrop for a soft fade
  const mud = [0.33, 0.26, 0.19], mudDark = [0.18, 0.145, 0.105];
  const lx = 0.826, ly = 0.563;                        // key-light xy direction (wet sheen)
  const rShIn = 0.30 * footR, rShOut = 1.85 * footR;   // wide, soft contact shadow
  const sx = lx * 0.5 * Rmax, sy = ly * 0.5 * Rmax;    // sheen reflection centre
  const X = [], Y = [], Z = [], C = [], I = [], J = [], K = [];
  const colAt = (x, y) => {
    const d = Math.hypot(x, y), rn = clip(d / Rmax, 0, 1);
    // mottled mud (multi-octave value noise)
    const nz = 0.5 + 0.34 * Math.sin(x * 0.05 + 1.3) * Math.cos(y * 0.045 - 0.7)
                   + 0.16 * Math.sin(x * 0.11 - y * 0.09 + 2.1);
    let c = _lerp3(mudDark, mud, clip(0.35 + 0.7 * nz, 0, 1));
    // wide soft contact shadow / ambient occlusion under the pod
    const sh = _smoother((d - rShIn) / (rShOut - rShIn));   // 0 under pod -> 1 outside
    const ao = 0.46 + 0.54 * sh;
    c = [c[0] * ao, c[1] * ao, c[2] * ao];
    // faint wet sheen: a broad soft reflection offset toward the light, cool tint
    const sheen = Math.pow(clip(1 - Math.hypot(x - sx, y - sy) / (0.9 * Rmax), 0, 1), 2) * (1 - 0.6 * rn);
    const wet = 0.14 * sheen;
    c = [c[0] + wet * 0.9, c[1] + wet, c[2] + wet * 1.2];
    // soft outer edge: fade into the backdrop so there is no hard silhouette line
    const fade = _smoother((rn - 0.62) / 0.38);
    return _lerp3(c, bg, fade);
  };
  X.push(0); Y.push(0); Z.push(zG); C.push(_rgb(colAt(0, 0)));
  const starts = [0];
  for (let ri = 1; ri <= nR; ri++) {
    const rr = Rmax * Math.pow(ri / nR, 1.18); starts.push(X.length);
    for (let t = 0; t < nT; t++) {
      const a = 2 * Math.PI * t / nT, x = rr * Math.cos(a), y = rr * Math.sin(a);
      const relief = 0.9 * Math.sin(a * 5 + ri * 1.7) + 0.5 * Math.sin(a * 13 - ri * 0.8) + 0.6 * Math.sin(ri * 2.1 + a * 2);
      X.push(x); Y.push(y); Z.push(zG + relief); C.push(_rgb(colAt(x, y)));
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
  const { intensity, cmax } = vertexIntensity(res.faceField, !!cfg.project_outer);
  const roots_payload = rootTubeMesh(roots);
  const T = sp.n_time_steps;
  const sites = wm.labels.map((lab, i) => ({
    label: lab, is_ligament: !!wm.is_lig[i],
    activation_step: isFinite(res.activation[i]) ? res.activation[i] : null,
  }));
  const stats = {
    n_nodes: roots.n,
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

function montecarlo(cfg, nRuns) {
  const pat = patternFromCfg(cfg), gp = growthFromCfg(cfg), sp = simFromCfg(cfg), ph = physFromCfg(cfg);
  const wall = buildFields(pat), wm = buildWallModel(wall);
  const n = clip(Math.round(nRuns || 24), 2, 120), T = sp.n_time_steps;
  const jitterRng = mulberry32(12345), jNorm = makeNormal(jitterRng);
  const first = [], brk = [], firstSite = [], orders = [], actSteps = [];
  const cumAccum = new Float64Array(POD.nF);
  for (let kk = 0; kk < n; kk++) {
    let g = gp;
    { // growth jitter (scale 0.5, like the Flask MC)
      g = Object.assign({}, gp);
      g.slot_bias = Math.max(0.2, gp.slot_bias * (1 + 0.5 * jNorm() * 0.3));
      g.down_bias = clip(gp.down_bias * (1 + 0.5 * jNorm() * 0.3), 0.1, 1);
    }
    const roots = grow(g, kk);
    const res = runSimulation(wm, roots, sp, ph);
    first.push(isFinite(res.firstStep) ? res.firstStep : Infinity);
    brk.push(isFinite(res.breakthrough) ? res.breakthrough : Infinity);
    firstSite.push(res.firstSite);
    orders.push(res.order.slice());
    actSteps.push(res.activation.slice());
    for (let f = 0; f < POD.nF; f++) cumAccum[f] += res.faceField[f];
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
  const { intensity, cmax } = vertexIntensity(cumAccum, false);
  const rep = grow(gp, 7), roots_payload = rootTubeMesh(rep);
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
    physical: physSummary(ph),
    breakthrough_time: spTimeContext(ph.species, isFinite(meanBrk) ? meanBrk : null, T, ph.salinity_ppt),
    window_time: spTimeContext(ph.species, T, T, ph.salinity_ppt),
    material_card: materialCard(ph.material),
  };
  return { intensity, cmax, roots: roots_payload, stats };
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
  const nF2 = capFrames.length, finalVv = toVert(capFrames[nF2 - 1]);
  const cmax = Math.max(percentile(finalVv, 99), 1e-9);
  const frames = new Array(nF2);
  for (let t = 0; t < nF2; t++) {
    const vv = (t === nF2 - 1) ? finalVv : toVert(capFrames[t]);
    const arr = new Float32Array(vv.length); for (let i = 0; i < vv.length; i++) arr[i] = vv[i];
    frames[t] = arr;
  }
  const sites = wm.labels.map((lab, i) => ({ label: lab, is_ligament: !!wm.is_lig[i], activation_step: isFinite(res.activation[i]) ? res.activation[i] : null }));
  const stats = {
    n_nodes: roots.n,
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
    activation: res.activation.map(a => isFinite(a) ? a : null),
    site_labels: wm.labels, is_lig: Array.from(wm.is_lig),
    timeline, stats, window_months: ph.species.window_months, species_name: ph.species.name,
  };
}

// ---------------------------------------------------------------------------
//  growing seedling shoot at the top opening: an olive-green stem that, once it
//  has cleared the rim, carries a pair of simple flat first leaves (like a real
//  young propagule) instead of staying a bare stick.
// ---------------------------------------------------------------------------
const _SHOOT_STEM = [0.42, 0.55, 0.28], _SHOOT_LEAF = [0.28, 0.52, 0.24];
function shootMesh(gfrac) {
  gfrac = clip(gfrac, 0, 1);
  if (gfrac <= 0.01) return null;
  const f = POD.features, H = f.height, top = f.top_center;
  const zT = top[2], cx0 = top[0], cy0 = top[1], stemH = 0.34 * H * gfrac;
  if (stemH < 1) return null;
  const X = [], Y = [], Z = [], I = [], J = [], K = [], C = [];
  const stemCol = _rgb(_SHOOT_STEM), leafCol = _rgb(_SHOOT_LEAF);
  // stem: tapered tube up from the rim
  const nSeg = 10, sides = 7, rBase = Math.max(2.2, 0.055 * f.inner_r_waist);
  const cs = [], sn = [];
  for (let k = 0; k < sides; k++) { const a = 2 * Math.PI * k / sides; cs.push(Math.cos(a)); sn.push(Math.sin(a)); }
  const ring = [];
  for (let s = 0; s <= nSeg; s++) {
    const t = s / nSeg, z = zT + stemH * t, r = _lerp(rBase, rBase * 0.45, t);
    ring.push(X.length);
    for (let k = 0; k < sides; k++) { X.push(cx0 + r * cs[k]); Y.push(cy0 + r * sn[k]); Z.push(z); C.push(stemCol); }
  }
  for (let s = 0; s < nSeg; s++) {
    const a0 = ring[s], a1 = ring[s + 1];
    for (let k = 0; k < sides; k++) { const k2 = (k + 1) % sides; I.push(a0 + k, a0 + k); J.push(a0 + k2, a1 + k2); K.push(a1 + k2, a1 + k); }
  }
  // paired first leaves once the shoot has grown past the rim
  const leafG = clip((gfrac - 0.40) / 0.60, 0, 1);
  if (leafG > 0.05) {
    const tip = [cx0, cy0, zT + stemH], leafLen = 0.14 * H * leafG, leafW = 0.42 * leafLen, nL = 8;
    for (const azDeg of [18, 198]) {                      // one opposite pair
      const az = azDeg * Math.PI / 180, ox = Math.cos(az), oy = Math.sin(az);
      const dirx = ox * 0.72, diry = oy * 0.72, dirz = 0.69;   // midrib: up-and-out
      const px = -oy, py = ox;                                  // width direction (horizontal)
      const left = [], right = [];
      for (let i = 0; i <= nL; i++) {
        const t = i / nL, w = leafW * Math.pow(Math.sin(Math.PI * t), 0.7);
        const cx = tip[0] + dirx * leafLen * t, cy = tip[1] + diry * leafLen * t, cz = tip[2] + dirz * leafLen * t;
        left.push(X.length); X.push(cx + px * w); Y.push(cy + py * w); Z.push(cz); C.push(leafCol);
        right.push(X.length); X.push(cx - px * w); Y.push(cy - py * w); Z.push(cz); C.push(leafCol);
      }
      for (let i = 0; i < nL; i++) {
        const l0 = left[i], r0 = right[i], l1 = left[i + 1], r1 = right[i + 1];
        I.push(l0, l0); J.push(r0, r1); K.push(r1, l1);
      }
    }
  }
  const rnd = v => Math.round(v * 10) / 10;
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
function crackReport(cfg, nRuns) {
  const n = clip(Math.round(nRuns || 20), 4, 60);
  const cur = MATERIALS[cfg.material] ? cfg.material : "clay";
  const gp = growthFromCfg(cfg), sp = simFromCfg(cfg), pat = patternFromCfg(cfg);
  const wall = buildFields(pat), wm = buildWallModel(wall), T = sp.n_time_steps;
  // grow the n root systems ONCE (growth is material-independent) and reuse them
  const jitterRng = mulberry32(12345), jNorm = makeNormal(jitterRng), rootSys = [];
  for (let kk = 0; kk < n; kk++) {
    const g = Object.assign({}, gp);
    g.slot_bias = Math.max(0.2, gp.slot_bias * (1 + 0.5 * jNorm() * 0.3));
    g.down_bias = clip(gp.down_bias * (1 + 0.5 * jNorm() * 0.3), 0.1, 1);
    rootSys.push(grow(g, kk));
  }
  const mats = ["clay", "bioplastic", "concrete"], byMat = {};
  const finite = a => a.filter(v => isFinite(v)), mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : Infinity;
  for (const mk of mats) {
    const ph = physFromCfg(Object.assign({}, cfg, { material: mk }));
    const first = [], brk = [], firstSite = [];
    for (let kk = 0; kk < n; kk++) {
      const res = runSimulation(wm, rootSys[kk], sp, ph);
      first.push(isFinite(res.firstStep) ? res.firstStep : Infinity);
      brk.push(isFinite(res.breakthrough) ? res.breakthrough : Infinity);
      firstSite.push(res.firstSite);
    }
    const fsc = {}; for (const si of firstSite) if (si >= 0) { const lab = wm.labels[si]; fsc[lab] = (fsc[lab] || 0) + 1; }
    const fscSorted = Object.fromEntries(Object.entries(fsc).sort((a, b) => b[1] - a[1]));
    const mFirst = mean(finite(first)), mBrk = mean(finite(brk));
    byMat[mk] = {
      first_site_counts: fscSorted, reliability: finite(brk).length / n,
      mean_first_crack: isFinite(mFirst) ? mFirst : null, mean_breakthrough: isFinite(mBrk) ? mBrk : null,
      first_crack_months: spTimeContext(ph.species, isFinite(mFirst) ? mFirst : null, T, ph.salinity_ppt).months,
      breakthrough_months: spTimeContext(ph.species, isFinite(mBrk) ? mBrk : null, T, ph.salinity_ppt).months,
      strength: MATERIALS[mk].fracture_strength_mpa,
    };
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
  const strengthCur = MATERIALS[cur].fracture_strength_mpa, strengthBio = MATERIALS.bioplastic.fracture_strength_mpa;
  const nm = v => v == null ? "—" : `month ${v.toFixed(1)}`;
  const matName = MATERIALS[cur].name;
  // ---- narrative ----
  const where = topSite
    ? `In ${matName} pods, cracking initiates at the ${isLig ? "upper-waist slot → foot ligament" : "base split-line"} seam at ${posWords}${consistency >= 60 ? ", consistently" : ", though the location varies"} — this seam is the first to fail in ${consistency}% of ${n} randomized runs.`
    : `No consistent first-crack site emerged in ${n} runs (the wall rarely reaches threshold for ${matName}).`;
  const why = `That seam overlaps the peak root-pressure band in the upper waist, where the thickening propagule presses hardest against the narrow inner bore. ${matName}'s low flexural strength (~${strengthCur} MPa, versus bioplastic's ~${strengthBio} MPa) means it reaches its failure threshold there before the other seams — so the weakest material fails earliest and most predictably at the highest-stress ligament.`;
  const when = `Timing (${matName}): first crack at ~${nm(fcMonths)}, full 4-piece breakthrough at ~${nm(brkMonths)} of a ~${win}-month growth window (${rel}% of runs break within the window). By comparison — first crack: clay ~${nm(byMat.clay.first_crack_months)}, bioplastic ~${nm(byMat.bioplastic.first_crack_months)}, concrete ~${nm(byMat.concrete.first_crack_months)}.`;
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
  const summary = topSite ? base + varyClause + timingClause
    : `${matName} rarely cracks within the growth window under the current design — the seams may be too strong / too shallow for this material to release reliably.`;
  return {
    material: cur, material_name: matName, n_runs: n,
    first_site: topSite, first_site_pos: posWords, consistency,
    first_crack_months: fcMonths, breakthrough_months: brkMonths,
    window_months: win, outplant_months: outplant, reliability: rel,
    compare: mats.map(mk => ({ key: mk, name: MATERIALS[mk].name, strength: byMat[mk].strength,
      first_crack_months: byMat[mk].first_crack_months, breakthrough_months: byMat[mk].breakthrough_months,
      reliability: Math.round(100 * byMat[mk].reliability) })),
    text: { where, why, when, consistency: consistencyText, summary },
    first_site_counts: s.first_site_counts,
  };
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

async function loadPod() {
  // geometry is provided by data/pod.js as window.POD_RAW (loaded via <script>,
  // which avoids the large-body fetch() reset in the in-app preview proxy).
  if (!window.POD_RAW) throw new Error("pod geometry (data/pod.js) not loaded");
  buildPod(window.POD_RAW);
  return features();
}

window.ENGINE = {
  loadPod, features, simulate, montecarlo,
  materials: () => ({ materials: Object.fromEntries(Object.entries(MATERIALS).map(([k, m]) => [k, materialCard(m)])), default: "bioplastic" }),
  species: () => ({ species: SPECIES, default: "rhizophora" }),
  provenance: buildRegistry,
  baseMesh, seams: seamTubeMesh, exploded: explodedSectors, propagule: propaguleMesh,
  stageRoots: stageRootMesh, ground: groundMesh,
  simulateFrames, shoot: shootMesh, crackReport,
};
