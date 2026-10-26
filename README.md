# Astrometric (web)

Static web version of the [Astrometric](https://github.com/) observing planner — same scoring idea as the iOS app: clouds, transparency, seeing, wind, and darkness combined into a 0–100 night score.

**Live data:** [Open-Meteo](https://open-meteo.com/) (weather + geocoding), [NOAA SWPC](https://www.swpc.noaa.gov/) (Kp). Sun/moon altitude is calculated in the browser.

## Run locally

Any static server:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Open `http://localhost:8080`.

## Host on GitHub Pages

1. Create a new GitHub repository (e.g. `astrometric` or `astrometric-web`).
2. Upload these files to the **root** of the default branch (`main` or `master`):
   - `index.html`
   - `css/`
   - `js/`
   - `README.md` (optional)
3. Repo **Settings → Pages**:
   - **Source:** Deploy from a branch
   - **Branch:** `main` (or `master`), folder **/ (root)**
4. Save. After a minute, the site is at:
   ```
   https://<your-username>.github.io/<repo-name>/
   ```

### Project site vs user site

| Type | Repo name | URL |
|------|-----------|-----|
| Project site | any name, e.g. `astrometric-web` | `https://USER.github.io/astrometric-web/` |
| User site | `USER.github.io` | `https://USER.github.io/` |

All asset paths in this project are **relative** (`css/…`, `js/…`), so both work without changes.

## Features

- Site search (Open-Meteo geocoding) and “use my location”
- 7-day hourly forecast → nightly scores and hour table
- Best observing window highlight
- Factor breakdown (clouds, transparency, seeing, wind, darkness)
- **Sky map** — zenith-centred view with Messier objects, Moon, horizon, N/E/S/W
- **Messier list** — all 110 objects with max altitude for the selected night
- Planetary K-index
- Red (night-vision) mode
- Last site + theme remembered in `localStorage`

## Not ported from iOS

Light-pollution domes, satellite mosaic, NGC/IC search, widgets, and push alerts stay on the native app.

## License / data

Weather © Open-Meteo contributors; Kp © NOAA SWPC. Scoring logic aligned with the Astrometric iOS app.
