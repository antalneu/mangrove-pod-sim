"use strict";
window.addEventListener("error", (e) => {
  try { document.getElementById("bootmsg").innerHTML =
    (e.message || "") + "<br><small>" + (e.filename || "").split("/").pop() + ":" + (e.lineno || "") + "</small>"; } catch (_) {}
});
const $ = (id) => document.getElementById(id);
const plotDiv = $("plot");

// ---- parameter defaults & presets ------------------------------------------
const DEFAULTS = {
  n_slots: 4, slot_length_frac: 0.22, slot_width_deg: 15,
  slot_z_center_frac: 0.55, align: "feet", split_score: 0.35,
  seam_score: 0.0, seam_width_deg: 40, theta_offset_deg: 0,
};
const PRESETS = {
  "as-drawn": {},
  "shorter-slots": { slot_length_frac: 0.10 },
  "longer-slots": { slot_length_frac: 0.34 },
  "slots-higher": { slot_z_center_frac: 0.62 },
  "slots-lower": { slot_z_center_frac: 0.42 },
  "wider-slots": { slot_width_deg: 26 },
  "narrower-slots": { slot_width_deg: 8 },
  "8-slots": { n_slots: 8 },
  "slots-over-splits": { align: "split" },
  "deep-base-score": { split_score: 0.7 },
  "deep-seams": { seam_score: 0.6, seam_width_deg: 50 },
};
const WRITE_IDS = ["n_slots","slot_length_frac","slot_width_deg","slot_z_center_frac",
                   "split_score","seam_score","seam_width_deg","theta_offset_deg"];
const TRIGGER_IDS = ["n_slots","slot_length_frac","slot_width_deg","slot_z_center_frac",
                     "split_score","theta_offset_deg"];

let UIMATS = {}, UISPS = {};   // renamed: engine.js already has global MATERIALS/SPECIES

// ---- slider <-> output sync -------------------------------------------------
function syncOutputs() {
  document.querySelectorAll("input[type=range]").forEach(r => {
    const o = $("o_" + r.id); if (o) o.textContent = r.value;
  });
}
document.querySelectorAll("input[type=range]").forEach(r =>
  r.addEventListener("input", () => { const o=$("o_"+r.id); if(o) o.textContent = r.value; }));
TRIGGER_IDS.concat(["align"]).forEach(id =>
  $(id).addEventListener("input", () => { $("preset").value = "custom"; }));

$("preset").addEventListener("change", applyPreset);
function applyPreset() {
  const name = $("preset").value;
  if (name === "custom") { setParamBox(true); return; }
  const p = { ...DEFAULTS, ...(PRESETS[name] || {}) };
  for (const k of WRITE_IDS) if ($(k)) $(k).value = p[k];
  $("align").value = p.align;
  setParamBox(name !== "as-drawn");
  syncOutputs();
}
function setParamBox(enabled) {
  $("paramBox").style.opacity = enabled ? "1" : "0.4";
  $("paramBox").style.pointerEvents = enabled ? "auto" : "none";
}

// ---- material / species cards ----------------------------------------------
$("material").addEventListener("change", renderMaterial);
$("species").addEventListener("change", renderSpecies);
$("salinity_ppt").addEventListener("input", renderSpecies);

function renderMaterial() {
  const m = UIMATS[$("material").value]; if (!m) return;
  const bio = m.biodegradable
    ? `<span class="tag lit">${m.biodegradability}</span>`
    : `<span class="tag bad">${m.biodegradability}</span>`;
  $("materialCard").innerHTML =
    `<div class="matblurb">${m.blurb}</div>` +
    row("Fracture strength", `${m.fracture_strength_mpa} MPa`,
        `range ${m.fracture_range_mpa[0]}–${m.fracture_range_mpa[1]} · estimate`) +
    row("Stiffness", `~${m.stiffness_mpa} MPa`, "estimate") +
    row("Wet/tidal loss", `${(m.wet_strength_loss_per_month*100)}%/month`, "estimate") +
    `<div class="matrow"><span class="mk">Biodegradability</span>${bio}</div>`;
  const w = $("materialWarn");
  if (m.warn) { w.classList.remove("hidden"); w.textContent = m.warn_text; }
  else w.classList.add("hidden");
}
function row(k, v, u) {
  return `<div class="matrow"><span class="mk">${k}</span>` +
    `<span class="mv">${v}</span><span class="mu">${u||""}</span></div>`;
}
function renderSpecies() {
  const s = UISPS[$("species").value]; if (!s) return;
  const sal = +$("salinity_ppt").value;
  const [lo, hi] = s.salinity_optimum_ppt;
  const inband = sal >= lo && sal <= hi;
  let info = `<div class="matblurb"><i>${s.latin}</i> — ${s.blurb}</div>` +
    row("Outplant readiness", `~${s.outplant_months} months`, "literature") +
    row("Mature growth", `${s.mature_growth_m_yr[0]}–${s.mature_growth_m_yr[1]} m/yr`, "literature") +
    row("Time window", `~${s.window_months} months`, "full step axis");
  if (s.node_interval_days)
    info += row("Node interval", `~${s.node_interval_days} days`, "biological clock");
  info += row("Early root", s.early_root_note, "→ slow-start force ramp");
  $("speciesInfo").innerHTML = info;
  $("salNote").innerHTML = `Optimal early-growth salinity <b>${lo}–${hi} ppt</b>. ` +
    (inband ? `<span class="ok">at ${sal} ppt: normal growth rate.</span>`
            : `<span class="warnt">at ${sal} ppt: outside band → growth slowed, real elapsed time stretched.</span>`);
}

// ---- calibration mode -------------------------------------------------------
["calibration_active","calibration_force_n","calibration_area_mm2"].forEach(id =>
  $(id).addEventListener("input", renderCalib));
function renderCalib() {
  const on = $("calibration_active").checked;
  $("calibBox").style.opacity = on ? "1" : "0.45";
  $("calibBox").style.pointerEvents = on ? "auto" : "none";
  const f = parseFloat($("calibration_force_n").value);
  const a = parseFloat($("calibration_area_mm2").value);
  const out = $("calibOut");
  if (on && f > 0 && a > 0) {
    out.innerHTML = `→ <b>${(f/a).toFixed(2)} MPa</b> ` +
      `<span class="tag meas">MEASURED — overrides the estimate</span>`;
  } else if (on) { out.textContent = "enter force (N) and contact area (mm²) to compute MPa"; }
  else { out.textContent = "using the estimated root pressure above"; }
}

// ---- gather config ----------------------------------------------------------
function cfg(extra) {
  const preset = $("preset").value;
  const c = {
    pattern: preset === "as-drawn" ? "as-drawn" : "parametric",
    name: preset,
    n_slots: +$("n_slots").value,
    slot_length_frac: +$("slot_length_frac").value,
    slot_width_deg: +$("slot_width_deg").value,
    slot_z_center_frac: +$("slot_z_center_frac").value,
    align: $("align").value,
    split_score: +$("split_score").value,
    seam_score: +$("seam_score").value,
    seam_width_deg: +$("seam_width_deg").value,
    theta_offset_deg: +$("theta_offset_deg").value,
    material: $("material").value,
    species: $("species").value,
    salinity_ppt: +$("salinity_ppt").value,
    root_pressure_mpa: +$("root_pressure_mpa").value,
    calibration_active: $("calibration_active").checked,
    calibration_force_n: $("calibration_force_n").value,
    calibration_area_mm2: $("calibration_area_mm2").value,
    seed: +$("seed").value,
    down_bias: +$("down_bias").value,
    slot_bias: +$("slot_bias").value,
    n_attractors: +$("n_attractors").value,
    contact_stiffness: +$("contact_stiffness").value,
    n_time_steps: +$("n_time_steps").value,
    pull_assist: +$("pull_assist").value,
    show_roots: $("show_roots").checked,
    project_outer: true,   // stress always projected to the visible (outer) surface
  };
  return Object.assign(c, extra || {});
}

// ---- render state -----------------------------------------------------------
// stress heat-scale: the low end is the CURRENT material's own colour, so the
// pod still reads as clay / concrete / bioplastic at low stress (finish + hue
// stay legible even mid-animation), ramping up to warning → critical.
function stressScale() {
  const c = materialLook().color;
  return [[0.0, c], [0.16, c], [0.42, "#e9c46a"], [0.72, "#e76f51"], [1.0, "#c1121f"]];
}
// explicit colorbar sizing (Plotly's auto-sizing can throw "axis scaling" here)
const CBAR = { len:0.6, thickness:14, x:0.98, xpad:0, ypad:0, outlinecolor:"rgba(255,255,255,0.12)",
  tickfont:{ color:"#bdb7ab", size:10 }, title:{ text:"stress", font:{ color:"#bdb7ab", size:11 } } };
// subtle molded parting-line accent (reads as a deliberate product feature)
const SEAM_COLOR = "#7c6f5d", ROOT_COLOR = "#6b4525", PIECE_COLOR = "#c7b291";
const PROP_COLOR = "#7d8c4e";   // olive seedling / propagule body
// per-material product finish: a clean flat base colour + soft studio lighting.
// The pod renders SMOOTH (flatshading:false → interpolated normals); the base
// pod is a flat material colour (no per-vertex noise — that read as faceting).
// The four visibly-distinct material colours are core to the tool and stay put.
const MATERIAL_LOOK = {
  // PHA / PHBV: waxy off-white bioplastic, gently glossy
  pha:        { color:"#e7dcbb", light:{ ambient:0.48, diffuse:0.80, specular:0.4, roughness:0.34, fresnel:0.22 } },
  // PLA: cooler, harder, slightly whiter plastic — a touch more matte
  pla:        { color:"#ece6d6", light:{ ambient:0.48, diffuse:0.82, specular:0.34, roughness:0.4, fresnel:0.2 } },
  // clay: warm terracotta, fully matte (fired-earth look)
  clay:       { color:"#b5673c", light:{ ambient:0.5, diffuse:0.88, specular:0.08, roughness:0.9, fresnel:0.12 } },
  // concrete: cool grey, matte with a faint mineral sheen
  concrete:   { color:"#9a9790", light:{ ambient:0.52, diffuse:0.84, specular:0.14, roughness:0.82, fresnel:0.16 } },
};
function currentMaterial() { const v = $("material") ? $("material").value : "pha"; return MATERIAL_LOOK[v] ? v : "pha"; }
function materialLook() { return MATERIAL_LOOK[currentMaterial()]; }
function stressOn() { const el = $("show_stress"); return el ? el.checked : true; }
// matte, bark-like roots (very low specular, high roughness — no plastic sheen)
const ROOT_LIGHT = { ambient:0.5, diffuse:0.95, specular:0.06, roughness:0.95, fresnel:0.03 };
const MESH_LIGHT = { ambient:0.42, diffuse:0.9, specular:0.18, roughness:0.55, fresnel:0.15 };
// one dominant directional "sun" (key) from a defined angle; ambient is the sky
// fill, fresnel the rim on the silhouette. Cast shadows / AO are baked into the
// ground and root meshes (Plotly WebGL has one light and no real shadow pass).
const SUN = { x:0.832, y:0.555 };                 // sun xy direction (ground shadow uses this)
const LIGHT_POS = { x:300, y:200, z:340 };

let BASE_MESH = null, VIZ_MESH = null, BASE_LAYOUT = null, SEAM_TRACE = null, PROP_TRACE = null, EXPLODED = null;

// The intact pod renders from the high-res VISUAL mesh when present (smoother
// curves); the SIM still runs on BASE_MESH's geometry. Stress is a per-sim-vertex
// field, so it's gathered onto the visual mesh via its nearest-sim-vertex map.
function podGeom() { return VIZ_MESH || BASE_MESH; }
function podIntensity(simIntensity) {
  const m = VIZ_MESH && VIZ_MESH.map;
  if (!m || !simIntensity) return simIntensity;
  const out = new Array(m.length);
  for (let v = 0; v < m.length; v++) out[v] = simIntensity[m[v]];
  return out;
}
let LAST = { intensity: null, cmax: 1, roots: null };
let viewMode = "intact";
// growth elements (ground, roots, seedling) stay hidden until the sim starts —
// the pod is shown alone in its clean intact state on load.
let sceneRevealed = false;
// invisible extent markers so the camera frames the FULL scene (pod + eventual
// ground + roots) from the start — the view never jumps as elements appear.
let BOUNDS_TRACE = null;
function buildBounds() {
  const f = ENGINE.features(), Rg = 2.2 * f.foot_r * 1.04;
  const zLo = f.ground_z - 0.10 * f.height, zHi = f.top_z * 1.01;
  const x = [], y = [], z = [];
  for (const sx of [-Rg, Rg]) for (const sy of [-Rg, Rg]) for (const sz of [zLo, zHi]) { x.push(sx); y.push(sy); z.push(sz); }
  return { type:"scatter3d", mode:"markers", x, y, z,
    marker:{ size:0.1, opacity:0, color:"#000" }, hoverinfo:"skip", showlegend:false };
}
// sun direction + root-contact points passed to the ground so it can bake the
// pod's cast shadow and the mounds/AO where each root presses into the mud
let LANDINGS = [];
function groundOpts() { return { sunx: SUN.x, suny: SUN.y, landings: LANDINGS }; }

function baseLayout() {
  const ax = { visible:false, showbackground:false, showgrid:false, zeroline:false, showspikes:false };
  return {
    paper_bgcolor:"rgba(0,0,0,0)", plot_bgcolor:"rgba(0,0,0,0)",
    font:{ color:"#bdb7ab", size:12 }, margin:{ l:0, r:0, t:20, b:0 }, title:"",
    scene:{ xaxis:ax, yaxis:ax, zaxis:{...ax}, bgcolor:"rgba(0,0,0,0)",
      aspectmode:"data", camera:{ eye:{ x:1.65, y:1.65, z:0.72 }, center:{ x:0, y:0, z:-0.06 } }, uirevision:"keep" },
  };
}
function buildSeamTrace(g) {
  if (!g) return null;
  return { type:"mesh3d", x:g.x, y:g.y, z:g.z, i:g.i, j:g.j, k:g.k,
    color:SEAM_COLOR, flatshading:false, hoverinfo:"skip", name:"seams",
    lighting:{ ambient:0.55, diffuse:0.75, specular:0.5, roughness:0.4 }, lightposition:LIGHT_POS };
}
function buildRootTrace(g) {
  if (!g) return null;
  const tr = { type:"mesh3d", x:g.x, y:g.y, z:g.z, i:g.i, j:g.j, k:g.k,
    flatshading:false, hoverinfo:"skip", name:"roots",
    lighting:ROOT_LIGHT, lightposition:LIGHT_POS };
  if (g.vertexcolor) tr.vertexcolor = g.vertexcolor; else tr.color = ROOT_COLOR;
  return tr;
}
// the 3-stage root morphology is parametric (independent of the sim); scrub via
// the "root growth stage" slider. Rebuild the trace when the stage changes.
let ROOTS_TRACE = null;
function rebuildRoots() {
  const el = $("root_stage"), p = el ? (+el.value) / 100 : 1;
  ROOTS_TRACE = buildRootTrace(ENGINE.stageRoots(p));
}
// mud substrate the roots plant into (matte mudflat) — grounds the whole scene
let GROUND_TRACE = null, WATER_TRACE = null, DEBRIS_TRACE = null;
function buildGroundTrace(g) {
  if (!g) return null;
  return { type:"mesh3d", x:g.x, y:g.y, z:g.z, i:g.i, j:g.j, k:g.k, vertexcolor:g.vertexcolor,
    flatshading:false, hoverinfo:"skip", name:"ground",
    lighting:{ ambient:0.64, diffuse:0.56, specular:0.22, roughness:0.72, fresnel:0.10 }, lightposition:LIGHT_POS };
}
// surrounding shallow tidal water + puddle surface — glossy (high specular) so the
// baked sun-glint reads as a soft wet reflection
function buildWaterTrace(g) {
  if (!g) return null;
  return { type:"mesh3d", x:g.x, y:g.y, z:g.z, i:g.i, j:g.j, k:g.k, vertexcolor:g.vertexcolor,
    flatshading:false, hoverinfo:"skip", name:"water",
    lighting:{ ambient:0.34, diffuse:0.5, specular:0.95, roughness:0.14, fresnel:0.6 }, lightposition:LIGHT_POS };
}
// scattered organic debris (shells, pebbles, leaves, sticks, algae) — matte
function buildDebrisTrace(g) {
  if (!g) return null;
  return { type:"mesh3d", x:g.x, y:g.y, z:g.z, i:g.i, j:g.j, k:g.k, vertexcolor:g.vertexcolor,
    flatshading:false, hoverinfo:"skip", name:"debris",
    lighting:{ ambient:0.6, diffuse:0.6, specular:0.18, roughness:0.8 }, lightposition:LIGHT_POS };
}
// push the whole substrate (water → mud → debris) in back-to-front order
function pushSubstrate(data, reveal) {
  if (reveal == null || reveal >= 0.999) {
    if (WATER_TRACE) data.push(WATER_TRACE);
    if (GROUND_TRACE) data.push(GROUND_TRACE);
    if (DEBRIS_TRACE) data.push(DEBRIS_TRACE);
  } else {
    const wt = buildWaterTrace(ENGINE.water(22, 100, reveal, groundOpts())); if (wt) data.push(wt);
    const gt = buildGroundTrace(ENGINE.ground(28, 120, reveal, groundOpts())); if (gt) data.push(gt);
    if (reveal > 0.85 && DEBRIS_TRACE) data.push(DEBRIS_TRACE);   // debris settles in once the flat is mostly formed
  }
}
function groundOn() { const el = $("show_ground"); return el ? el.checked : true; }
function buildPropTrace(g) {
  if (!g) return null;
  return { type:"mesh3d", x:g.x, y:g.y, z:g.z, i:g.i, j:g.j, k:g.k,
    color:PROP_COLOR, flatshading:false, hoverinfo:"skip", name:"seedling",
    lighting:{ ambient:0.5, diffuse:0.8, specular:0.12, roughness:0.8 }, lightposition:LIGHT_POS };
}
function propOn() { const el = $("show_prop"); return el ? el.checked : false; }
// Exploded view driven by the authored 4-piece asset (data/pieces.js). Each
// piece is pushed outward by `gap` (world units) along its own explode dir.
// VISUAL-ONLY: per-piece material colour, no stress mapping (different topology).
const PIECE_GAP_FRAC = 0.6;   // widen for clarity in the Exploded display
// all 4 pieces share the one selected material (no per-piece tint — a stray tint
// read as a mismatched darker piece; the 4 pieces are one material by definition)
function pieceColor(idx) { return materialLook().color; }
function pieceTraces(gap, look) {
  const P = ENGINE.assetPieces(); if (!P) return null;
  return P.map((p, idx) => ({
    type:"mesh3d", x: p.x.map(v => v + gap * p.dx), y: p.y.map(v => v + gap * p.dy), z: p.z,
    i: p.i, j: p.j, k: p.k, flatshading:false, hoverinfo:"skip", name:"piece",
    color: pieceColor(idx), lighting: look.light, lightposition: LIGHT_POS,
  }));
}
function render() {
  if (!BASE_MESH) return;
  const data = [];
  if (BOUNDS_TRACE) data.push(BOUNDS_TRACE);   // fixes the camera frame
  const look = materialLook(), showStress = stressOn() && !!LAST.intensity;
  if (sceneRevealed && groundOn()) pushSubstrate(data);   // water + mudflat + debris, behind everything
  const AP = ENGINE.assetPieces();
  if (viewMode === "exploded" && (AP || EXPLODED)) {
    if (AP) {
      // authored 4-piece asset, widened, per-piece material colour (visual-only)
      for (const t of pieceTraces(PIECE_GAP_FRAC * ENGINE.features().outer_r_waist, look)) data.push(t);
    } else {
      let barSet = false;
      for (const s of EXPLODED) {   // fallback: procedural angular split (with stress)
        const t = { type:"mesh3d", x:s.x, y:s.y, z:s.z, i:s.i, j:s.j, k:s.k,
          flatshading:false, hoverinfo:"skip", name:"piece", lighting:look.light, lightposition:LIGHT_POS };
        if (showStress) {
          t.intensity = s.orig.map(o => LAST.intensity[o]);
          t.colorscale = stressScale(); t.cmin = 0; t.cmax = LAST.cmax; t.showscale = !barSet;
          if (!barSet) { t.colorbar = CBAR; barSet = true; }
        } else { t.color = look.color; }
        data.push(t);
      }
    }
    if (sceneRevealed && propOn() && PROP_TRACE) data.push(PROP_TRACE);   // seedling revealed between the pieces
    // roots grow INSIDE the pod — only shown once it has broken apart
    if (sceneRevealed && $("show_roots").checked && ROOTS_TRACE) data.push(ROOTS_TRACE);
  } else {
    // clean material-coloured pod is the DEFAULT look; stress is a toggled overlay
    const m = Object.assign({}, podGeom());
    delete m.intensity; delete m.colorscale; delete m.cmin; delete m.cmax; delete m.color; delete m.vertexcolor; delete m.map;
    m.lighting = look.light; m.lightposition = LIGHT_POS;
    m.flatshading = false; m.showscale = false;
    if (showStress) {
      m.intensity = podIntensity(LAST.intensity); m.colorscale = stressScale();
      m.cmin = 0; m.cmax = LAST.cmax; m.showscale = true; m.colorbar = CBAR;
    } else {
      m.color = look.color;   // clean flat material colour — smooth-shaded, no vertex noise
    }
    data.push(m);
    if (sceneRevealed && propOn() && PROP_TRACE) data.push(PROP_TRACE);
    // (seam markings intentionally not drawn on the intact pod — the break-lines
    //  are shown by the actual pieces in the Exploded view)
    // while intact, roots stay hidden inside the pod — the outward push shows
    // only as the internal stress heatmap, never as geometry around the outside
  }
  // newPlot (not react): react throws "axis scaling" when it must ADD a colorbar
  // to an existing 3D plot; newPlot rebuilds cleanly, uirevision keeps the camera.
  Plotly.newPlot(plotDiv, data, BASE_LAYOUT, { responsive:true, displaylogo:false });
}
function updateStress(intensity, cmax, roots) {
  LAST.intensity = intensity; LAST.cmax = cmax;
  sceneRevealed = true;   // a run reveals the ground + mature roots
  // roots come from the parametric stage model, not the sim node tree; a full
  // run means mature roots, so show the full stilt cage.
  if ($("root_stage")) { $("root_stage").value = 100; const o = $("o_root_stage"); if (o) o.textContent = "100"; }
  rebuildRoots();
  render();
}
function setView(v) {
  viewMode = v;
  document.querySelectorAll("#viewSeg .segbtn").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  if (v === "exploded" && !ENGINE.assetPieces() && !EXPLODED) {
    busy(true, "building exploded view…");
    compute(() => { EXPLODED = ENGINE.exploded(); })
      .then(() => { busy(false); render(); })
      .catch(e => { busy(false); showError("Exploded view", e); });
  } else render();
}

// ---- overlay / spinner ------------------------------------------------------
function busy(on, msg) {
  $("overlay").classList.toggle("hidden", !on);
  if (msg) $("overlayMsg").textContent = msg;
  $("runBtn").disabled = on; $("mcBtn").disabled = on;
}
// run heavy compute off the paint frame so the spinner shows
function compute(fn) {
  return new Promise((res, rej) =>
    setTimeout(() => { try { res(fn()); } catch (e) { rej(e); } }, 20));
}

function showError(where, e) {
  const vd = $("verdict");
  vd.className = "verdict nobreak";
  vd.innerHTML = `${where} failed: ${e.message}`;
  console.error(where, e);
}
async function runSim() {
  busy(true, "growing roots & pressurising wall…");
  try {
    const { intensity, cmax, roots, stats } = await compute(() => ENGINE.simulate(cfg()));
    updateStress(intensity, cmax, roots);
    renderSingle(stats);
  } catch (e) { showError("Simulation", e); }
  finally { busy(false); }
}
async function runMC() {
  const n = +$("n_runs").value;
  busy(true, `running ${n} randomized simulations…`);
  try {
    const { intensity, cmax, roots, stats } = await compute(() => ENGINE.montecarlo(cfg(), n));
    updateStress(intensity, cmax, roots);
    renderMC(stats);
  } catch (e) { showError("Monte Carlo", e); }
  finally { busy(false); }
}
$("runBtn").addEventListener("click", runSim);
$("mcBtn").addEventListener("click", runMC);

// ============================================================================
//  GROWTH ANIMATION — play the simulation through time
// ============================================================================
const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
// small, even outward drift per quarter-piece as it breaks through (not a blow-apart)
const SHOOT_COLOR = "#6f9f3f", POP_FRAMES = 12, POP_GAP_FRAC = 0.14;
let ANIM = null, animTimer = null, animPlaying = false, animIdx = 0, animSpeed = 1, animPhase = "intact", animDirty = true;

function buildShootTrace(g) {
  if (!g) return null;
  const tr = { type:"mesh3d", x:g.x, y:g.y, z:g.z, i:g.i, j:g.j, k:g.k,
    flatshading:false, hoverinfo:"skip", name:"shoot",
    lighting:{ ambient:0.46, diffuse:0.82, specular:0.34, roughness:0.42, fresnel:0.12 }, lightposition:LIGHT_POS };
  if (g.vertexcolor) tr.vertexcolor = g.vertexcolor; else tr.color = SHOOT_COLOR;
  return tr;
}
function setPlayBtn(playing) {
  const b = $("playBtn"); if (b) b.innerHTML = playing ? "Pause growth" : "Play growth";
}
async function playGrowth() {
  if (animPlaying) { pauseAnim(); return; }
  if (!ANIM || animDirty) {
    busy(true, "simulating growth through time…");
    try {
      ANIM = await compute(() => {
        const a = ENGINE.simulateFrames(cfg());
        a.exploded = ENGINE.exploded(0);   // base (gap 0) positions + pop directions
        a.T = a.n_time_steps;
        return a;
      });
    } catch (e) { busy(false); showError("Growth animation", e); return; }
    busy(false);
    animDirty = false; animIdx = 0; animPhase = "intact"; ANIM._needNewPlot = true;
    sceneRevealed = true;   // playing growth reveals the substrate + roots
    LAST.intensity = null;
    const bar = $("animBar"); if (bar) bar.classList.remove("hidden");
    const sl = $("anim_timeline"); if (sl) { sl.max = ANIM.T; sl.value = 1; }
  }
  if (animIdx >= ANIM.T - 1) { animIdx = 0; ANIM._needNewPlot = true; }
  startAnim();
}
function startAnim() { animPlaying = true; setPlayBtn(true); if (animTimer) clearInterval(animTimer); animTimer = setInterval(animTick, 110); }
function pauseAnim() { animPlaying = false; setPlayBtn(false); if (animTimer) { clearInterval(animTimer); animTimer = null; } }
function animTick() {
  if (!ANIM) return;
  animIdx += animSpeed;
  if (animIdx >= ANIM.T - 1) { animIdx = ANIM.T - 1; renderAnimFrame(animIdx); pauseAnim(); finishAnim(); return; }
  renderAnimFrame(animIdx);
}
// build a results-sidebar stats object reflecting the state AT a given anim step
function buildAnimStats(idx) {
  const A = ANIM, s = idx + 1, brk = A.breakthrough_step, tl = A.timeline;
  const broken = (brk != null && s >= brk);
  const sites = A.site_labels.map((lab, i) => ({
    label: lab, is_ligament: !!A.is_lig[i],
    activation_step: (A.activation[i] != null && A.activation[i] <= s) ? A.activation[i] : null,
  }));
  let fcStep = Infinity, fcSite = null;
  for (const si of sites) if (si.activation_step != null && si.activation_step < fcStep) { fcStep = si.activation_step; fcSite = si.label; }
  const firstCrack = isFinite(fcStep) ? fcStep : null;
  const order = sites.filter(si => si.activation_step != null)
    .sort((a, b) => a.activation_step - b.activation_step).map(si => si.label);
  const tcAt = (step) => (step == null || !tl[step - 1]) ? { months: null, label: "—" } : { months: tl[step - 1].months, label: tl[step - 1].label };
  return Object.assign({}, A.stats, {
    n_time_steps: A.T,
    breakthrough_step: broken ? brk : null,
    breakthrough_time: broken ? A.stats.breakthrough_time : { months: null, label: "—" },
    first_crack_step: firstCrack, first_crack_site: fcSite, first_crack_time: tcAt(firstCrack),
    sites, activation_order: order,
  });
}
// when "Play growth" finishes: sync the sidebar and auto-reveal the full 4-piece
// split (Exploded view) so all four separations are obvious without rotating
function finishAnim() {
  if (!ANIM) return;
  if (ANIM.frames && ANIM.frames.length) { LAST.intensity = Array.from(ANIM.frames[ANIM.T - 1]); LAST.cmax = ANIM.cmax; }
  renderAnimSidebar(ANIM.T - 1);
  // only auto-reveal the 4-piece split if the pod ACTUALLY broke through; if it
  // never released, keep the final intact frame (don't imply a break that never happened)
  if (ANIM.breakthrough_step == null) return;
  if ($("root_stage")) { $("root_stage").value = 100; const o = $("o_root_stage"); if (o) o.textContent = "100"; }
  rebuildRoots();
  viewMode = "exploded";
  document.querySelectorAll("#viewSeg .segbtn").forEach(b => b.classList.toggle("active", b.dataset.view === "exploded"));
  if (!ENGINE.assetPieces() && !EXPLODED) EXPLODED = ENGINE.exploded();
  render();
}
// sidebar synced to an anim step, with a gentle "in progress" verdict pre-crack
function renderAnimSidebar(idx) {
  const A = ANIM, st = buildAnimStats(idx);
  renderSingle(st);
  if (st.breakthrough_step == null && st.first_crack_step == null) {
    const vd = $("verdict"); if (vd) {
      vd.className = "verdict idle";
      const lab = A.timeline[idx] ? A.timeline[idx].label : "";
      vd.innerHTML = `Growth in progress — <b>${lab}</b>. Wall intact; root pressure building toward the seams.`;
    }
  }
}
function animScrub() {
  if (!ANIM) return;
  pauseAnim();
  animIdx = clamp(Math.round(+$("anim_timeline").value) - 1, 0, ANIM.T - 1);
  renderAnimFrame(animIdx);
}
function setSpeed(s) {
  animSpeed = s;
  document.querySelectorAll("#speedSeg .segbtn").forEach(b => b.classList.toggle("active", +b.dataset.speed === s));
}
function renderAnimFrame(idx) {
  const A = ANIM, T = A.T, tl = A.timeline[idx], look = materialLook(), data = [], sc = stressScale();
  if (BOUNDS_TRACE) data.push(BOUNDS_TRACE);
  // ground does a subtle radial reveal over the first fifth of the timeline as
  // the propagule "lands" and roots start — it isn't there at step 0.
  if (groundOn()) {
    const rv = clamp((idx / T) / 0.20, 0, 1), gReveal = rv * rv * (3 - 2 * rv);
    if (gReveal > 0.03) pushSubstrate(data, gReveal);
  }
  const brk = A.breakthrough_step, exploded = (brk != null && idx >= brk - 1), inten = A.frames[idx];
  if (!exploded) {
    const m = Object.assign({}, podGeom());
    delete m.color; delete m.map; delete m.colorscale; delete m.cmin; delete m.cmax;
    m.intensity = podIntensity(Array.from(inten)); m.colorscale = sc; m.cmin = 0; m.cmax = A.cmax;
    m.showscale = true; m.colorbar = CBAR; m.lighting = look.light; m.lightposition = LIGHT_POS; m.flatshading = false;
    data.push(m);
  } else {
    // breakthrough: the pod releases into the authored 4 pieces, popping outward
    const pop = clamp((idx - (brk - 1)) / POP_FRAMES, 0, 1);
    const gap = pop * PIECE_GAP_FRAC * ENGINE.features().outer_r_waist;
    const P = pieceTraces(gap, look);
    if (P) { for (const t of P) data.push(t); }
    else {   // fallback: procedural sectors (with stress)
      const g2 = pop * POP_GAP_FRAC * ENGINE.features().outer_r_waist; let barSet = false;
      for (const s of A.exploded) {
        const x = s.x.map(v => v + g2 * s.cdx), y = s.y.map(v => v + g2 * s.cdy);
        const t = { type:"mesh3d", x, y, z:s.z, i:s.i, j:s.j, k:s.k, flatshading:false, hoverinfo:"skip", name:"piece",
          lighting:look.light, lightposition:LIGHT_POS };
        t.intensity = s.orig.map(o => inten[o]); t.colorscale = sc; t.cmin = 0; t.cmax = A.cmax;
        t.showscale = !barSet; if (!barSet) { t.colorbar = CBAR; barSet = true; }
        data.push(t);
      }
    }
  }
  // roots stay hidden inside the pod until it breaks through; then thin tips
  // emerge through the opening and extend down into the substrate over the rest
  let emergeFrac = 0;
  if (brk != null && idx >= brk - 1) emergeFrac = clamp((idx - (brk - 1)) / Math.max(T - (brk - 1), 1), 0, 1);
  if (emergeFrac > 0.001 && $("show_roots").checked) {
    const rt = buildRootTrace(ENGINE.stageRoots(emergeFrac)); if (rt) data.push(rt);
  }
  const sh = buildShootTrace(ENGINE.shoot(clamp(idx / (T - 1), 0, 1))); if (sh) data.push(sh);
  const sl = $("anim_timeline"); if (sl) sl.value = idx + 1;
  updateAnimReadout(idx);
  renderAnimSidebar(idx);   // keep the results sidebar synced to the current step
  const phase = exploded ? "exploded" : "intact";
  if (A._needNewPlot || phase !== animPhase) { Plotly.newPlot(plotDiv, data, BASE_LAYOUT, { responsive:true, displaylogo:false }); A._needNewPlot = false; }
  else Plotly.react(plotDiv, data, BASE_LAYOUT, { responsive:true, displaylogo:false });
  animPhase = phase;
}
function updateAnimReadout(idx) {
  const A = ANIM, tl = A.timeline[idx], brk = A.breakthrough_step, el = $("anim_readout");
  if (!el) return;
  let ligCracked = 0, nLig = 0;
  for (let si = 0; si < A.activation.length; si++) if (A.is_lig[si]) { nLig++; if (A.activation[si] != null && A.activation[si] <= idx + 1) ligCracked++; }
  let status;
  if (brk != null && idx + 1 >= brk) status = `<span class="astatus broke">● pod released — 4 pieces</span>`;
  else if (ligCracked > 0) status = `<span class="astatus crack">● ${ligCracked}/${nLig} seams cracked</span>`;
  else status = `<span class="astatus ok">● intact, pressure building</span>`;
  const win = A.window_months, elapsed = tl.months != null ? tl.months.toFixed(1) : "–";
  el.innerHTML = `<span class="abig">${tl.label}</span>` +
    `<span class="amuted"> · ${elapsed} / ${win} mo · step ${idx + 1}/${A.T} · ${A.species_name}</span>` +
    ` &nbsp; ${status}`;
}

// ============================================================================
//  MATERIAL CRACK-ANALYSIS REPORT
// ============================================================================
function openCrackReport() {
  busy(true, "running material crack analysis…");
  compute(() => ENGINE.crackReport(cfg(), Math.max(16, Math.min(40, +$("n_runs").value))))
    .then(r => { busy(false); renderCrackReport(r); $("crackPanel").classList.remove("hidden"); })
    .catch(e => { busy(false); showError("Crack analysis", e); });
}
function renderCrackReport(r) {
  const t = r.text, cur = r.material;
  const cmp = r.compare.map(c => `<tr class="${c.key === cur ? "curmat" : ""}"><td>${c.name}</td><td>${c.strength} MPa</td>` +
    `<td>${c.first_crack_months != null ? c.first_crack_months.toFixed(1) : "—"}</td>` +
    `<td>${c.breakthrough_months != null ? c.breakthrough_months.toFixed(1) : "—"}</td><td>${c.reliability}%</td></tr>`).join("");
  $("crackBody").innerHTML =
    `<div class="crackhead">Crack analysis — <b>${r.material_name}</b> · ${r.n_runs} randomized runs</div>` +
    `<div class="cracksum">${t.summary}</div>` +
    `<h4>Where it cracks first</h4><p>${t.where}</p>` +
    `<h4>Why there</h4><p>${t.why}</p>` +
    `<h4>When</h4><p>${t.when}</p>` +
    `<h4>Consistency</h4><p>${t.consistency}</p>` +
    `<h4>Material comparison</h4><table class="cmptbl"><thead><tr><th>Material</th><th>Strength</th><th>First crack</th><th>Breakthrough</th><th>Reliability</th></tr></thead><tbody>${cmp}</tbody></table>` +
    `<p class="crackfoot">First crack / breakthrough in real elapsed months of the ${r.window_months}-month growth window. Roots self-supporting ≈ month ${r.outplant_months}. Reduced-order surrogate — relative comparison, not FEA.</p>`;
}

// ---- render single-run results ---------------------------------------------
function card(k, v, u) {
  return `<div class="card"><div class="k">${k}</div>
          <div class="v">${v}</div><div class="u">${u||""}</div></div>`;
}
function phys_line(s) {
  const p = s.physical || {};
  return `<span class="chip">${p.material_name||""}</span>` +
         `<span class="chip">${p.species_name||""}</span>` +
         `<span class="chip">${(p.root_pressure_mpa!=null?p.root_pressure_mpa.toFixed(2):"?")} MPa` +
         `${p.calibration_active?" (measured)":" (est.)"}</span>` +
         (p.salinity_ppt!=null?`<span class="chip">${p.salinity_ppt} ppt</span>`:"");
}
function timeStrip(s) {
  const t = s.breakthrough_time, w = s.window_time, el = $("timeline");
  if (!t || t.label === "—") { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `<span class="tclock">Breaks at <b>${t.label}</b></span>` +
    `<span class="tsub">of a ${w? w.label : ""} window · ${phys_line(s)}</span>`;
}
function renderSingle(s) {
  const N = s.n_time_steps, bt = s.breakthrough_step, fc = s.first_crack_step;
  const bm = s.breakthrough_time, fm = s.first_crack_time, vd = $("verdict");
  if (bt != null) {
    vd.className = "verdict broke";
    vd.innerHTML = `Pod <b>breaks at step ${bt}</b> of ${N}` +
      (bm && bm.months!=null ? ` — <b>${bm.label}</b>` : "") +
      `, releasing along the seam / slot→foot ligaments.`;
  } else if (fc != null) {
    vd.className = "verdict nobreak";
    vd.innerHTML = `Cracks start at step ${fc}` +
      (fm && fm.months!=null ? ` (${fm.label})` : "") + ` but <b>no full breakthrough</b> within ${N} steps.`;
  } else {
    vd.className = "verdict nobreak";
    vd.innerHTML = `No wall failure within ${N} steps — roots never overcome the wall.`;
  }
  timeStrip(s);
  $("statcards").innerHTML =
    card("Breakthrough", bt ?? "—", bt!=null?(bm&&bm.months!=null?bm.label:`of ${N}`):"no break") +
    card("First crack", fc ?? "—", s.first_crack_site || "") +
    card("Root nodes", s.n_nodes, "grown") +
    card("Pattern", s.slots.length + " slots", s.pattern);

  const labels = s.sites.map(x => x.label);
  const steps = s.sites.map(x => x.activation_step == null ? N : x.activation_step);
  const colors = s.sites.map(x => x.activation_step == null ? "#5f5a51" : (x.is_ligament ? "#dd6350" : "#6d90bf"));
  Plotly.react($("siteChart"), [{
    type:"bar", orientation:"h", x:steps, y:labels, marker:{ color:colors },
    text: s.sites.map(x => x.activation_step == null ? "—" : "t"+x.activation_step),
    textposition:"auto", hoverinfo:"y+x",
  }], themeBar("activation step (→ later)"), { displaylogo:false, responsive:true });

  const order = s.activation_order.length
    ? s.activation_order.map((l,i)=>`<span class="chip ${l.startsWith('slot')?'lig':'split'}">${i+1}. ${l}</span>`).join("")
    : "<span class='chip'>none</span>";
  $("detail").innerHTML = `<h3>Activation order</h3><div class="chips">${order}</div>`;
  renderProvMini();
}

// ---- render Monte-Carlo results --------------------------------------------
function renderMC(s) {
  const N = s.n_time_steps, rel = Math.round(s.reliability * 100), bm = s.breakthrough_time, vd = $("verdict");
  vd.className = "verdict " + (rel >= 80 ? "broke" : "nobreak");
  vd.innerHTML = `Breaks in <b>${rel}% of ${s.n_runs} runs</b>` +
    (s.mean_breakthrough!=null ? ` — mean breakthrough <b>step ${s.mean_breakthrough.toFixed(1)}</b>` +
      (bm && bm.months!=null ? ` (${bm.label})` : "") + ` ± ${(s.std_breakthrough||0).toFixed(1)}.` : ".");
  timeStrip(s);
  $("statcards").innerHTML =
    card("Reliability", rel + "%", `${s.n_runs} runs`) +
    card("Breakthrough", s.mean_breakthrough!=null? s.mean_breakthrough.toFixed(1):"—",
         bm&&bm.months!=null? bm.label : `mean ± ${(s.std_breakthrough||0).toFixed(1)}`) +
    card("First crack", s.mean_first_crack!=null? s.mean_first_crack.toFixed(1):"—", "mean step") +
    card("Pattern", s.pattern, "");

  const labels = Object.keys(s.site_activation_rate);
  const rates = labels.map(l => s.site_activation_rate[l]*100);
  const colors = labels.map(l => l.startsWith("slot") ? "#dd6350" : "#6d90bf");
  Plotly.react($("siteChart"), [{
    type:"bar", orientation:"h", x:rates, y:labels, marker:{color:colors},
    text: labels.map(l => { const t=s.mean_site_activation_step[l]; return t!=null? "t"+t.toFixed(0):""; }),
    textposition:"auto", hoverinfo:"y+x",
  }], themeBar("activation rate (%)", [0,100]), {displaylogo:false, responsive:true});

  const fs = Object.entries(s.first_site_counts).map(([k,v])=>`<span class="chip lig">${k}: ${v}</span>`).join("") || "—";
  const orders = s.top_orders.map(([o,c])=>`<tr><td class="ord">${o}</td><td>${c}×</td></tr>`).join("");
  $("detail").innerHTML =
    `<h3>First site to crack</h3><div class="chips">${fs}</div>` +
    `<h3>Most common activation orders</h3><table>${orders}</table>`;
  renderProvMini();
}
function themeBar(xtitle, xrange) {
  return { paper_bgcolor:"rgba(0,0,0,0)", plot_bgcolor:"rgba(0,0,0,0)",
    font:{color:"#bdb7ab", size:11}, margin:{l:96,r:14,t:6,b:34}, height:210,
    xaxis:{title:{text:xtitle,font:{size:11}}, gridcolor:"rgba(255,255,255,0.09)", range:xrange, zeroline:false},
    yaxis:{automargin:true}, bargap:0.28 };
}

// ---- data provenance panel --------------------------------------------------
let LAST_PROV = null;
$("provBtn").addEventListener("click", openProv);
$("provClose").addEventListener("click", () => $("provPanel").classList.add("hidden"));
function openProv() {
  try { LAST_PROV = ENGINE.provenance(cfg()); renderProv(LAST_PROV); renderProvMini(); }
  catch(e){ console.error("provenance", e); }
  $("provPanel").classList.remove("hidden");
}
function renderProv(reg) {
  $("provRoadmap").innerHTML = `<b>Validation roadmap.</b> ${reg.validation_roadmap}`;
  const lv = reg.levels;
  $("provCounts").innerHTML = Object.entries(reg.counts).map(([k,v]) =>
    `<span class="lvchip" style="border-color:${lv[k].color};color:${lv[k].color}">${lv[k].label}: ${v}</span>`).join("");
  const groups = {};
  reg.constants.forEach(c => { (groups[c.group] ||= []).push(c); });
  let html = "";
  for (const g of Object.keys(groups)) {
    html += `<h4>${g}</h4><table class="provtbl">`;
    for (const c of groups[g]) {
      html += `<tr><td class="pn">${c.label}</td>` +
        `<td class="pv">${c.value}${c.unit? " "+c.unit : ""}</td>` +
        `<td><span class="lvtag" style="background:${c.level_color}22;border-color:${c.level_color};color:${c.level_color}">${c.level_label}</span></td></tr>` +
        `<tr class="pcite"><td colspan="3"><b>Source:</b> ${c.citation||"—"}` + (c.note? ` &nbsp;·&nbsp; ${c.note}`:"") + `</td></tr>`;
    }
    html += `</table>`;
  }
  $("provTable").innerHTML = html;
}
function renderProvMini() {
  if (!LAST_PROV) { $("provMini").innerHTML =
    `<button class="linklike" onclick="openProv()">Open data provenance — see what's proven vs. assumed</button>`; return; }
  const lv = LAST_PROV.levels, c = LAST_PROV.counts;
  const chips = Object.entries(c).map(([k,v]) =>
    `<span class="lvchip sm" style="border-color:${lv[k].color};color:${lv[k].color}">${v} ${lv[k].label.split(" ")[0]}</span>`).join("");
  $("provMini").innerHTML =
    `<h3>Data provenance</h3><div class="chips">${chips}</div>` +
    `<button class="linklike" onclick="openProv()">open full provenance panel →</button>`;
}

// ---- init -------------------------------------------------------------------
async function init() {
  syncOutputs();
  applyPreset();
  renderCalib();
  try {
    await ENGINE.loadPod();
  } catch (e) {
    $("bootmsg").innerHTML = "Could not load the pod geometry (data/pod.js).<br>" + e.message;
    return;
  }
  try {
    UIMATS = ENGINE.materials().materials;
    UISPS = ENGINE.species().species;
    renderMaterial(); renderSpecies(); renderProvMini();
    const f = ENGINE.features();
    $("podinfo").textContent =
      `${f.n_slots} break slots · ${f.n_feet} feet · scanned from the physical pod geometry`;
    document.querySelectorAll("#viewSeg .segbtn").forEach(b =>
      b.addEventListener("click", () => setView(b.dataset.view)));
    ["show_roots","show_prop","show_stress","show_ground"].forEach(id => { const el = $(id); if (el) el.addEventListener("change", render); });
    $("material").addEventListener("change", render);   // repaint pod in the new material finish
    if ($("root_stage")) $("root_stage").addEventListener("input", () => { rebuildRoots(); render(); });
    // growth-animation + report wiring
    if ($("playBtn")) $("playBtn").addEventListener("click", playGrowth);
    if ($("anim_timeline")) $("anim_timeline").addEventListener("input", animScrub);
    document.querySelectorAll("#speedSeg .segbtn").forEach(b => b.addEventListener("click", () => setSpeed(+b.dataset.speed)));
    if ($("crackBtn")) $("crackBtn").addEventListener("click", openCrackReport);
    if ($("crackClose")) $("crackClose").addEventListener("click", () => $("crackPanel").classList.add("hidden"));
    // any change to the design/species/material controls invalidates a cached animation
    if ($("controls")) $("controls").addEventListener("input", () => { animDirty = true; });
    BASE_MESH = ENGINE.baseMesh();
    VIZ_MESH = ENGINE.vizPod();     // high-res visual pod (render-only); null if not loaded
    BASE_LAYOUT = baseLayout();
    BOUNDS_TRACE = buildBounds();   // stable camera frame (pod + eventual ground/roots)
    SEAM_TRACE = buildSeamTrace(ENGINE.seams());
    PROP_TRACE = buildPropTrace(ENGINE.propagule());
    LANDINGS = ENGINE.rootLandings();   // root-contact points for the mud mounds/AO + cast shadow
    GROUND_TRACE = buildGroundTrace(ENGINE.ground(44, 170, 1, groundOpts()));
    WATER_TRACE = buildWaterTrace(ENGINE.water(26, 120, 1, groundOpts()));
    DEBRIS_TRACE = buildDebrisTrace(ENGINE.debris(groundOpts()));
    rebuildRoots();     // prepared, but hidden until a run reveals the scene
    render();
    $("boot").classList.add("hidden");
  } catch (e) {
    $("bootmsg").innerHTML = "Init error: " + e.message + "<br><small>" + ((e.stack||"").split("\n").slice(0,3).join("<br>")) + "</small>";
  }
}
init();
