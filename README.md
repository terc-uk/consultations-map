# Local plan consultations map

A map of local plan consultations and timetables in England, built from the government's
[planning data platform](https://www.planning.data.gov.uk/dataset/local-plan).

Each council area on the map is coloured by its most pressing consultation:

| Colour | Meaning |
|---|---|
| Orange, heavy outline | Consultation open now |
| Dark blue | Opens within 6 months |
| Light blue | Opens later |
| Mid grey | Closed in the last 12 months |
| Pale grey | Plan data published, no recent consultation |
| White | No local plan data published yet |

The colours are chosen to stay distinguishable with red-green colour blindness
(protanopia and deuteranopia): they differ by hue on an orange-blue axis and by lightness,
and open consultations also get a heavy outline so they never rely on colour alone.

Click an area to see its plans, consultation windows and full timetable. The side panel lists
consultations that are open now or opening in the next 12 months. Statuses are worked out in the
browser from today's date, so they stay current between data refreshes.

## Scotland and Wales

There is no national dataset of local plan timetables for Scotland or Wales, so these areas
are shown with a dashed outline and a link to each planning authority's local development plan
page instead of consultation dates. National park authorities (Cairngorms, Loch Lomond and The
Trossachs, Eryri, Pembrokeshire Coast, Bannau Brycheiniog) are listed in the popups of the council
areas they overlap.

The links live in `data/static/scotland-wales-plans.csv`, which you can edit directly on GitHub
(open the file, click the pencil icon, change a link, commit). Columns:

| Column | Meaning |
|---|---|
| `code` | Council area code used by the boundary file (do not change) |
| `link` | URL to show |
| `link_type` | `plan_page` for a local development plan page, `council_homepage` for a homepage placeholder |
| `note` | Optional short note shown in the popup, e.g. joint plan arrangements |
| `overlaps` | National parks only: council codes the park overlaps, separated by `;` |

Rows marked `council_homepage` are placeholders waiting for a proper plan page link.
Boundaries are in `data/static/scotland-wales-councils.geojson` (2013 council areas, simplified)
and do not change with the daily data refresh.

## Combined authorities view (spatial development strategies)

The toggle at the top of the side panel switches between **Local authorities** (the local plan
map described above) and **Combined authorities**. The second view shows each combined, mayoral or
strategic authority, coloured by the status of consultations on its spatial development strategy
(SDS), using the same colours as the local plan view. Council boundaries are drawn as thin outlines
for orientation; areas outside a combined authority are left unshaded. You can link straight to
this view with `#view=ca` at the end of the address.

There is no national dataset of SDS timetables, so this layer is maintained by hand in two CSV
files you can edit on GitHub, like the Scotland and Wales links:

`data/static/strategic-authorities.csv`: one row per authority.

| Column | Meaning |
|---|---|
| `id` | Short identifier used to link consultations (do not change) |
| `name` | Name shown on the map |
| `authority_type` | For example "Mayoral combined authority" |
| `sds_name`, `link` | SDS title and the page it links to |
| `status` | One-line summary of where the SDS has got to |
| `next_step` | The next published stage, with dates where known |
| `note` | Optional extra note |
| `members` | Local planning authority codes (from `data/lpas.geojson`), separated by `;` |

`data/static/sds-consultations.csv`: one row per consultation.

| Column | Meaning |
|---|---|
| `authority` | The `id` from the authorities file |
| `kind` | `sds` for an SDS consultation, `related` for another strategic plan led with the authority (shown in the popup but not used for the colour) |
| `label` | Name of the consultation |
| `start`, `end` | Dates as `YYYY-MM-DD` |
| `url` | Consultation page |
| `note` | Optional short note |

Combined authority boundaries are built from the member council areas by
`scripts/build_strategic_areas.py`, which writes `data/strategic-authorities.geojson`. National
park land is split between the surrounding councils so the shapes have no holes. The workflow
rebuilds the boundaries every day and whenever the authorities CSV changes.

The Planning and Infrastructure Act 2025 makes SDSs a duty for strategic planning authorities from
26 November 2026, so most authorities have not yet published SDS timetables. The London Plan is
London's SDS under the Greater London Authority Act 1999.

## How it works

```
GitHub Action (daily)                    GitHub Pages (static site)
scripts/fetch_data.py  ──writes──▶  data/plans.json      ──read by──▶  index.html + app.js
  calls planning.data.gov.uk         data/lpas.geojson                  (Leaflet map)
```

There is no server. The Action fetches the data, simplifies the boundaries and commits the two
data files to the repository. GitHub Pages serves the site.

### Datasets used

| Dataset | Used for |
|---|---|
| `local-plan` and `plan` | Plan names, links, plan period, adoption date, housing figure, which areas each plan covers |
| `plan-timetable` | Current timetable events (new plan-making system) |
| `local-plan-timetable` | Older timetable events (dataset retired January 2026 but still read) |
| `local-planning-authority` | Boundaries, joined on GSS code |

Consultation windows are made by pairing each `...consultation-start` event with its
matching `...consultation-end` event (Reg 18, Reg 19, scoping, plan content and evidence,
proposed plan, main modifications and additional consultations). Where a council has only
published a predicted date, the window is marked "predicted"; you can hide these with the
checkbox. Where no closing date is published, the map assumes six weeks.

## Setting it up on GitHub Pages (about 10 minutes, free)

1. **Create a GitHub account** at github.com if you don't have one.
2. **Create a new public repository**, for example `local-plan-map`. Tick "Add a README" so it
   isn't empty.
3. **Upload the files.** On the repository page click **Add file > Upload files**, drag in
   everything from this folder (including the `.github` and `scripts` folders) and click
   **Commit changes**.
   - Tip: the `.github` folder is hidden on some computers. On a Mac press
     `Cmd + Shift + .` in Finder to show it. If drag-and-drop skips it, create the file by hand:
     **Add file > Create new file**, name it `.github/workflows/update-data.yml` and paste
     the contents in.
4. **Let the workflow push data.** Go to **Settings > Actions > General**, scroll to
   "Workflow permissions", choose **Read and write permissions** and save.
5. **Run the first data fetch.** Go to the **Actions** tab, choose **Update local plan data**,
   click **Run workflow**. It takes a few minutes. When it goes green you'll see a new `data/`
   folder in the repository.
6. **Turn on Pages.** Go to **Settings > Pages**. Under "Build and deployment" choose
   **Deploy from a branch**, branch **main**, folder **/ (root)**, and save.
7. After a minute or two the site will be live at
   `https://YOUR-USERNAME.github.io/local-plan-map/`.

The data then refreshes every morning at about 05:17 UTC, and only creates a commit when
something actually changed.

### Using your own domain (optional)

Buy a domain, add a `CNAME` DNS record pointing to `YOUR-USERNAME.github.io`, then enter the
domain under **Settings > Pages > Custom domain** and tick **Enforce HTTPS**.

## Running it on your own computer

You need Python 3.

```bash
pip install requests shapely
python scripts/fetch_data.py         # writes data/plans.json and data/lpas.geojson
python scripts/build_strategic_areas.py   # writes data/strategic-authorities.geojson
python -m http.server 8000           # then open http://localhost:8000
```

Opening `index.html` directly from the file system won't work, because browsers block
`fetch()` from `file://` pages. Use the local server above.

## Caveats

- The planning data platform describes this data as incomplete. Only some councils publish
  local plan timetables so far, so a white or grey area does not mean nothing is happening.
- Predicted dates come from Local Development Schemes and often slip.
- Always check consultation dates on the council's own website before relying on them.

## Ideas for later

- Add GOV.UK national consultations (the GOV.UK search API, filtered to `open_consultation`).
- An RSS or email alert when a new consultation opens in chosen areas.
- Extra layers from the platform: conservation areas, brownfield land, Article 4 directions.

## Licence and attribution

Data: planning.data.gov.uk, Open Government Licence v3.0, © Crown copyright and database right.
Map tiles: © OpenStreetMap contributors.
Scotland and Wales boundaries: Martin Chorley, [UK-GeoJSON](https://github.com/martinjc/UK-GeoJSON)
(CC BY 4.0). Contains Ordnance Survey data © Crown copyright and database right 2014.
