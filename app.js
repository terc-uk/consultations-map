/* Local plan consultations map
 * Reads data/plans.json and data/lpas.geojson (built by scripts/fetch_data.py)
 * and works out what is open or coming up using today's date in the browser,
 * so statuses stay current between data refreshes.
 */
(function () {
  "use strict";

  const SOON_DAYS = 183;        // "opens within 6 months"
  const RECENT_DAYS = 365;      // "closed in last 12 months"
  const LIST_AHEAD_DAYS = 365;  // list upcoming consultations a year ahead
  const DEFAULT_LENGTH_DAYS = 42; // assumed length when no closing date is published

  const COLOURS = {
    open: "#d9480f", soon: "#f59f00", later: "#ffd96a",
    recent: "#7c93b3", data: "#d5dbe1", none: "#ffffff",
  };
  const RANK = { open: 5, soon: 4, later: 3, recent: 2, data: 1, none: 0 };

  const today = startOfDay(new Date());
  let plans = {}, lpaLayer, layersByCode = {}, includePredicted = true, query = "";

  // ---------------------------------------------------------------- utils
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function parse(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : null; }

  function fmt(iso, precision) {
    const d = parse(iso);
    if (!d) return "date not given";
    if (precision === "year") return String(d.getFullYear());
    if (precision === "month") return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  // ------------------------------------------------------ consultation status
  function windowStatus(w) {
    if (w.predicted && !includePredicted) return null;
    const start = parse(w.start);
    let end = parse(w.end);
    const assumedEnd = !end && start;
    if (!end && start) end = addDays(start, DEFAULT_LENGTH_DAYS);
    if (!start && end) {
      // only a closing date
      if (end < today) return daysBetween(end, today) <= RECENT_DAYS ? { s: "recent", end, start: null } : null;
      return { s: "open", start: null, end, assumedEnd: false };
    }
    if (!start) return null;
    let s;
    if (today < start) s = daysBetween(today, start) <= SOON_DAYS ? "soon" : "later";
    else if (today <= end) s = "open";
    else if (daysBetween(end, today) <= RECENT_DAYS) s = "recent";
    else s = "past";
    return { s, start, end, assumedEnd };
  }

  function planStatus(plan) {
    let best = plan.events && plan.events.length ? "data" : "none";
    for (const w of plan.consultations || []) {
      const st = windowStatus(w);
      if (st && RANK[st.s] > RANK[best]) best = st.s;
    }
    return best;
  }

  function lpaStatus(feature) {
    let best = feature.properties.plans.length ? "data" : "none";
    for (const ref of feature.properties.plans) {
      const p = plans[ref];
      if (!p) continue;
      const s = planStatus(p);
      if (RANK[s] > RANK[best]) best = s;
    }
    return best;
  }

  function lpaNames(plan) {
    return (plan.lpas || [])
      .map(c => layersByCode[c] && layersByCode[c].feature.properties.name)
      .filter(Boolean);
  }

  function matches(plan) {
    if (!query) return true;
    const hay = [plan.name, plan.reference, ...lpaNames(plan)].join(" ").toLowerCase();
    return hay.includes(query);
  }

  // ---------------------------------------------------------------- map
  const map = L.map("map", { zoomSnap: 0.5, minZoom: 5 }).setView([52.8, -1.6], 6.5);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  function style(feature) {
    const s = lpaStatus(feature);
    return {
      color: "#5b6672", weight: 0.6, opacity: 0.8,
      fillColor: COLOURS[s], fillOpacity: s === "none" ? 0.15 : 0.6,
    };
  }

  function windowLine(w) {
    const st = windowStatus(w);
    if (!st && w.predicted && !includePredicted) return "";
    const badge = st && st.s !== "past" ? `<span class="badge ${st.s}">${{
      open: "open", soon: "soon", later: "later", recent: "closed",
    }[st.s]}</span>` : "";
    const span = w.start
      ? `${fmt(w.start, w.precision)} to ${w.end ? fmt(w.end, w.precision) : "closing date not given"}`
      : `closes ${fmt(w.end, w.precision)}`;
    const pred = w.predicted ? ' <span class="pred">(predicted)</span>' : "";
    const url = safeUrl(w.url);
    const label = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(w.label)}</a>` : esc(w.label);
    return `<li>${label}${badge}<br><span class="d">${esc(span)}</span>${pred}</li>`;
  }

  function popupHtml(feature) {
    const props = feature.properties;
    let html = `<div class="pop"><h3>${esc(props.name)}</h3>`;
    if (!props.plans.length) {
      html += `<p class="none">No local plan data has been published for this area yet.</p>`;
    }
    for (const ref of props.plans) {
      const p = plans[ref];
      if (!p) continue;
      const doc = safeUrl(p.documentation_url) || safeUrl(p.document_url);
      html += `<div class="plan"><h4>${doc ? `<a href="${esc(doc)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</h4>`;
      const facts = [];
      if (p.period_start || p.period_end) facts.push(`Plan period ${esc(p.period_start || "?")} to ${esc(p.period_end || "?")}`);
      if (p.adopted) facts.push(`Adopted ${esc(fmt(p.adopted))}`);
      if (p.required_housing) facts.push(`${Number(p.required_housing).toLocaleString("en-GB")} homes`);
      if ((p.lpas || []).length > 1) facts.push(`Joint plan (${p.lpas.length} areas)`);
      if (facts.length) html += `<div class="facts">${facts.join(" &middot; ")}</div>`;

      const lines = (p.consultations || []).map(windowLine).filter(Boolean);
      html += lines.length
        ? `<ul>${lines.join("")}</ul>`
        : `<div class="none">No consultation dates published.</div>`;

      if (p.events && p.events.length) {
        html += `<details><summary>Full timetable (${p.events.length} events)</summary><ul class="tt">`;
        for (const ev of p.events) {
          const pr = ev.kind === "predicted" ? ' class="pred"' : "";
          html += `<li${pr}><span class="d">${esc(fmt(ev.date, ev.precision))}</span><span>${esc(ev.label)}${ev.kind === "predicted" ? " (predicted)" : ""}${ev.notes ? ` <span class="d">${esc(ev.notes)}</span>` : ""}</span></li>`;
        }
        html += `</ul></details>`;
      }
      html += `</div>`;
    }
    return html + `</div>`;
  }

  // ---------------------------------------------------------------- list
  function collectWindows() {
    const rows = [];
    for (const ref in plans) {
      const p = plans[ref];
      if (p.ended || !matches(p)) continue;
      for (const w of p.consultations || []) {
        const st = windowStatus(w);
        if (!st) continue;
        if (st.s === "open" || ((st.s === "soon" || st.s === "later") && daysBetween(today, st.start) <= LIST_AHEAD_DAYS)) {
          rows.push({ p, w, st });
        }
      }
    }
    return rows;
  }

  function itemHtml({ p, w, st }, idx) {
    const who = lpaNames(p);
    const whoText = who.length ? (who.length > 2 ? `${who[0]} and ${who.length - 1} others` : who.join(" and ")) : p.name;
    let when;
    if (st.s === "open") {
      const left = daysBetween(today, st.end);
      when = st.assumedEnd ? `Opened ${fmt(w.start, w.precision)}, closing date not given`
        : `Closes ${fmt(w.end, w.precision)} (${left === 0 ? "today" : left + " days left"})`;
    } else {
      when = `Opens ${fmt(w.start, w.precision)}${w.end ? ", closes " + fmt(w.end, w.precision) : ""}`;
    }
    return `<button class="item ${st.s}" data-idx="${idx}">
      <div class="who">${esc(whoText)}${w.predicted ? '<span class="badge">predicted</span>' : ""}</div>
      <div class="what">${esc(w.label)}: ${esc(p.name)}</div>
      <div class="when">${esc(when)}</div></button>`;
  }

  function renderLists() {
    const rows = collectWindows();
    const open = rows.filter(r => r.st.s === "open").sort((a, b) => a.st.end - b.st.end);
    const upcoming = rows.filter(r => r.st.s !== "open").sort((a, b) => a.st.start - b.st.start);
    const all = open.concat(upcoming);
    const el = document.getElementById("lists");
    el.innerHTML =
      `<h2>Open now <span class="count">(${open.length})</span></h2>` +
      (open.length ? open.map(r => itemHtml(r, all.indexOf(r))).join("") : `<p class="empty">None found.</p>`) +
      `<h2>Coming up in the next 12 months <span class="count">(${upcoming.length})</span></h2>` +
      (upcoming.length ? upcoming.map(r => itemHtml(r, all.indexOf(r))).join("") : `<p class="empty">None found.</p>`);
    el.querySelectorAll(".item").forEach(btn => {
      btn.addEventListener("click", () => focusPlan(all[Number(btn.dataset.idx)].p));
    });
  }

  function focusPlan(plan) {
    const layers = (plan.lpas || []).map(c => layersByCode[c]).filter(Boolean);
    if (!layers.length) return;
    const bounds = L.latLngBounds([]);
    layers.forEach(l => bounds.extend(l.getBounds()));
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 11 });
    layers[0].openPopup(bounds.getCenter());
  }

  function refresh() {
    if (lpaLayer) lpaLayer.setStyle(style);
    renderLists();
  }

  // ---------------------------------------------------------------- load
  Promise.all([
    fetch("data/plans.json").then(r => { if (!r.ok) throw new Error("plans.json " + r.status); return r.json(); }),
    fetch("data/lpas.geojson").then(r => { if (!r.ok) throw new Error("lpas.geojson " + r.status); return r.json(); }),
  ]).then(([planData, lpas]) => {
    plans = planData.plans || {};
    lpaLayer = L.geoJSON(lpas, {
      style,
      onEachFeature(feature, layer) {
        layersByCode[feature.properties.code] = layer;
        layer.bindPopup(() => popupHtml(feature), { maxWidth: 340, maxHeight: 380 });
        layer.bindTooltip(feature.properties.name, { sticky: true, direction: "top" });
        layer.on("mouseover", () => layer.setStyle({ weight: 2, color: "#1f2933" }));
        layer.on("mouseout", () => lpaLayer.resetStyle(layer));
      },
    }).addTo(map);
    lpaLayer.bringToFront();

    const gen = planData.generated ? new Date(planData.generated) : null;
    const c = planData.counts || {};
    document.getElementById("meta").textContent =
      `${c.plans_with_timetable || 0} of ${c.plans || 0} plans have timetable data. ` +
      (gen ? `Data last updated ${gen.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.` : "");
    renderLists();
  }).catch(err => {
    console.error(err);
    document.getElementById("lists").innerHTML =
      `<p class="error">Could not load the data files (${esc(err.message)}). ` +
      `If you have just set up the site, run the "Update local plan data" workflow in the Actions tab first.</p>`;
  });

  document.getElementById("predicted").addEventListener("change", e => { includePredicted = e.target.checked; refresh(); });
  let t;
  document.getElementById("search").addEventListener("input", e => {
    clearTimeout(t);
    t = setTimeout(() => { query = e.target.value.trim().toLowerCase(); renderLists(); }, 150);
  });
})();
