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

  // Colour-blind safe palette (orange / dark blue / light blue / greys), matching style.css
  const COLOURS = {
    open: "#d55e00", soon: "#1f4e9a", later: "#7fb5e3",
    recent: "#7d838c", data: "#e6e9ec", none: "#ffffff",
  };
  const RANK = { open: 5, soon: 4, later: 3, recent: 2, data: 1, none: 0 };

  const today = startOfDay(new Date());
  let plans = {}, lpaLayer, layersByCode = {}, includePredicted = true, query = "";
  let devolved = [], devolvedLayer, devolvedLayersByCode = {};
  // Combined authorities view: spatial development strategy (SDS) consultations
  let view = /(^|[#&])view=ca\b/.test(location.hash) ? "ca" : "lpa";
  let authorities = {}, caLayer, caLayersById = {}, lpaOutline, lpaGeo;
  // Consultations tERC has responded to: data/static/terc-responses.csv (edit on GitHub)
  let responses = [];

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

  // ------------------------------------------------- Scotland and Wales
  // No national timetable data exists for Scotland or Wales, so these areas
  // show coverage and a link to each authority's plan page (or homepage).
  // Edit data/static/scotland-wales-plans.csv to update links.

  function parseCsv(text) {
    const rows = []; let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') q = false;
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(v => v !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field); if (row.some(v => v !== "")) rows.push(row);
    const head = rows.shift() || [];
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] || "").trim()])));
  }

  const DEVOLVED_STYLE = {
    color: "#5b6672", weight: 1, opacity: 0.9, dashArray: "4 3",
    fillColor: "#f6f1e4", fillOpacity: 0.6,
  };

  function devolvedLinkHtml(row) {
    const url = safeUrl(row.link);
    if (!url) return `<div class="none">No link added yet.</div>`;
    const site = row.authority_type === "national_park" ? "Authority website" : "Council website";
    const label = row.link_type === "plan_page" ? "Local development plan page" : `${site} (plan page link not yet added)`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  }

  function devolvedPopupHtml(feature) {
    const code = feature.properties.code;
    const row = devolved.find(r => r.code === code) || { name: feature.properties.name };
    const parks = devolved.filter(r => r.authority_type === "national_park" && (r.overlaps || "").split(";").includes(code));
    let html = `<div class="pop"><h3>${esc(row.name || feature.properties.name)}</h3>`;
    html += `<div class="facts">${esc(feature.properties.nation)}: plan links only. No national timetable data is published, so consultation dates are not shown.</div>`;
    html += devolvedLinkHtml(row);
    if (row.note) html += `<div class="facts" style="margin-top:6px">${esc(row.note)}</div>`;
    for (const np of parks) {
      html += `<div class="plan"><h4>${esc(np.name)}</h4><div class="facts">Part of this area is in the national park, which has its own local development plan.</div>${devolvedLinkHtml(np)}</div>`;
    }
    return html + `</div>`;
  }

  function devolvedMatches() {
    if (!query) return [];
    return devolved.filter(r => (r.name || "").toLowerCase().includes(query));
  }

  // ------------------------------------------------- tERC responses
  // A row matches a consultation when its plan matches the plan reference (or the
  // combined authority id), its stage matches the stage code or label (if given)
  // and its start date matches (if given; only needed when a stage repeats).
  function norm(s) { return String(s == null ? "" : s).trim().toLowerCase(); }
  function responseFor(ref, w) {
    return responses.find(r => r.plan === ref &&
      (!r.stage || norm(r.stage) === norm(w.stage) || norm(r.stage) === norm(w.label)) &&
      (!r.start || r.start === w.start));
  }
  function respondedHtml(r) {
    if (!r) return "";
    const text = `\u2713 tERC responded${r.responded ? " " + fmt(r.responded) : ""}`;
    const url = safeUrl(r.link);
    return url
      ? ` <a class="badge terc" href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`
      : ` <span class="badge terc">${esc(text)}</span>`;
  }

  // ---------------------------------------------------------------- map
  const map = L.map("map", { zoomSnap: 0.25, minZoom: 4.5 });
  map.fitBounds([[49.9, -8.2], [60.9, 1.8]]);  // Great Britain
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  function style(feature) {
    const s = lpaStatus(feature);
    // open consultations also get a heavy outline, so the key status never relies on colour alone
    return {
      color: s === "open" ? "#1f2933" : "#5b6672",
      weight: s === "open" ? 2.5 : 0.6,
      opacity: s === "open" ? 1 : 0.8,
      fillColor: COLOURS[s], fillOpacity: s === "none" ? 0.15 : 0.75,
    };
  }

  function windowLine(w, ref) {
    const st = windowStatus(w);
    if (!st && w.predicted && !includePredicted) return "";
    const badge = st && st.s !== "past" ? `<span class="badge ${st.s}">${{
      open: "open", soon: "soon", later: "later", recent: "closed",
    }[st.s]}</span>` : "";
    const span = w.start
      ? `${fmt(w.start, w.precision)} to ${w.end ? fmt(w.end, w.precision) : "closing date not given"}`
      : `closes ${fmt(w.end, w.precision)}`;
    const pred = w.predicted ? ' <span class="pred">(predicted)</span>' : "";
    const note = w.note ? ` <span class="d">&middot; ${esc(w.note)}</span>` : "";
    const url = safeUrl(w.url);
    const label = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(w.label)}</a>` : esc(w.label);
    return `<li>${label}${badge}<br><span class="d">${esc(span)}</span>${pred}${note}${respondedHtml(responseFor(ref, w))}</li>`;
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

      const lines = (p.consultations || []).map(w => windowLine(w, ref)).filter(Boolean);
      html += lines.length
        ? `<ul>${lines.join("")}</ul>`
        : `<div class="none">No consultation dates published.</div>`;

      if (p.events && p.events.length) {
        html += `<details><summary>Full timetable (${p.events.length} events)</summary><ul class="tt">`;
        for (const ev of p.events) {
          const pr = ev.kind === "predicted" ? ' class="pred"' : "";
          html += `<li${pr}><span class="d">${esc(fmt(ev.date, ev.precision))}</span><span>${esc(ev.label)}${ev.kind === "predicted" ? " (predicted)" : ""}${ev.notes ? ` <span class="d">${esc(ev.notes)}</span>` : ""}</span></li>`;
        }
        html += `</ul><div class="ref">Plan reference: ${esc(ref)}</div></details>`;
      }
      html += `</div>`;
    }
    return html + `</div>`;
  }

  // ------------------------------------------------- combined authorities
  // SDS dates have no national dataset; they live in data/static/sds-consultations.csv
  // and authority details in data/static/strategic-authorities.csv (edit those on GitHub).

  function sdsWindows(a, kind) {
    return a.windows.filter(w => !kind || w.kind === kind);
  }

  function caStatus(id) {
    const a = authorities[id];
    if (!a) return "none";
    let best = "data";
    for (const w of sdsWindows(a, "sds")) {
      const st = windowStatus(w);
      if (st && RANK[st.s] > RANK[best]) best = st.s;
    }
    return best;
  }

  function caStyle(feature) {
    const s = caStatus(feature.properties.id);
    return {
      color: s === "open" ? "#1f2933" : "#3e4852",
      weight: s === "open" ? 3 : 1.4,
      opacity: 1,
      fillColor: COLOURS[s], fillOpacity: 0.7,
    };
  }

  function caPopupHtml(feature) {
    const id = feature.properties.id;
    const a = authorities[id] || { name: feature.properties.name, windows: [] };
    const link = safeUrl(a.link);
    let html = `<div class="pop"><h3>${esc(a.name)}</h3>`;
    if (a.authority_type) html += `<div class="facts">${esc(a.authority_type)}</div>`;
    html += `<div class="plan"><h4>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(a.sds_name)}</a>` : esc(a.sds_name || "Spatial development strategy")}</h4>`;
    if (a.status) html += `<div class="facts">${esc(a.status)}</div>`;
    const lines = sdsWindows(a, "sds").map(w => windowLine(w, id)).filter(Boolean);
    if (lines.length) html += `<ul>${lines.join("")}</ul>`;
    else if (!a.status) html += `<div class="none">No SDS consultation dates published.</div>`;
    if (a.next_step) html += `<div class="facts" style="margin-top:6px"><strong>Next:</strong> ${esc(a.next_step)}</div>`;
    if (a.note) html += `<div class="facts">${esc(a.note)}</div>`;
    html += `</div>`;
    const related = sdsWindows(a, "related").map(w => windowLine(w, id)).filter(Boolean);
    if (related.length) html += `<div class="related-h">Related strategic plan</div><ul>${related.join("")}</ul>`;
    const names = feature.properties.member_names || [];
    if (names.length) {
      html += `<details><summary>Member council areas (${names.length})</summary><p class="members">${names.map(esc).join(", ")}</p></details>`;
    }
    return html + `</div>`;
  }

  function caMatches(a) {
    if (!query) return true;
    const f = caLayersById[a.id] && caLayersById[a.id].feature;
    const hay = [a.name, a.sds_name, ...((f && f.properties.member_names) || [])].join(" ").toLowerCase();
    return hay.includes(query);
  }

  function caItemHtml({ a, w, st }, idx) {
    let when;
    if (st.s === "open") {
      const left = daysBetween(today, st.end);
      when = `Closes ${fmt(w.end)} (${left === 0 ? "today" : left === 1 ? "1 day left" : left + " days left"})`;
    } else if (st.s === "recent") {
      when = `${fmt(w.start)} to ${fmt(w.end)}`;
    } else {
      when = `Opens ${fmt(w.start, w.precision)}${w.end ? ", closes " + fmt(w.end, w.precision) : ""}`;
    }
    return `<button class="item ${st.s}${w.kind === "related" ? " related" : ""}" data-ca="${esc(a.id)}" data-idx="${idx}">
      <div class="who">${esc(a.name)}</div>
      <div class="what">${esc(w.label)}</div>
      <div class="when">${esc(when)}${respondedHtml(responseFor(a.id, w))}</div></button>`;
  }

  function renderCaLists(el) {
    const rows = [];
    const shown = Object.values(authorities).filter(caMatches);
    for (const a of shown) {
      for (const w of a.windows) {
        const st = windowStatus(w);
        if (!st || st.s === "past") continue;
        if ((st.s === "soon" || st.s === "later") && daysBetween(today, st.start) > LIST_AHEAD_DAYS) continue;
        rows.push({ a, w, st });
      }
    }
    const open = rows.filter(r => r.st.s === "open").sort((x, y) => x.st.end - y.st.end);
    const upcoming = rows.filter(r => r.st.s === "soon" || r.st.s === "later").sort((x, y) => x.st.start - y.st.start);
    const recent = rows.filter(r => r.st.s === "recent").sort((x, y) => y.st.end - x.st.end);
    const section = (title, list) => `<h2>${title} <span class="count">(${list.length})</span></h2>` +
      (list.length ? list.map(r => caItemHtml(r)).join("") : `<p class="empty">None found.</p>`);
    const pending = shown.filter(a => !rows.some(r => r.a === a && r.w.kind === "sds" && r.st.s !== "recent"));
    el.innerHTML =
      section("SDS consultations open now", open) +
      section("Coming up in the next 12 months", upcoming) +
      section("Closed in the last 12 months", recent) +
      `<h2>No upcoming SDS dates published <span class="count">(${pending.length})</span></h2>` +
      pending.map(a => `<button class="item next" data-ca="${esc(a.id)}">
        <div class="who">${esc(a.name)}</div>
        <div class="what">${esc(a.next_step || a.status || "")}</div></button>`).join("");
    el.querySelectorAll(".item[data-ca]").forEach(btn => btn.addEventListener("click", () => focusCa(btn.dataset.ca)));
  }

  function focusCa(id) {
    const layer = caLayersById[id];
    if (!layer) return;
    map.fitBounds(layer.getBounds(), { padding: [30, 30], maxZoom: 10 });
    layer.openPopup(layer.getBounds().getCenter());
  }

  function setView(v) {
    view = v;
    document.querySelectorAll(".view-toggle button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.view === v)));
    document.querySelectorAll("[data-lpa]").forEach(s => { s.textContent = s.dataset[v === "ca" ? "ca" : "lpa"]; });
    document.querySelectorAll(".lpa-only").forEach(s => { s.hidden = v === "ca"; });
    document.querySelectorAll(".ca-only").forEach(s => { s.hidden = v !== "ca"; });
    document.getElementById("view-note").hidden = v !== "ca";
    document.getElementById("predicted-toggle").hidden = v === "ca";
    const search = document.getElementById("search");
    search.placeholder = v === "ca" ? "Search authority or council" : "Search council or plan";
    search.setAttribute("aria-label", search.placeholder);
    map.closePopup();
    if (v === "ca") {
      if (lpaLayer) map.removeLayer(lpaLayer);
      if (caLayer) caLayer.addTo(map);
      if (lpaOutline) lpaOutline.addTo(map);
    } else {
      if (caLayer) map.removeLayer(caLayer);
      if (lpaOutline) map.removeLayer(lpaOutline);
      if (lpaLayer) lpaLayer.addTo(map);
    }
    if (devolvedLayer) devolvedLayer.bringToBack();
    history.replaceState(null, "", v === "ca" ? "#view=ca" : location.pathname + location.search);
    renderLists();
  }

  function buildLpaOutline() {
    if (lpaOutline || !lpaGeo) return;
    lpaOutline = L.geoJSON(lpaGeo, {
      interactive: false,
      style: { color: "#5b6672", weight: 0.5, opacity: 0.55, fill: false },
    });
    if (view === "ca") lpaOutline.addTo(map);
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
        : `Closes ${fmt(w.end, w.precision)} (${left === 0 ? "today" : left === 1 ? "1 day left" : left + " days left"})`;
    } else {
      when = `Opens ${fmt(w.start, w.precision)}${w.end ? ", closes " + fmt(w.end, w.precision) : ""}`;
    }
    return `<button class="item ${st.s}" data-idx="${idx}">
      <div class="who">${esc(whoText)}${w.predicted ? '<span class="badge">predicted</span>' : ""}</div>
      <div class="what">${esc(w.label)}: ${esc(p.name)}</div>
      <div class="when">${esc(when)}${respondedHtml(responseFor(p.reference, w))}</div></button>`;
  }

  function renderLists() {
    if (view === "ca") {
      const el = document.getElementById("lists");
      if (!caLayer) { el.innerHTML = `<p class="loading">Loading combined authority data...</p>`; return; }
      renderCaLists(el);
      return;
    }
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
    const dev = devolvedMatches();
    if (dev.length) {
      el.innerHTML += `<h2>Scotland and Wales <span class="count">(${dev.length})</span></h2>` +
        dev.map((r, i) => `<button class="item devolved" data-dev="${i}">
          <div class="who">${esc(r.name)}</div>
          <div class="what">${esc(r.nation)}: plan links only, no timetable data</div></button>`).join("");
    }
    el.querySelectorAll(".item[data-idx]").forEach(btn => {
      btn.addEventListener("click", () => focusPlan(all[Number(btn.dataset.idx)].p));
    });
    el.querySelectorAll(".item[data-dev]").forEach(btn => {
      btn.addEventListener("click", () => focusDevolved(dev[Number(btn.dataset.dev)]));
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

  function focusDevolved(row) {
    const codes = row.authority_type === "national_park" ? (row.overlaps || "").split(";") : [row.code];
    const layers = codes.map(c => devolvedLayersByCode[c]).filter(Boolean);
    if (!layers.length) return;
    const bounds = L.latLngBounds([]);
    layers.forEach(l => bounds.extend(l.getBounds()));
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10 });
    layers[0].openPopup(bounds.getCenter());
  }

  function refresh() {
    if (lpaLayer) lpaLayer.setStyle(style);
    if (caLayer) caLayer.setStyle(caStyle);
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
    });
    if (view === "lpa") lpaLayer.addTo(map);
    lpaGeo = lpas;
    buildLpaOutline();

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

  Promise.all([
    fetch("data/static/scotland-wales-councils.geojson").then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    fetch("data/static/scotland-wales-plans.csv").then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }),
  ]).then(([geo, csvText]) => {
    devolved = parseCsv(csvText);
    devolvedLayer = L.geoJSON(geo, {
      style: () => DEVOLVED_STYLE,
      onEachFeature(feature, layer) {
        devolvedLayersByCode[feature.properties.code] = layer;
        layer.bindPopup(() => devolvedPopupHtml(feature), { maxWidth: 340, maxHeight: 380 });
        layer.bindTooltip(feature.properties.name, { sticky: true, direction: "top" });
        layer.on("mouseover", () => layer.setStyle({ weight: 2, color: "#1f2933" }));
        layer.on("mouseout", () => layer.setStyle(DEVOLVED_STYLE));
      },
    }).addTo(map);
    if (query) renderLists();
  }).catch(err => console.warn("Scotland and Wales layer not loaded:", err));

  Promise.all([
    fetch("data/strategic-authorities.geojson").then(r => { if (!r.ok) throw new Error("strategic-authorities.geojson " + r.status); return r.json(); }),
    fetch("data/static/strategic-authorities.csv").then(r => { if (!r.ok) throw new Error("strategic-authorities.csv " + r.status); return r.text(); }),
    fetch("data/static/sds-consultations.csv").then(r => { if (!r.ok) throw new Error("sds-consultations.csv " + r.status); return r.text(); }),
  ]).then(([geo, authText, consText]) => {
    for (const row of parseCsv(authText)) {
      if (row.id) authorities[row.id] = Object.assign(row, { windows: [] });
    }
    for (const row of parseCsv(consText)) {
      const a = authorities[row.authority];
      if (!a || (!row.start && !row.end)) continue;
      a.windows.push({
        kind: row.kind === "related" ? "related" : "sds",
        label: row.label, start: row.start || null, end: row.end || null,
        precision: "day", predicted: false, url: row.url, note: row.note,
      });
    }
    for (const a of Object.values(authorities)) a.windows.sort((x, y) => (x.start || x.end).localeCompare(y.start || y.end));
    caLayer = L.geoJSON(geo, {
      style: caStyle,
      onEachFeature(feature, layer) {
        caLayersById[feature.properties.id] = layer;
        layer.bindPopup(() => caPopupHtml(feature), { maxWidth: 340, maxHeight: 400 });
        layer.bindTooltip(feature.properties.name, { sticky: true, direction: "top" });
        layer.on("mouseover", () => layer.setStyle({ weight: 3, color: "#1f2933" }));
        layer.on("mouseout", () => caLayer.resetStyle(layer));
      },
    });
    if (view === "ca") {
      caLayer.addTo(map);
      if (lpaOutline) lpaOutline.bringToFront();
      renderLists();
    }
  }).catch(err => {
    console.warn("Combined authorities layer not loaded:", err);
    if (view === "ca") document.getElementById("lists").innerHTML =
      `<p class="error">Could not load the combined authority data (${esc(err.message)}).</p>`;
  });

  fetch("data/static/terc-responses.csv")
    .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(text => { responses = parseCsv(text).filter(r => r.plan); renderLists(); })
    .catch(err => console.warn("tERC responses not loaded:", err));

  document.querySelectorAll(".view-toggle button").forEach(btn => {
    btn.addEventListener("click", () => { if (btn.dataset.view !== view) setView(btn.dataset.view); });
    btn.addEventListener("keydown", e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const next = view === "ca" ? "lpa" : "ca";
        setView(next);
        document.querySelector(`.view-toggle button[data-view="${next}"]`).focus();
      }
    });
  });
  if (view === "ca") setView("ca");

  document.getElementById("predicted").addEventListener("change", e => { includePredicted = e.target.checked; refresh(); });
  let t;
  document.getElementById("search").addEventListener("input", e => {
    clearTimeout(t);
    t = setTimeout(() => { query = e.target.value.trim().toLowerCase(); renderLists(); }, 150);
  });
})();
