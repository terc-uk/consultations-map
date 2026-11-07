# Local plan consultations map

A map of local plan consultations and timetables in England, built from the government's
[planning data platform](https://www.planning.data.gov.uk/dataset/local-plan).

Each council area on the map is coloured by its most pressing consultation:

| Colour | Meaning |
|---|---|
| Red-orange | Consultation open now |
| Amber | Opens within 6 months |
| Pale yellow | Opens later |
| Blue-grey | Closed in the last 12 months |
| Light grey | Plan data published, no recent consultation |
| White | No local plan data published yet |

Click an area to see its plans, consultation windows and full timetable. The side panel lists
consultations that are open now or opening in the next 12 months. Statuses are worked out in the
browser from today's date, so they stay current between data refreshes.

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
