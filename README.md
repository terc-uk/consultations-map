# Consultations map

Live at https://terc-uk.github.io/consultations-map/

A map of local plan consultations and timetables in England, built from the government's
[planning data platform](https://www.planning.data.gov.uk/dataset/local-plan), with views for
combined authority spatial development strategies and for national consultations across the UK.

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

## National consultations view

The third button, **National**, lists consultations and calls for evidence from national bodies
across the UK. You can link straight to it with `#view=national` (add `&show=all` to open the full
list rather than the tERC selection). The data is collected every morning by
`scripts/fetch_national.py` into `data/national.json`:

| Source | Covers | Nation tag |
|---|---|---|
| GOV.UK search and content APIs | UK Government departments and agencies (consultations and calls for evidence) | UK, or the nations the page says it applies to (for example England) |
| consult.gov.scot (Citizen Space API) | Scottish Government | Scotland |
| yourviews.parliament.scot (Citizen Space API) | Scottish Parliament committees | Scotland |
| gov.wales/consultations | Welsh Government | Wales |
| northernireland.gov.uk/consultations | Northern Ireland Executive departments | Northern Ireland |
| UK Parliament committees API | Commons and Lords committee calls for written evidence | UK |

Senedd and Northern Ireland Assembly committee consultations are not included: their sites do not
offer a feed the fetcher can read. Each run looks back 120 days for recently closed consultations
and keeps anything it has seen before, so closed consultations stay listed for a year after they
close (and for as long as tERC has them flagged). If one source fails, its earlier records are kept
and the panel says which source was not refreshed. Consultations first seen in the last week are
tagged "new".

The list has three filters: **Relevant to tERC**, **All** and **Not relevant**. The map colours each
nation by the consultations in the current filter that apply to it (UK-wide ones count for all
four), using the same colours as the other views.

### Marking consultations as relevant, and recording responses

tERC's flags live in `data/static/national-terc.csv`. A consultation is relevant to tERC if it has
a row in this file.

| Column | Meaning |
|---|---|
| `id` | The consultation's web address without `https://` and `www.`, for example `gov.uk/government/consultations/founders-relief-technical-consultation` |
| `title` | The consultation title, to make the file readable (not used for matching) |
| `responded` | Optional. Date tERC sent its response, as `YYYY-MM-DD`. Shows the "✓ tERC responded" tag |
| `link` | Optional. A public link to the response, if tERC publishes it |

The easiest way to edit it is on the map itself:

1. Create a token at GitHub > Settings > Developer settings > **Fine-grained personal access
   tokens** > Generate new token. Set **Resource owner** to `terc-uk`, **Repository access** to
   *Only select repositories* > `consultations-map`, and under **Repository permissions** set
   **Contents** to *Read and write*. Choose an expiry date. (An organisation owner may need to
   approve tokens for `terc-uk`.)
2. On the map, open **National**, choose **All**, click **Edit tERC flags** and paste the token.
   Tick "Remember on this browser" only on your own computer.
3. Tick **Relevant to tERC** on the consultations that matter. To record a response, fill in the
   **Responded** date (this also marks it as relevant).
4. Click **Save to GitHub**. This commits the changes to `national-terc.csv` in one go; the public
   map shows them within a few minutes.

The token stays in your browser and is only sent to api.github.com. You can also edit the CSV
directly on GitHub like the other files. Everything in it is public, so do not add response text,
internal notes or links to private documents.

## Consultations tERC has responded to

This section covers local plans and spatial development strategies. National consultations use
`national-terc.csv` instead (see above).

When tERC responds to a consultation, add a row to `data/static/terc-responses.csv` (open it on
GitHub, click the pencil icon, add a line, commit). The map then shows a "✓ tERC responded" tag
with the date next to that consultation, in the popup and in the side list.

| Column | Meaning |
|---|---|
| `plan` | The plan reference, shown at the bottom of "Full timetable" in the area's popup (for example `city-of-york-council-new-local-plan`). For a spatial development strategy, use the authority `id` from `strategic-authorities.csv` |
| `stage` | The consultation, either as shown on the map (for example `Scoping consultation`) or as a stage code (`scoping-consultation`). For SDS consultations use the `label` from `sds-consultations.csv` |
| `start` | Optional. The consultation's opening date as `YYYY-MM-DD`, only needed if the same stage runs more than once for a plan |
| `responded` | Date tERC sent its response, as `YYYY-MM-DD` |
| `link` | Optional. A public link to the response, if tERC chooses to publish it. The tag becomes a link |

This file is public, like everything else in the repository. Do not put response text, internal
notes or links to private documents in it, and remember that removing something later does not
remove it from the repository's history.

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
2. **Create a new public repository**, for example `consultations-map`. Tick "Add a README" so it
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
   `https://YOUR-USERNAME.github.io/consultations-map/`.

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
python scripts/fetch_national.py     # writes data/national.json
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

- An RSS or email alert when a new consultation opens in chosen areas.
- Extra layers from the platform: conservation areas, brownfield land, Article 4 directions.

## Licence and attribution

Data: planning.data.gov.uk, Open Government Licence v3.0, © Crown copyright and database right.
Map tiles: © OpenStreetMap contributors.
Scotland and Wales boundaries: Martin Chorley, [UK-GeoJSON](https://github.com/martinjc/UK-GeoJSON)
(CC BY 4.0). Contains Ordnance Survey data © Crown copyright and database right 2014.
Northern Ireland boundary (in `data/static/nations.geojson`, built once by `scripts/build_nations.py`):
same source, contains LPS Intellectual Property © Crown copyright and database right 2016.
National consultations: GOV.UK, gov.scot, gov.wales and northernireland.gov.uk content under the
Open Government Licence v3.0; UK and Scottish Parliament content under the Open Parliament Licence.
