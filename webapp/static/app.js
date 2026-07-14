"use strict";
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
// ids applyPreset writes (all pattern/seam knobs)
const WRITE_IDS = ["n_slots","slot_length_frac","slot_width_deg","slot_z_center_frac",
                   "split_score","seam_score","seam_width_deg","theta_offset_deg"];
// ids that, when the user drags them, switch the preset to "custom"
// (seam depth/width are intentionally excluded: they apply to ANY pattern,
//  including the detected as-drawn one, so they should not force parametric mode)
const TRIGGER_IDS = ["n_slots","slot_length_frac","slot_width_deg","slot_z_center_frac",
                     "split_score","theta_offset_deg"];

let MATERIALS = {}, SPECIES = {};

// ---- slider <-> output sync -------------------------------------------------
function syncOutputs() {
  document.querySelectorAll("input[type=range]").forEach(r => {
    const o = $("o_" + r.id);
    if (o) o.textContent = r.value;
  });
}
document.querySelectorAll("input[type=range]").forEach(r =>
  r.addEventListener("input", () => { const o=$("o_"+r.id); if(o) o.textContent = r.value; }));

// changing a perforation slider -> switch to "custom"
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
  const m = MATERIALS[$("material").value];
  if (!m) return;
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
  const s = SPECIES[$("species").value];
  if (!s) return;
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
    const mpa = f / a;
    out.innerHTML = `→ <b>${mpa.toFixed(2)} MPa</b> ` +
      `<span class="tag meas">MEASURED — overrides the estimate</span>`;
  } else if (on) {
    out.textContent = "enter force (N) and contact area (mm²) to compute MPa";
  } else {
    out.textContent = "using the estimated root pressure above";
  }
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
    project_outer: $("project_outer").checked,
  };
  return Object.assign(c, extra || {});
}

// ---- render state -----------------------------------------------------------
// 4-stop calm -> warning -> critical stress scale (clear at a glance)
const STRESS_SCALE = [[0.0,"#2f6f5e"],[0.35,"#e9c46a"],[0.7,"#e76f51"],[1.0,"#c1121f"]];
const SEAM_COLOR = "#f2c14e";     // gold seam lines
const ROOT_COLOR = "#6b4525";     // woody brown roots
const PIECE_COLOR = "#c7b291";    // neutral pod colour for exploded pieces
const ROOT_LIGHT = { ambient:0.5, diffuse:0.85, specular:0.15, roughness:0.75 };
const MESH_LIGHT = { ambient:0.42, diffuse:0.9, specular:0.18, roughness:0.55, fresnel:0.15 };
const LIGHT_POS  = { x:180, y:260, z:520 };

let BASE_MESH = null, BASE_LAYOUT = null, SEAM_TRACE = null, EXPLODED = null;
let LAST = { intensity: null, cmax: 1, roots: null };
let viewMode = "intact";

function themeLayout(layout) {
  layout = layout || {};
  layout.paper_bgcolor = "rgba(0,0,0,0)";
  layout.plot_bgcolor = "rgba(0,0,0,0)";
  layout.font = { color: "#c9d4de", size: 12 };
  layout.margin = { l: 0, r: 0, t: 20, b: 0 };
  const ax = { visible: false, showbackground: false, showgrid: false,
               zeroline: false, showspikes: false };
  layout.scene = Object.assign({
    xaxis: ax, yaxis: ax, zaxis: { ...ax },
    bgcolor: "rgba(0,0,0,0)", aspectmode: "data",
    camera: { eye: { x: 1.5, y: 1.5, z: 0.9 } },
    uirevision: "keep",
  }, layout.scene || {});
  layout.title = "";
  return layout;
}

function buildSeamTrace(g) {
  if (!g) return null;
  return { type:"mesh3d", x:g.x, y:g.y, z:g.z, i:g.i, j:g.j, k:g.k,
    color: SEAM_COLOR, flatshading:false, hoverinfo:"skip", name:"seams",
    lighting:{ ambient:0.55, diffuse:0.75, specular:0.5, roughness:0.4 },
    lightposition: LIGHT_POS };
}
function buildRootTrace(g) {
  if (!g) return null;
  return { type:"mesh3d", x:g.x, y:g.y, z:g.z, i:g.i, j:g.j, k:g.k,
    color: ROOT_COLOR, flatshading:false, hoverinfo:"skip", name:"roots",
    lighting: ROOT_LIGHT, lightposition: LIGHT_POS };
}

// build the full trace list for the current view + colouring, then react
function render() {
  if (!BASE_MESH) return;
  const data = [];
  if (viewMode === "exploded" && EXPLODED) {
    for (const s of EXPLODED) {
      const t = { type:"mesh3d", x:s.x, y:s.y, z:s.z, i:s.i, j:s.j, k:s.k,
        flatshading:false, hoverinfo:"skip", name:"piece",
        lighting: MESH_LIGHT, lightposition: LIGHT_POS };
      if (LAST.intensity) {
        t.intensity = s.orig.map(o => LAST.intensity[o]);
        t.colorscale = STRESS_SCALE; t.cmin = 0; t.cmax = LAST.cmax;
        t.showscale = (data.length === 0);
      } else { t.color = PIECE_COLOR; }
      data.push(t);
    }
  } else {
    const m = Object.assign({}, BASE_MESH);
    m.lighting = MESH_LIGHT; m.lightposition = LIGHT_POS; m.flatshading = false;
    if (LAST.intensity) {
      m.intensity = LAST.intensity; m.colorscale = STRESS_SCALE;
      m.cmin = 0; m.cmax = LAST.cmax; m.showscale = true;
    }
    data.push(m);
    if ($("show_seams").checked && SEAM_TRACE) data.push(SEAM_TRACE);
    if ($("show_roots").checked && LAST.roots) data.push(LAST.roots);
  }
  Plotly.react(plotDiv, data, BASE_LAYOUT, { responsive:true, displaylogo:false });
}

// called after a simulation: store field + root tubes, then re-render
function updateStress(intensity, cmax, roots) {
  LAST.intensity = intensity; LAST.cmax = cmax;
  if (roots) LAST.roots = buildRootTrace(roots);
  render();
}

async function ensureExploded() {
  if (EXPLODED) return;
  const r = await (await fetch("/api/exploded")).json();
  EXPLODED = r.sectors;
}
function setView(v) {
  viewMode = v;
  document.querySelectorAll("#viewSeg .segbtn")
    .forEach(b => b.classList.toggle("active", b.dataset.view === v));
  if (v === "exploded") {
    busy(true, "building exploded view…");
    ensureExploded().then(() => { busy(false); render(); })
      .catch(e => { busy(false); alert("Exploded view failed:\n" + e.message); });
  } else { render(); }
}

// ---- overlay / spinner ------------------------------------------------------
function busy(on, msg) {
  $("overlay").classList.toggle("hidden", !on);
  if (msg) $("overlayMsg").textContent = msg;
  $("runBtn").disabled = on; $("mcBtn").disabled = on;
}

// ---- API calls --------------------------------------------------------------
async function post(url, body) {
  const r = await fetch(url, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function runSim() {
  busy(true, "growing roots & pressurising wall…");
  try {
    const { intensity, cmax, roots, stats } = await post("/api/simulate", cfg());
    updateStress(intensity, cmax, roots);
    renderSingle(stats);
  } catch (e) { alert("Simulation failed:\n" + e.message); }
  finally { busy(false); }
}

async function runMC() {
  const n = +$("n_runs").value;
  busy(true, `running ${n} randomized simulations…`);
  try {
    const { intensity, cmax, roots, stats } = await post("/api/montecarlo", cfg({ n_runs: n }));
    updateStress(intensity, cmax, roots);
    renderMC(stats);
  } catch (e) { alert("Monte Carlo failed:\n" + e.message); }
  finally { busy(false); }
}
$("runBtn").addEventListener("click", runSim);
$("mcBtn").addEventListener("click", runMC);

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
  const t = s.breakthrough_time, w = s.window_time;
  const el = $("timeline");
  if (!t || t.label === "—") { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `<span class="tclock">⏱ breaks at <b>${t.label}</b></span>` +
    `<span class="tsub">of a ${w? w.label : ""} window · ${phys_line(s)}</span>`;
}
function renderSingle(s) {
  const N = s.n_time_steps, bt = s.breakthrough_step, fc = s.first_crack_step;
  const bm = s.breakthrough_time, fm = s.first_crack_time;
  const vd = $("verdict");
  if (bt != null) {
    vd.className = "verdict broke";
    vd.innerHTML = `✔ Pod <b>breaks at step ${bt}</b> of ${N}` +
      (bm && bm.months!=null ? ` — <b>${bm.label}</b>` : "") +
      `, releasing along the seam / slot→foot ligaments.`;
  } else if (fc != null) {
    vd.className = "verdict nobreak";
    vd.innerHTML = `⚠ Cracks start at step ${fc}` +
      (fm && fm.months!=null ? ` (~${fm.label})` : "") +
      ` but <b>no full breakthrough</b> within ${N} steps.`;
  } else {
    vd.className = "verdict nobreak";
    vd.innerHTML = `✖ No wall failure within ${N} steps — roots never overcome the wall.`;
  }
  timeStrip(s);
  $("statcards").innerHTML =
    card("Breakthrough", bt ?? "—", bt!=null?(bm&&bm.months!=null?bm.label:`of ${N}`):"no break") +
    card("First crack", fc ?? "—", s.first_crack_site || "") +
    card("Root nodes", s.n_nodes, "grown") +
    card("Pattern", s.slots.length + " slots", s.pattern);

  const labels = s.sites.map(x => x.label);
  const steps = s.sites.map(x => x.activation_step == null ? N : x.activation_step);
  const colors = s.sites.map(x => x.activation_step == null ? "#3a4550"
                                 : (x.is_ligament ? "#d6564a" : "#5a8fce"));
  Plotly.react($("siteChart"), [{
    type: "bar", orientation: "h", x: steps, y: labels,
    marker: { color: colors },
    text: s.sites.map(x => x.activation_step == null ? "—" : "t"+x.activation_step),
    textposition: "auto", hoverinfo: "y+x",
  }], themeBar("activation step (→ later)"), { displaylogo:false, responsive:true });

  const order = s.activation_order.length
    ? s.activation_order.map((l,i)=>`<span class="chip ${l.startsWith('slot')?'lig':'split'}">${i+1}. ${l}</span>`).join("")
    : "<span class='chip'>none</span>";
  $("detail").innerHTML = `<h3>Activation order</h3><div class="chips">${order}</div>`;
  renderProvMini();
}

// ---- render Monte-Carlo results --------------------------------------------
function renderMC(s) {
  const N = s.n_time_steps;
  const rel = Math.round(s.reliability * 100);
  const bm = s.breakthrough_time;
  const vd = $("verdict");
  vd.className = "verdict " + (rel >= 80 ? "broke" : "nobreak");
  vd.innerHTML = `${rel>=80?"✔":"⚠"} Breaks in <b>${rel}% of ${s.n_runs} runs</b>` +
    (s.mean_breakthrough!=null ? ` — mean breakthrough <b>step ${s.mean_breakthrough.toFixed(1)}</b>` +
      (bm && bm.months!=null ? ` (~${bm.label})` : "") +
      ` ± ${(s.std_breakthrough||0).toFixed(1)}.` : ".");
  timeStrip(s);
  $("statcards").innerHTML =
    card("Reliability", rel + "%", `${s.n_runs} runs`) +
    card("Breakthrough", s.mean_breakthrough!=null? s.mean_breakthrough.toFixed(1):"—",
         bm&&bm.months!=null? bm.label : `mean ± ${(s.std_breakthrough||0).toFixed(1)}`) +
    card("First crack", s.mean_first_crack!=null? s.mean_first_crack.toFixed(1):"—", "mean step") +
    card("Pattern", s.pattern, "");

  const labels = Object.keys(s.site_activation_rate);
  const rates = labels.map(l => s.site_activation_rate[l]*100);
  const colors = labels.map(l => l.startsWith("slot") ? "#d6564a" : "#5a8fce");
  Plotly.react($("siteChart"), [{
    type:"bar", orientation:"h", x:rates, y:labels, marker:{color:colors},
    text: labels.map(l => { const t=s.mean_site_activation_step[l];
                            return t!=null? "t"+t.toFixed(0):""; }),
    textposition:"auto", hoverinfo:"y+x",
  }], themeBar("activation rate (%)", [0,100]), {displaylogo:false, responsive:true});

  const fs = Object.entries(s.first_site_counts)
    .map(([k,v])=>`<span class="chip lig">${k}: ${v}</span>`).join("") || "—";
  const orders = s.top_orders.map(([o,c])=>`<tr><td class="ord">${o}</td><td>${c}×</td></tr>`).join("");
  $("detail").innerHTML =
    `<h3>First site to crack</h3><div class="chips">${fs}</div>` +
    `<h3>Most common activation orders</h3><table>${orders}</table>`;
  renderProvMini();
}

function themeBar(xtitle, xrange) {
  return { paper_bgcolor:"rgba(0,0,0,0)", plot_bgcolor:"rgba(0,0,0,0)",
    font:{color:"#c9d4de", size:11}, margin:{l:96,r:14,t:6,b:34}, height:210,
    xaxis:{title:{text:xtitle,font:{size:11}}, gridcolor:"#2f3945",
           range:xrange, zeroline:false},
    yaxis:{automargin:true}, bargap:0.28 };
}

// ---- data provenance panel --------------------------------------------------
let LAST_PROV = null;
$("provBtn").addEventListener("click", openProv);
$("provClose").addEventListener("click", () => $("provPanel").classList.add("hidden"));
async function openProv() {
  try {
    const reg = await post("/api/provenance", cfg());
    LAST_PROV = reg;
    renderProv(reg);
    renderProvMini();
  } catch(e){ alert("Could not load provenance:\n"+e.message); }
  $("provPanel").classList.remove("hidden");
}
function renderProv(reg) {
  $("provRoadmap").innerHTML = `<b>Validation roadmap.</b> ${reg.validation_roadmap}`;
  const lv = reg.levels;
  $("provCounts").innerHTML = Object.entries(reg.counts).map(([k,v]) =>
    `<span class="lvchip" style="border-color:${lv[k].color};color:${lv[k].color}">` +
    `${lv[k].label}: ${v}</span>`).join("");
  // group constants
  const groups = {};
  reg.constants.forEach(c => { (groups[c.group] ||= []).push(c); });
  let html = "";
  for (const g of Object.keys(groups)) {
    html += `<h4>${g}</h4><table class="provtbl">`;
    for (const c of groups[g]) {
      html += `<tr><td class="pn">${c.label}</td>` +
        `<td class="pv">${c.value}${c.unit? " "+c.unit : ""}</td>` +
        `<td><span class="lvtag" style="background:${c.level_color}22;` +
        `border-color:${c.level_color};color:${c.level_color}">${c.level_label}</span></td>` +
        `</tr>` +
        `<tr class="pcite"><td colspan="3"><b>Source:</b> ${c.citation||"—"}` +
        (c.note? ` &nbsp;·&nbsp; ${c.note}`:"") + `</td></tr>`;
    }
    html += `</table>`;
  }
  $("provTable").innerHTML = html;
}
function renderProvMini() {
  if (!LAST_PROV) { $("provMini").innerHTML =
    `<button class="linklike" onclick="openProv()">🔬 Open data provenance — see what's proven vs. assumed</button>`;
    return; }
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
    const m = await (await fetch("/api/materials")).json();
    MATERIALS = m.materials;
    const s = await (await fetch("/api/species")).json();
    SPECIES = s.species;
    renderMaterial(); renderSpecies();
  } catch(e){ console.error("materials/species load failed", e); }
  renderProvMini();
  try {
    const f = await (await fetch("/api/features")).json();
    $("podinfo").textContent =
      `${f.n_faces.toLocaleString()} triangles · ${f.n_slots} waist slots · ${f.n_feet} feet · ` +
      `waist R≈${f.outer_r_waist.toFixed(0)} · wall≈${f.wall_thickness.toFixed(0)}`;
  } catch(e){ $("podinfo").textContent = "pod loaded"; }
  // view-mode segmented control + display toggles
  document.querySelectorAll("#viewSeg .segbtn").forEach(b =>
    b.addEventListener("click", () => setView(b.dataset.view)));
  ["show_seams","show_roots"].forEach(id =>
    $(id).addEventListener("change", render));
  try {
    const fig = await (await fetch("/api/base_figure")).json();
    BASE_MESH = fig.data[0];
    BASE_LAYOUT = themeLayout(fig.layout || {});
    const sm = await (await fetch("/api/seams")).json();
    SEAM_TRACE = buildSeamTrace(sm.seams);
    render();
  } catch(e){ console.error(e); }
}
init();
