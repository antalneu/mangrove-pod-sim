"use strict";
const $ = (id) => document.getElementById(id);
const plotDiv = $("plot");

// ---- parameter defaults & presets ------------------------------------------
const DEFAULTS = {
  n_slots: 4, slot_length_frac: 0.22, slot_width_deg: 15,
  slot_z_center_frac: 0.55, align: "feet", split_score: 0.35,
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
};
const PARAM_IDS = ["n_slots","slot_length_frac","slot_width_deg",
                   "slot_z_center_frac","split_score"];

// ---- slider <-> output sync -------------------------------------------------
function syncOutputs() {
  document.querySelectorAll("input[type=range]").forEach(r => {
    const o = $("o_" + r.id);
    if (o) o.textContent = r.value;
  });
}
document.querySelectorAll("input[type=range]").forEach(r =>
  r.addEventListener("input", () => { $("o_"+r.id).textContent = r.value; }));

// changing a perforation slider -> switch to "custom"
PARAM_IDS.concat(["align"]).forEach(id =>
  $(id).addEventListener("input", () => { $("preset").value = "custom"; }));

$("preset").addEventListener("change", applyPreset);
function applyPreset() {
  const name = $("preset").value;
  if (name === "custom") { setParamBox(true); return; }
  const p = { ...DEFAULTS, ...(PRESETS[name] || {}) };
  for (const k of PARAM_IDS) if ($(k)) $(k).value = p[k];
  $("align").value = p.align;
  setParamBox(name !== "as-drawn");
  syncOutputs();
}
function setParamBox(enabled) {
  $("paramBox").style.opacity = enabled ? "1" : "0.4";
  $("paramBox").style.pointerEvents = enabled ? "auto" : "none";
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

// ---- Plotly theming ---------------------------------------------------------
function themeLayout(layout) {
  layout = layout || {};
  layout.paper_bgcolor = "rgba(0,0,0,0)";
  layout.plot_bgcolor = "rgba(0,0,0,0)";
  layout.font = { color: "#c9d4de", size: 12 };
  layout.margin = { l: 0, r: 0, t: 34, b: 0 };
  const ax = { visible: false, showbackground: false, showgrid: false,
               zeroline: false, showspikes: false };
  layout.scene = Object.assign({
    xaxis: ax, yaxis: ax, zaxis: { ...ax },
    bgcolor: "rgba(0,0,0,0)", aspectmode: "data",
    uirevision: "keep",  // preserve camera across updates
  }, layout.scene || {});
  if (layout.title) layout.title = { text: (layout.title.text || layout.title),
                                     font: { color: "#e7edf3", size: 15 } };
  return layout;
}
function drawFigure(fig) {
  Plotly.react(plotDiv, fig.data, themeLayout(fig.layout),
               { responsive: true, displaylogo: false });
}

// update just the stress colouring + root overlay on the already-drawn mesh
// (keeps the mesh geometry & camera; tiny payloads)
function updateStress(intensity, cmax, roots) {
  Plotly.restyle(plotDiv, {
    intensity: [intensity], cmin: [0], cmax: [cmax],
    colorscale: ["Inferno"], showscale: [true],
  }, [0]);
  const extra = [];
  for (let i = 1; i < plotDiv.data.length; i++) extra.push(i);
  if (extra.length) Plotly.deleteTraces(plotDiv, extra);
  if (roots) {
    Plotly.addTraces(plotDiv, {
      type: "scatter3d", mode: "lines", x: roots.x, y: roots.y, z: roots.z,
      line: { color: "#c98a3a", width: 2 }, hoverinfo: "skip", name: "roots",
    });
  }
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
function renderSingle(s) {
  const N = s.n_time_steps, bt = s.breakthrough_step, fc = s.first_crack_step;
  const vd = $("verdict");
  if (bt != null) {
    vd.className = "verdict broke";
    vd.innerHTML = `✔ Pod <b>breaks at step ${bt}</b> of ${N} — releases along the ` +
      `slot→foot ligaments.`;
  } else if (fc != null) {
    vd.className = "verdict nobreak";
    vd.innerHTML = `⚠ Cracks start at step ${fc} but <b>no full breakthrough</b> ` +
      `within ${N} steps.`;
  } else {
    vd.className = "verdict nobreak";
    vd.innerHTML = `✖ No wall failure within ${N} steps — roots never overcome the wall.`;
  }
  $("statcards").innerHTML =
    card("Breakthrough", bt ?? "—", bt!=null?`of ${N} steps`:"no break") +
    card("First crack", fc ?? "—", s.first_crack_site || "") +
    card("Root nodes", s.n_nodes, "grown") +
    card("Pattern", s.slots.length + " slots", s.pattern);

  // per-site activation-step bar chart
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
}

// ---- render Monte-Carlo results --------------------------------------------
function renderMC(s) {
  const N = s.n_time_steps;
  const rel = Math.round(s.reliability * 100);
  const vd = $("verdict");
  vd.className = "verdict " + (rel >= 80 ? "broke" : "nobreak");
  vd.innerHTML = `${rel>=80?"✔":"⚠"} Breaks in <b>${rel}% of ${s.n_runs} runs</b>` +
    (s.mean_breakthrough!=null ? ` — mean breakthrough <b>step ${s.mean_breakthrough.toFixed(1)}</b>` +
      ` ± ${(s.std_breakthrough||0).toFixed(1)}.` : ".");
  $("statcards").innerHTML =
    card("Reliability", rel + "%", `${s.n_runs} runs`) +
    card("Breakthrough", s.mean_breakthrough!=null? s.mean_breakthrough.toFixed(1):"—",
         `mean ± ${(s.std_breakthrough||0).toFixed(1)}`) +
    card("First crack", s.mean_first_crack!=null? s.mean_first_crack.toFixed(1):"—", "mean step") +
    card("Pattern", s.pattern, "");

  // per-site activation-rate bar
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
}

function themeBar(xtitle, xrange) {
  return { paper_bgcolor:"rgba(0,0,0,0)", plot_bgcolor:"rgba(0,0,0,0)",
    font:{color:"#c9d4de", size:11}, margin:{l:96,r:14,t:6,b:34}, height:210,
    xaxis:{title:{text:xtitle,font:{size:11}}, gridcolor:"#2f3945",
           range:xrange, zeroline:false},
    yaxis:{automargin:true}, bargap:0.28 };
}

// ---- init -------------------------------------------------------------------
async function init() {
  syncOutputs();
  applyPreset();
  try {
    const f = await (await fetch("/api/features")).json();
    $("podinfo").textContent =
      `${f.n_faces.toLocaleString()} triangles · ${f.n_slots} waist slots · ${f.n_feet} feet · ` +
      `waist R≈${f.outer_r_waist.toFixed(0)} · wall≈${f.wall_thickness.toFixed(0)}`;
  } catch(e){ $("podinfo").textContent = "pod loaded"; }
  try {
    const fig = await (await fetch("/api/base_figure")).json();
    drawFigure(fig);
  } catch(e){ console.error(e); }
}
init();
