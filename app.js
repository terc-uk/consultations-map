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
  // Views: "lpa" local plans, "ca" combined authorities (SDS), "nat" national consultations
  let view = /(^|[#&])view=ca\b/.test(location.hash) ? "ca"
    : /(^|[#&])view=national\b/.test(location.hash) ? "nat" : "lpa";
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

  const SEARCH_LABELS = { lpa: "Search council or plan", ca: "Search authority or council", nat: "Search title, organisation or nation" };

  function setView(v) {
    view = v;
    document.querySelectorAll(".view-toggle button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.view === v)));
    document.querySelectorAll("[data-lpa]").forEach(s => { s.textContent = s.dataset[v] || s.dataset.lpa; });
    document.querySelectorAll(".lpa-only").forEach(s => { s.hidden = v !== "lpa"; });
    document.querySelectorAll(".ca-only").forEach(s => { s.hidden = v !== "ca"; });
    document.querySelectorAll(".nat-only").forEach(s => { s.hidden = v !== "nat"; });
    document.querySelectorAll(".not-nat").forEach(s => { s.hidden = v === "nat"; });
    document.getElementById("predicted-toggle").hidden = v !== "lpa";
    document.getElementById("save-bar").hidden = !(v === "nat" && editing);
    const search = document.getElementById("search");
    search.placeholder = SEARCH_LABELS[v];
    search.setAttribute("aria-label", search.placeholder);
    map.closePopup();
    for (const layer of [lpaLayer, caLayer, lpaOutline, natLayer]) if (layer) map.removeLayer(layer);
    if (v === "ca") {
      if (caLayer) caLayer.addTo(map);
      if (lpaOutline) lpaOutline.addTo(map);
    } else if (v === "nat") {
      if (natLayer) natLayer.addTo(map);
    } else if (lpaLayer) {
      lpaLayer.addTo(map);
    }
    if (devolvedLayer) {
      if (v === "nat") map.removeLayer(devolvedLayer);
      else { devolvedLayer.addTo(map); devolvedLayer.bringToBack(); }
    }
    updateHash();
    renderLists();
  }

  function updateHash() {
    let h = "";
    if (view === "ca") h = "#view=ca";
    else if (view === "nat") h = "#view=national" + (natShow && natShow !== defaultShow() ? "&show=" + natShow : "");
    history.replaceState(null, "", h || location.pathname + location.search);
  }

  // ------------------------------------------------- national consultations
  // Built daily by scripts/fetch_national.py into data/national.json. tERC's flags
  // (relevant, responded) live in data/static/national-terc.csv: one row per
  // consultation tERC considers relevant. They can be edited on GitHub or with the
  // "Edit tERC flags" button, which saves through the GitHub API with a token.
  // the repository is worked out from the GitHub Pages address, so a rename needs no code change
  const REPO = (() => {
    const owner = (location.hostname.match(/^([^.]+)\.github\.io$/) || [])[1];
    const repo = location.pathname.split("/")[1];
    return owner && repo ? `${owner}/${repo}` : "terc-uk/consultations-map";
  })();
  const BRANCH = "main", FLAGS_PATH = "data/static/national-terc.csv";
  const FLAG_COLUMNS = ["id", "title", "status", "responded", "link"];
  const NEW_DAYS = 7;
  const NATIONS = ["England", "Scotland", "Wales", "Northern Ireland"];
  let national = [], natFlags = {}, natLayer, natLayersByName = {}, natLoaded = false;
  let natShow = (location.hash.match(/[#&]show=(new|relevant|all|not)\b/) || [])[1] || null;
  let editing = false, pending = {}, token = null, flagsSha = null;

  function defaultShow() { return Object.values(natFlags).some(isRelevantRow) ? "relevant" : "all"; }
  function flagFor(id) { return id in pending ? pending[id] : natFlags[id]; }
  // a row in national-terc.csv means the consultation has been reviewed; status says the outcome
  // (rows from before the status column existed were all relevant ones)
  function isRelevantRow(r) { return !!r && (r.responded || !/^not/i.test(r.status || "")); }
  function reviewOf(id) { const f = flagFor(id); return !f ? "new" : isRelevantRow(f) ? "relevant" : "not"; }

  function natStatus(c) {
    const start = parse(c.start), end = parse(c.end);
    const ahead = d => (daysBetween(today, d) <= SOON_DAYS ? "soon" : "later");
    if (end) {
      if (end < today) return { s: daysBetween(end, today) <= RECENT_DAYS ? "recent" : "past", start, end };
      if (start && today < start) return { s: ahead(start), start, end };
      return { s: "open", start, end };
    }
    if (c.state === "closed") {
      const ref = parse(c.published || c.start || c.first_seen);
      return { s: ref && daysBetween(ref, today) <= RECENT_DAYS ? "recent" : "past", start, end: null, ref };
    }
    if (start && today < start) return { s: ahead(start), start, end: null };
    if (c.state === "forthcoming") return { s: "soon", start, end: null };
    if (!c.state) {
      // status not known yet (page not read): assume the usual six weeks from publication
      const ref = parse(c.published || c.start);
      if (ref && daysBetween(ref, today) > DEFAULT_LENGTH_DAYS) {
        return { s: daysBetween(ref, today) <= RECENT_DAYS ? "recent" : "past", start, end: null, ref };
      }
    }
    return { s: "open", start, end: null };
  }

  function appliesTo(c, nation) { return c.nations.includes("UK") || c.nations.includes(nation); }

  function natMatchesQuery(c) {
    if (!query) return true;
    return [c.title, c.org, c.kind, ...(c.nations || [])].join(" ").toLowerCase().includes(query);
  }

  function natPasses(c, show) {
    return show === "all" || reviewOf(c.id) === show;
  }

  // consultations in the current list: matching the search and relevance filter, not long closed
  function natRows(show) {
    const rows = [];
    for (const c of national) {
      if (!natMatchesQuery(c) || !natPasses(c, show || natShow)) continue;
      const st = natStatus(c);
      if (st.s === "past") continue;
      if ((st.s === "soon" || st.s === "later") && st.start && daysBetween(today, st.start) > LIST_AHEAD_DAYS) continue;
      rows.push({ c, st });
    }
    return rows;
  }

  function natNationStatus(name) {
    let best = "data";
    for (const { c, st } of natRows()) {
      if (appliesTo(c, name) && RANK[st.s] > RANK[best]) best = st.s;
    }
    return best;
  }

  function natStyle(feature) {
    const s = natNationStatus(feature.properties.name);
    return {
      color: s === "open" ? "#1f2933" : "#3e4852",
      weight: s === "open" ? 3 : 1.4, opacity: 1,
      fillColor: COLOURS[s], fillOpacity: 0.7,
    };
  }

  function natWhen(c, st) {
    if (st.s === "open") {
      if (!st.end) return c.start ? `Opened ${fmt(c.start)}, closing date not given` : "Open, closing date not given";
      const left = daysBetween(today, st.end);
      return `Closes ${fmt(c.end)} (${left === 0 ? "today" : left === 1 ? "1 day left" : left + " days left"})`;
    }
    if (st.s === "recent") return st.end ? `Closed ${fmt(c.end)}` : "Closed";
    return st.start ? `Opens ${fmt(c.start)}${c.end ? ", closes " + fmt(c.end) : ""}` : "Opening date not given yet";
  }

  function nationTags(c) {
    const ns = c.nations.includes("UK") ? ["UK"] : c.nations;
    return ns.map(n => `<span class="tag">${esc(n)}</span>`).join("");
  }

  function natFlagHtml(c) {
    const f = flagFor(c.id), review = reviewOf(c.id);
    if (f && f.responded) return respondedHtml(f);
    if (review === natShow) return "";
    if (review === "relevant") return ` <span class="badge rel">tERC relevant</span>`;
    if (review === "not") return ` <span class="badge notrel">not relevant</span>`;
    return natShow === "all" ? ` <span class="badge torev">to review</span>` : "";
  }

  function natEditHtml(c) {
    if (!editing) return "";
    const f = flagFor(c.id), review = reviewOf(c.id), id = esc(c.id);
    const opt = (v, label) => `<label><input type="radio" name="rv-${id}" value="${v}" data-review="${id}"${review === v ? " checked" : ""}> ${label}</label>`;
    return `<div class="edit-row">
      <span class="review" role="radiogroup" aria-label="Review">${opt("new", "To review")}${opt("relevant", "Relevant")}${opt("not", "Not relevant")}</span>
      <label>Responded <input type="date" data-resp="${id}" value="${esc((f && f.responded) || "")}"></label></div>`;
  }

  function natItemHtml({ c, st }) {
    const url = safeUrl(c.url);
    const isNew = c.first_seen && daysBetween(parse(c.first_seen), today) <= NEW_DAYS;
    return `<div class="item nat ${st.s} rv-${reviewOf(c.id)}" data-nat="${esc(c.id)}">
      <div class="who">${esc(c.org || c.source)}${nationTags(c)}${isNew ? '<span class="badge new">added this week</span>' : ""}</div>
      <div class="what">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}
        <span class="kind">${esc(c.kind || "")}</span></div>
      <div class="when">${esc(natWhen(c, st))}<span class="flag">${natFlagHtml(c)}</span></div>
      ${natEditHtml(c)}</div>`;
  }

  function renderNatLists(el) {
    if (!natLoaded) { el.innerHTML = `<p class="loading">Loading national consultations...</p>`; return; }
    if (!natShow) natShow = defaultShow();
    updateFilterCounts();
    const rows = natRows();
    const endKey = r => (r.st.end ? +r.st.end : Infinity);
    const open = rows.filter(r => r.st.s === "open").sort((a, b) => endKey(a) - endKey(b));
    const upcoming = rows.filter(r => r.st.s === "soon" || r.st.s === "later")
      .sort((a, b) => (a.st.start ? +a.st.start : Infinity) - (b.st.start ? +b.st.start : Infinity));
    const recent = rows.filter(r => r.st.s === "recent")
      .sort((a, b) => (+(b.st.end || b.st.ref || 0)) - (+(a.st.end || a.st.ref || 0)));
    const list = l => l.length ? l.map(natItemHtml).join("") : `<p class="empty">None found.</p>`;
    const empty = natShow === "relevant" && !Object.values(natFlags).some(isRelevantRow) && !editing
      ? `<p class="empty">No consultations have been marked as relevant to tERC yet. Choose "All" to see everything.</p>` : "";
    const left = editing && natShow === "new" ? rows.filter(r => reviewOf(r.c.id) === "new").length : 0;
    const bulk = left ? `<div class="bulk"><button type="button" class="linkish" id="bulk-not">Mark the ${left} still to review as not relevant</button>
      <span class="d">(includes closed ones; nothing is saved until you press Save)</span></div>` : "";
    el.innerHTML = empty + bulk +
      `<h2>Open now <span class="count">(${open.length})</span></h2>` + list(open) +
      `<h2>Coming up <span class="count">(${upcoming.length})</span></h2>` + list(upcoming) +
      `<details class="closed-list"><summary><h2>Closed in the last 12 months <span class="count">(${recent.length})</span></h2></summary></details>`;
    const det = el.querySelector(".closed-list");
    det.addEventListener("toggle", () => {
      if (det.open && !det.dataset.filled) { det.insertAdjacentHTML("beforeend", list(recent)); det.dataset.filled = "1"; }
    });
  }

  function updateFilterCounts() {
    for (const b of document.querySelectorAll(".filter-toggle button")) {
      b.setAttribute("aria-checked", String(b.dataset.show === natShow));
      b.querySelector(".n").textContent = `(${natRows(b.dataset.show).length})`;
    }
    const bulk = document.getElementById("bulk-not");
    if (bulk) bulk.textContent = `Mark the ${natRows("new").length} still to review as not relevant`;
  }

  function natPopupHtml(feature) {
    const name = feature.properties.name;
    const rows = natRows().filter(r => appliesTo(r.c, name) && r.st.s !== "recent")
      .sort((a, b) => (a.st.end ? +a.st.end : Infinity) - (b.st.end ? +b.st.end : Infinity));
    const label = { new: "still to review", relevant: "relevant to tERC", all: "", not: "not relevant" }[natShow];
    let html = `<div class="pop"><h3>${esc(name)}</h3><div class="facts">${rows.length} open or upcoming ${label} consultation${rows.length === 1 ? "" : "s"} that apply here, including UK-wide ones.</div><ul>`;
    for (const { c, st } of rows.slice(0, 25)) {
      const url = safeUrl(c.url);
      html += `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}` +
        `<span class="badge ${st.s}">${{ open: "open", soon: "soon", later: "later" }[st.s]}</span>` +
        `<br><span class="d">${esc(c.org || "")} &middot; ${esc(natWhen(c, st))}</span>${natFlagHtml(c)}</li>`;
    }
    if (rows.length > 25) html += `<li class="d">and ${rows.length - 25} more in the list</li>`;
    return html + `</ul></div>`;
  }

  function highlightNations(c, on) {
    if (!natLayer) return;
    for (const n of NATIONS) {
      const layer = natLayersByName[n];
      if (!layer) continue;
      if (on && appliesTo(c, n)) layer.setStyle({ weight: 4, color: "#0b5cad" });
      else natLayer.resetStyle(layer);
    }
  }

  // ---- editing tERC flags (saved to GitHub)
  function csvField(v) { v = String(v == null ? "" : v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }
  function toCsv(rows) { return [FLAG_COLUMNS.join(","), ...rows.map(r => FLAG_COLUMNS.map(k => csvField(r[k])).join(","))].join("\n") + "\n"; }
  function b64decode(s) { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), ch => ch.charCodeAt(0))); }
  function b64encode(s) { let bin = ""; for (const byte of new TextEncoder().encode(s)) bin += String.fromCharCode(byte); return btoa(bin); }
  function setFlags(rows) {
    natFlags = {};
    for (const r of rows) if (r.id) natFlags[r.id.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")] = r;
  }

  async function gh(path, opts = {}) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
      ...opts,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(r.status === 401 ? "the token was not accepted" : r.status === 403 ? "the token does not have write access to " + REPO : (body.message || "HTTP " + r.status));
    }
    return r.json();
  }

  async function loadFlagsFromGitHub() {
    const file = await gh(`contents/${FLAGS_PATH}?ref=${BRANCH}`);
    flagsSha = file ? file.sha : null;
    return file ? parseCsv(b64decode(file.content)).filter(r => r.id) : [];
  }

  function storedToken() {
    try { return sessionStorage.getItem("terc-gh-token") || localStorage.getItem("terc-gh-token"); } catch (e) { return null; }
  }
  function storeToken(t, remember) {
    try {
      sessionStorage.setItem("terc-gh-token", t);
      if (remember) localStorage.setItem("terc-gh-token", t); else localStorage.removeItem("terc-gh-token");
    } catch (e) { /* storage unavailable: token lasts for this page only */ }
  }
  function forgetToken() {
    try { sessionStorage.removeItem("terc-gh-token"); localStorage.removeItem("terc-gh-token"); } catch (e) { /* ignore */ }
  }

  async function startEditing(t) {
    token = t;
    const rows = await loadFlagsFromGitHub();  // also checks the token can read the repository
    setFlags(rows);
    editing = true; pending = {};
    natShow = "new";  // start with the consultations still to review
    updateHash();
    document.getElementById("token-form").hidden = true;
    document.getElementById("edit-start").hidden = true;
    document.getElementById("save-bar").hidden = false;
    updateSaveBar();
    refresh();
  }

  function stopEditing() {
    if (Object.keys(pending).length && !confirmDiscard()) return;
    editing = false; pending = {}; token = null;
    document.getElementById("save-bar").hidden = true;
    document.getElementById("edit-start").hidden = false;
    refresh();
  }

  function confirmDiscard() {
    const status = document.getElementById("save-status");
    if (status.dataset.confirm) { delete status.dataset.confirm; return true; }
    status.textContent = "You have unsaved changes. Press again to discard them.";
    status.dataset.confirm = "1";
    return false;
  }

  function updateSaveBar(msg) {
    const n = Object.keys(pending).length;
    const status = document.getElementById("save-status");
    delete status.dataset.confirm;
    status.textContent = msg || (n ? `${n} unsaved change${n === 1 ? "" : "s"}` : "Mark each consultation as relevant or not relevant to tERC.");
    document.getElementById("save-btn").disabled = !n;
    document.getElementById("discard-btn").hidden = !n;
  }

  function setPending(id, row, quiet) {
    const before = natFlags[id];
    const key = r => (r ? [isRelevantRow(r), r.responded || "", r.link || ""].join("|") : "");
    if (key(before) === key(row)) delete pending[id]; else pending[id] = row;
    if (quiet) return;
    updateSaveBar();
    updateFilterCounts();
    const c = national.find(x => x.id === id), review = reviewOf(id);
    document.querySelectorAll(`.item.nat[data-nat="${CSS.escape(id)}"]`).forEach(el => {
      el.classList.remove("rv-new", "rv-relevant", "rv-not");
      el.classList.add("rv-" + review);
      el.classList.toggle("moved", natShow !== "all" && review !== natShow);  // leaves this filter on the next refresh
      const f = el.querySelector(".flag"); if (f && c) f.innerHTML = natFlagHtml(c);
      el.querySelectorAll("input[data-review]").forEach(r => { r.checked = r.value === review; });
      const d = el.querySelector("input[data-resp]"); if (d) d.value = (row && row.responded) || "";
    });
    if (natLayer) natLayer.setStyle(natStyle);
  }

  function reviewRow(id, review, responded) {
    if (review === "new") return null;
    const c = national.find(x => x.id === id);
    const row = Object.assign({ id, title: c ? c.title : "", responded: "", link: "" }, flagFor(id) || {});
    row.status = review === "relevant" ? "relevant" : "not relevant";
    if (responded !== undefined) row.responded = responded;
    if (review === "not") row.responded = "";
    return row;
  }

  function markRestNotRelevant() {
    for (const { c } of natRows("new")) {
      if (reviewOf(c.id) === "new") setPending(c.id, reviewRow(c.id, "not"), true);
    }
    updateSaveBar();
    refresh();
  }

  async function saveFlags() {
    const btn = document.getElementById("save-btn");
    btn.disabled = true;
    updateSaveBar("Saving...");
    try {
      const latest = await loadFlagsFromGitHub();  // merge into the latest file so nothing is overwritten
      const byId = new Map(latest.map(r => [r.id, r]));
      for (const [id, row] of Object.entries(pending)) {
        if (row) byId.set(id, Object.assign(byId.get(id) || {}, row));
        else byId.delete(id);
      }
      const rows = [...byId.values()].map(r => Object.assign(r, { status: isRelevantRow(r) ? "relevant" : "not relevant" }));
      const n = Object.keys(pending).length;
      const body = { message: `Update tERC flags on ${n} national consultation${n === 1 ? "" : "s"}`, content: b64encode(toCsv(rows)), branch: BRANCH };
      if (flagsSha) body.sha = flagsSha;
      const res = await gh(`contents/${FLAGS_PATH}`, { method: "PUT", body: JSON.stringify(body) });
      flagsSha = res && res.content ? res.content.sha : null;
      setFlags(rows);
      pending = {};
      updateSaveBar("Saved. The public map updates within a few minutes.");
      refresh();
    } catch (err) {
      updateSaveBar(`Could not save: ${err.message}. Your changes are still here.`);
      btn.disabled = false;
    }
  }

  function onListChange(e) {
    const t = e.target;
    if (!editing) return;
    if (t.matches("input[data-review]")) {
      setPending(t.dataset.review, reviewRow(t.dataset.review, t.value));
    } else if (t.matches("input[data-resp]")) {
      const id = t.dataset.resp;
      if (t.value) setPending(id, reviewRow(id, "relevant", t.value));  // a response means it is relevant
      else if (flagFor(id)) setPending(id, reviewRow(id, reviewOf(id), ""));
    }
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
    if (view === "nat") {
      renderNatLists(document.getElementById("lists"));
      if (natLayer) natLayer.setStyle(natStyle);
      return;
    }
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
    if (natLayer) natLayer.setStyle(natStyle);
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
    });
    if (view !== "nat") devolvedLayer.addTo(map).bringToBack();
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

  Promise.all([
    fetch("data/national.json").then(r => { if (!r.ok) throw new Error("national.json " + r.status); return r.json(); }),
    fetch("data/static/nations.geojson").then(r => { if (!r.ok) throw new Error("nations.geojson " + r.status); return r.json(); }),
    fetch(FLAGS_PATH).then(r => (r.ok ? r.text() : "")).catch(() => ""),
  ]).then(([natData, geo, flagsText]) => {
    national = (natData.consultations || []).map(c => Object.assign({ nations: ["UK"] }, c));
    if (!editing) setFlags(parseCsv(flagsText || "").filter(r => r.id));
    natLoaded = true;
    const gen = natData.generated ? new Date(natData.generated) : null;
    const failed = Object.values(natData.sources || {}).filter(s => !s.ok).map(s => s.label);
    document.getElementById("nat-meta").textContent =
      (gen ? `Updated ${gen.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.` : "") +
      (failed.length ? ` Not refreshed on the last run: ${failed.join(", ")}.` : "");
    natLayer = L.geoJSON(geo, {
      style: natStyle,
      onEachFeature(feature, layer) {
        natLayersByName[feature.properties.name] = layer;
        layer.bindPopup(() => natPopupHtml(feature), { maxWidth: 360, maxHeight: 400 });
        layer.bindTooltip(feature.properties.name, { sticky: true, direction: "top" });
        layer.on("mouseover", () => layer.setStyle({ weight: 3, color: "#1f2933" }));
        layer.on("mouseout", () => natLayer.resetStyle(layer));
      },
    });
    if (view === "nat") { natLayer.addTo(map); renderLists(); updateHash(); }
  }).catch(err => {
    console.warn("National consultations not loaded:", err);
    natLoaded = true;
    if (view === "nat") document.getElementById("lists").innerHTML =
      `<p class="error">Could not load the national consultations (${esc(err.message)}). ` +
      `If this is a new setup, run the "Update local plan data" workflow in the Actions tab.</p>`;
  });

  const VIEWS = ["lpa", "ca", "nat"];
  document.querySelectorAll(".view-toggle button").forEach(btn => {
    btn.addEventListener("click", () => { if (btn.dataset.view !== view) setView(btn.dataset.view); });
    btn.addEventListener("keydown", e => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const i = VIEWS.indexOf(view) + (e.key === "ArrowRight" ? 1 : -1);
        const next = VIEWS[(i + VIEWS.length) % VIEWS.length];
        setView(next);
        document.querySelector(`.view-toggle button[data-view="${next}"]`).focus();
      }
    });
  });
  document.querySelectorAll(".filter-toggle button").forEach(btn => {
    btn.addEventListener("click", () => { natShow = btn.dataset.show; updateHash(); renderLists(); });
  });

  // national list: edit controls and map highlighting
  const listsEl = document.getElementById("lists");
  listsEl.addEventListener("change", onListChange);
  listsEl.addEventListener("click", e => { if (e.target.id === "bulk-not") markRestNotRelevant(); });
  listsEl.addEventListener("mouseover", e => {
    const el = e.target.closest(".item.nat");
    if (el && el.dataset.nat !== listsEl.dataset.hover) {
      listsEl.dataset.hover = el.dataset.nat;
      const c = national.find(x => x.id === el.dataset.nat);
      if (c) highlightNations(c, true);
    }
  });
  listsEl.addEventListener("mouseleave", () => {
    delete listsEl.dataset.hover;
    if (natLayer) natLayer.setStyle(natStyle);
  });

  // editing tERC flags
  const tokenForm = document.getElementById("token-form");
  const tokenError = document.getElementById("token-error");
  document.getElementById("edit-start").addEventListener("click", () => {
    const saved = storedToken();
    if (saved) {
      startEditing(saved).catch(() => { forgetToken(); tokenForm.hidden = false; });
    } else {
      tokenForm.hidden = false;
      document.getElementById("token").focus();
    }
  });
  document.getElementById("token-cancel").addEventListener("click", () => { tokenForm.hidden = true; tokenError.hidden = true; });
  tokenForm.addEventListener("submit", e => {
    e.preventDefault();
    const t = document.getElementById("token").value.trim();
    if (!t) return;
    tokenError.hidden = true;
    startEditing(t).then(() => {
      storeToken(t, document.getElementById("token-remember").checked);
      document.getElementById("token").value = "";
    }).catch(err => {
      token = null;
      tokenError.textContent = `Could not start editing: ${err.message}.`;
      tokenError.hidden = false;
    });
  });
  document.getElementById("save-btn").addEventListener("click", saveFlags);
  document.getElementById("discard-btn").addEventListener("click", () => { pending = {}; updateSaveBar(); refresh(); });
  document.getElementById("edit-stop").addEventListener("click", stopEditing);
  window.addEventListener("beforeunload", e => { if (editing && Object.keys(pending).length) { e.preventDefault(); e.returnValue = ""; } });

  if (view !== "lpa") setView(view);

  document.getElementById("predicted").addEventListener("change", e => { includePredicted = e.target.checked; refresh(); });
  let t;
  document.getElementById("search").addEventListener("input", e => {
    clearTimeout(t);
    t = setTimeout(() => { query = e.target.value.trim().toLowerCase(); renderLists(); }, 150);
  });
})();
