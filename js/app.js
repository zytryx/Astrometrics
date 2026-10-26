(() => {
  const STORAGE_SITE = "astrometric.site";
  const STORAGE_RED = "astrometric.red";
  const STORAGE_CACHE = "astrometric.cache";

  const state = {
    site: null,
    hours: [],
    nights: [],
    sel: 0,
    selHour: null,
    fetched: null,
    red: false,
    banner: null,
    messier: [],
    messierFilter: "up",
    lp: null,
  };

  const $ = (id) => document.getElementById(id);

  function loadSite() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_SITE) || "null");
    } catch {
      return null;
    }
  }
  function saveSite(site) {
    localStorage.setItem(STORAGE_SITE, JSON.stringify(site));
  }

  function cellColor(score, red) {
    const t = Math.max(0, Math.min(1, score / 100));
    // SkyQuality-like ramp: deep blue → cyan → tan → near white (or red ramp)
    if (red) {
      const stops = [
        [26, 0, 0],
        [77, 11, 6],
        [138, 23, 14],
        [204, 44, 29],
        [255, 106, 85],
      ];
      return lerpStops(stops, 1 - t);
    }
    const stops = [
      [11, 47, 168],
      [47, 127, 230],
      [98, 198, 201],
      [201, 185, 138],
      [238, 240, 242],
    ];
    return lerpStops(stops, 1 - t); // high score = good = blue end
  }

  function lerpStops(stops, t) {
    const x = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const f = x - i;
    const a = stops[i];
    const b = stops[i + 1];
    const r = Math.round(a[0] + (b[0] - a[0]) * f);
    const g = Math.round(a[1] + (b[1] - a[1]) * f);
    const bl = Math.round(a[2] + (b[2] - a[2]) * f);
    return `rgb(${r},${g},${bl})`;
  }

  async function fetchForecast(site) {
    const vars =
      "temperature_2m,dewpoint_2m,relative_humidity_2m,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_gusts_10m,wind_speed_10m,precipitation_probability,visibility,surface_pressure";
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${site.lat.toFixed(4)}&longitude=${site.lon.toFixed(4)}` +
      `&hourly=${vars},wind_speed_250hPa` +
      `&timezone=auto&forecast_days=7`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Forecast HTTP ${res.status}`);
    const j = await res.json();
    const h = j.hourly;
    if (!h?.time?.length) throw new Error("Empty forecast");
    const hours = h.time.map((iso, i) => {
      const t = Date.parse(iso) / 1000;
      const date = new Date(t * 1000);
      const row = {
        t,
        temp: h.temperature_2m[i] ?? 0,
        dew: h.dewpoint_2m[i] ?? 0,
        rh: h.relative_humidity_2m[i] ?? 50,
        cc: h.cloud_cover[i] ?? 0,
        ccl: h.cloud_cover_low[i] ?? 0,
        ccm: h.cloud_cover_mid[i] ?? 0,
        cch: h.cloud_cover_high[i] ?? 0,
        gust: (h.wind_gusts_10m[i] ?? h.wind_speed_10m[i] ?? 0) * 0.621371,
        wind: (h.wind_speed_10m[i] ?? 0) * 0.621371,
        pp: h.precipitation_probability[i] ?? 0,
        vis: h.visibility?.[i],
        pres: h.surface_pressure?.[i],
        jet: h.wind_speed_250hPa?.[i] != null ? h.wind_speed_250hPa[i] * 0.621371 : null,
        sun: Astro.sunAlt(date, site.lat, site.lon),
        moon: Astro.moonAlt(date, site.lat, site.lon),
        illum: Astro.moonIllum(date),
      };
      row.f = Scoring.factors(row);
      row.score = Scoring.score(row.f);
      return row;
    });
    return { hours, fetched: new Date(), timezone: j.timezone };
  }

  async function searchPlaces(q) {
    if (!q || q.length < 2) return [];
    const u = new URL("https://geocoding-api.open-meteo.com/v1/search");
    u.searchParams.set("name", q);
    u.searchParams.set("count", "8");
    u.searchParams.set("language", "en");
    u.searchParams.set("format", "json");
    const res = await fetch(u);
    if (!res.ok) return [];
    const j = await res.json();
    return (j.results || []).map((r) => ({
      name: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
      lat: r.latitude,
      lon: r.longitude,
    }));
  }

  async function fetchKp() {
    try {
      const res = await fetch(
        "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json"
      );
      const j = await res.json();
      const rows = j
        .slice(1)
        .map((r) => ({ t: r[0], kp: parseFloat(r[1]) }))
        .filter((r) => !Number.isNaN(r.kp));
      if (!rows.length) return null;
      const now = Date.now();
      const current =
        [...rows].reverse().find((r) => Date.parse(r.t + "Z") <= now) ||
        rows[rows.length - 1];
      const future = rows.filter((r) => Date.parse(r.t + "Z") >= now);
      const max = future.reduce((a, b) => (b.kp > a.kp ? b : a), future[0] || current);
      return { now: current.kp, max: max.kp, at: max.t };
    } catch {
      return null;
    }
  }

  function buildNights(hours) {
    if (!hours.length) return [];
    const nights = [];
    let i = 0;
    while (i < hours.length) {
      const startIdx = i;
      i++;
      while (i < hours.length) {
        const h0 = new Date(hours[i - 1].t * 1000).getHours();
        const h1 = new Date(hours[i].t * 1000).getHours();
        if (h0 < 12 && h1 >= 12) break;
        i++;
      }
      const slice = hours.slice(startIdx, i);
      if (!slice.length) continue;
      const darkHours = slice.filter((h) => h.sun < -6);
      const use = darkHours.length ? darkHours : slice.filter((h) => h.sun < 0);
      const pool = use.length ? use : slice;
      const score = Math.round(pool.reduce((s, h) => s + h.score, 0) / pool.length);
      let best = null;
      for (let a = 0; a < pool.length; a++) {
        for (let b = a + 2; b < pool.length; b++) {
          const seg = pool.slice(a, b + 1);
          const avg = seg.reduce((s, h) => s + h.score, 0) / seg.length;
          const hoursLen = (seg[seg.length - 1].t - seg[0].t) / 3600 + 1;
          if (!best || avg > best.avg + 0.01) best = { s: seg[0].t, e: seg[seg.length - 1].t, hours: hoursLen, avg };
        }
      }
      nights.push({
        i: nights.length,
        start: slice[0].t,
        end: slice[slice.length - 1].t,
        grid: slice,
        dark: darkHours,
        score,
        best,
      });
      if (nights.length >= 7) break;
    }
    return nights;
  }

  function fmtHour(t) {
    return new Date(t * 1000).toLocaleTimeString(undefined, {
      hour: "numeric",
      hour12: true,
    }).replace(" ", "").toLowerCase();
  }
  function fmtHourShort(t) {
    const d = new Date(t * 1000);
    let h = d.getHours();
    const ap = h >= 12 ? "p" : "a";
    h = h % 12 || 12;
    return h + ap;
  }
  function fmtDay(t) {
    return new Date(t * 1000).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  function ago(date) {
    if (!date) return "";
    const m = Math.round((Date.now() - date.getTime()) / 60000);
    if (m < 2) return "Updated just now";
    if (m < 90) return `Updated ${m} min ago`;
    return `Updated ${Math.round(m / 60)} h ago`;
  }

  function setBanner(msg) {
    state.banner = msg;
    const el = $("banner");
    if (!msg) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function mapTime(night, ref) {
    if (ref) return new Date(ref.t * 1000);
    if (night.dark?.length) return new Date(night.dark[Math.floor(night.dark.length / 2)].t * 1000);
    return new Date(night.start * 1000);
  }

  function project(alt, az, cx, cy, r) {
    if (alt < -1) return null;
    const z = Math.max(0, Math.min(1, (90 - alt) / 90));
    const rad = z * r;
    const a = (az * Math.PI) / 180;
    return { x: cx + rad * Math.sin(a), y: cy - rad * Math.cos(a) };
  }

  function drawSkyMap(night, ref) {
    const canvas = $("skymap");
    if (!canvas || !state.site || !night) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.46;
    const red = state.red;
    const bg = red ? "#000000" : "#03050f";
    const line = red ? "#2b0805" : "#1c2541";
    const muted = red ? "#a8291f" : "#8a94ad";
    const accent = red ? "#ff5b48" : "#9fb6ff";
    const moonCol = red ? "#ff4d3d" : "#e9ecf4";

    ctx.clearRect(0, 0, w, h);

    // Light-pollution field (under everything)
    if (state.lp) {
      const img = ctx.createImageData(w, h);
      const data = img.data;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const dx = px - cx;
          const dy = py - cy;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > R) continue;
          const alt = 90 * (1 - dist / R);
          let az = (Math.atan2(dx, -dy) * 180) / Math.PI;
          if (az < 0) az += 360;
          const b = LightPollution.brightness(state.lp, alt, az);
          const t = Math.min(1, b / 8);
          const i = (py * w + px) * 4;
          if (red) {
            data[i] = Math.round(40 + 180 * t);
            data[i + 1] = Math.round(5 + 30 * t);
            data[i + 2] = Math.round(0 + 20 * t);
          } else {
            data[i] = Math.round(8 + 120 * t);
            data[i + 1] = Math.round(12 + 60 * t);
            data[i + 2] = Math.round(20 + 40 * t);
          }
          data[i + 3] = Math.round(40 + 160 * t);
        }
      }
      ctx.putImageData(img, 0, 0);
      // clip to circle by redrawing outside as bg — mask
      ctx.globalCompositeOperation = "destination-in";
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      // fill outside
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.arc(cx, cy, R, 0, Math.PI * 2, true);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    [30, 60].forEach((alt) => {
      ctx.beginPath();
      ctx.arc(cx, cy, ((90 - alt) / 90) * R, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = muted;
    ctx.font = "14px IBM Plex Sans,system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const labelR = R + 14;
    [
      [0, "N"],
      [90, "E"],
      [180, "S"],
      [270, "W"],
    ].forEach(([az, lab]) => {
      const a = (az * Math.PI) / 180;
      ctx.fillText(lab, cx + labelR * Math.sin(a), cy - labelR * Math.cos(a));
    });

    const date = mapTime(night, ref);
    const { lat, lon } = state.site;

    if (state.messier.length) {
      state.messier.forEach((m) => {
        const horiz = Astro.horizontal(m.ra, m.dec, date, lat, lon);
        const p = project(horiz.alt, horiz.az, cx, cy, R);
        if (!p) return;
        ctx.beginPath();
        ctx.fillStyle = accent;
        ctx.globalAlpha = horiz.alt > 20 ? 0.95 : 0.4;
        ctx.arc(p.x, p.y, m.nb ? 3.5 : 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    }

    const moon = Astro.moonHoriz(date, lat, lon);
    const mp = project(moon.alt, moon.az, cx, cy, R);
    if (mp) {
      ctx.beginPath();
      ctx.fillStyle = moonCol;
      ctx.arc(mp.x, mp.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = muted;
      ctx.font = "11px IBM Plex Sans,system-ui,sans-serif";
      ctx.fillText("Moon", mp.x, mp.y + 16);
    }

    const sun = Astro.sunHoriz(date, lat, lon);
    const sp = project(sun.alt, sun.az, cx, cy, R);
    if (sp && sun.alt > -18) {
      ctx.beginPath();
      ctx.fillStyle = red ? "#b3301f" : "#f0b44c";
      ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    $("skymap-caption").textContent = `Zenith centre · N up · ${date.toLocaleString(undefined, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }

  function messierMaxAlt(m, night) {
    if (!state.site || !night?.grid?.length) return -90;
    let max = -90;
    const step = Math.max(1, Math.floor(night.grid.length / 8));
    for (let i = 0; i < night.grid.length; i += step) {
      const h = night.grid[i];
      if (h.sun > -6) continue;
      const horiz = Astro.horizontal(m.ra, m.dec, new Date(h.t * 1000), state.site.lat, state.site.lon);
      if (horiz.alt > max) max = horiz.alt;
    }
    return max;
  }

  function renderMessier(night, ref) {
    const list = $("messier-list");
    if (!list) return;
    if (!state.messier.length) {
      list.innerHTML = `<div class="messier-row"><span class="messier-name">Loading catalogue…</span></div>`;
      return;
    }
    if (!night || !state.site) {
      list.innerHTML = `<div class="messier-row"><span class="messier-name">Select a site first</span></div>`;
      return;
    }
    const rows = state.messier.map((m) => ({ m, maxAlt: messierMaxAlt(m, night) }));
    const filtered = state.messierFilter === "up" ? rows.filter((r) => r.maxAlt > 10) : rows;
    filtered.sort((a, b) => b.maxAlt - a.maxAlt);
    $("messier-meta").textContent =
      state.messierFilter === "up"
        ? `${filtered.length} objects reach ≥10° altitude during this night`
        : `All 110 Messier objects · sorted by max altitude`;
    list.innerHTML = filtered
      .map(({ m, maxAlt }) => {
        const title = m.name || m.type || "";
        const high = maxAlt >= 40 ? " high" : "";
        return `<div class="messier-row">
          <span class="messier-id">${m.id}</span>
          <span class="messier-name">${escapeHtml(title)}<small>${escapeHtml(m.type || "")}</small></span>
          <span class="messier-alt${high}">${maxAlt > -90 ? maxAlt.toFixed(0) + "°" : "—"}</span>
        </div>`;
      })
      .join("");
  }

  function renderHeatmap(night) {
    const wrap = $("heat-wrap");
    if (!wrap || !night) {
      if (wrap) wrap.innerHTML = "";
      return;
    }
    const hours = night.grid.filter((h) => h.sun < 8);
    const show = hours.length ? hours : night.grid;
    wrap.style.setProperty("--cols", show.length);

    const rows = [
      { key: "score", lab: "Sky score", val: (h) => h.score },
      { key: "cc", lab: "Cloud cover", val: (h) => 100 - h.cc },
      { key: "ccl", lab: "Low", val: (h) => 100 - h.ccl },
      { key: "ccm", lab: "Mid", val: (h) => 100 - h.ccm },
      { key: "cch", lab: "High", val: (h) => 100 - h.cch },
      { key: "pp", lab: "Rain chance", val: (h) => 100 - h.pp },
      { key: "transp", lab: "Transparency", val: (h) => h.f.transp * 100 },
      { key: "seeing", lab: "Seeing", val: (h) => h.f.seeing * 100 },
      { key: "wind", lab: "Wind", val: (h) => h.f.wind * 100 },
      { key: "dark", lab: "Darkness", val: (h) => h.f.dark * 100 },
    ];

    let html = `<div class="heat" style="--cols:${show.length}">`;
    html += `<div class="heat-row"><div class="heat-lab"></div>${show
      .map((h) => `<div class="heat-h">${fmtHourShort(h.t)}</div>`)
      .join("")}</div>`;

    rows.forEach((row) => {
      html += `<div class="heat-row"><div class="heat-lab">${row.lab}</div>`;
      show.forEach((h) => {
        const v = row.val(h);
        const scoreLike = row.key === "score" ? h.score : v;
        const col = cellColor(scoreLike, state.red);
        const sel = state.selHour === h.t ? " sel" : "";
        html += `<div class="cell${sel}" data-t="${h.t}" style="background:${col}" title="${row.lab}: ${Math.round(v)}"></div>`;
      });
      html += `</div>`;
    });
    html += `</div>`;
    wrap.innerHTML = html;

    wrap.querySelectorAll(".cell").forEach((el) => {
      el.addEventListener("click", () => {
        state.selHour = parseFloat(el.dataset.t);
        render();
      });
    });

    // legend
    const leg = $("legend-swatches");
    if (leg) {
      leg.innerHTML = "";
      for (let i = 0; i < 5; i++) {
        const s = document.createElement("span");
        s.style.background = cellColor(100 - i * 25, state.red);
        leg.appendChild(s);
      }
    }

    // readout
    const h = show.find((x) => x.t === state.selHour) || show.find((x) => x.sun < -6) || show[Math.floor(show.length / 2)];
    if (h) {
      state.selHour = h.t;
      const dark =
        h.sun < -18
          ? "astronomical dark"
          : h.sun < -12
            ? "nautical twilight"
            : h.sun < -6
              ? "civil twilight"
              : h.sun < 0
                ? "twilight"
                : "daylight";
      $("hour-readout").innerHTML = `<strong>${fmtDay(h.t)} ${fmtHour(h.t)}</strong> · score <strong>${h.score}</strong> · ${dark}<br>
        Clouds ${Math.round(h.cc)}% (low ${Math.round(h.ccl)}, mid ${Math.round(h.ccm)}, high ${Math.round(h.cch)}) ·
        rain ${Math.round(h.pp)}% ·
        humidity ${Math.round(h.rh)}% ·
        gusts ${Math.round(h.gust)} mph ·
        moon ${h.moon.toFixed(0)}°, ${Math.round(h.illum * 100)}% lit`;
    }
  }

  function renderNightsList() {
    const el = $("nights-list");
    if (!el) return;
    el.innerHTML = state.nights
      .map((n, idx) => {
        const label = idx === 0 ? "Tonight" : idx === 1 ? "Tomorrow" : fmtDay(n.start).split(",")[0];
        const sub = fmtDay(n.start);
        const strip = n.grid
          .filter((h) => h.sun < 0)
          .filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 12)) === 0)
          .map((h) => `<i style="background:${cellColor(h.score, state.red)}"></i>`)
          .join("");
        return `<button type="button" class="night-row${idx === state.sel ? " active" : ""}" data-i="${idx}">
          <span class="nd"><b>${label}</b>${sub}</span>
          <span class="ns">${strip}</span>
          <span class="sc" style="color:${cellColor(n.score, state.red) === cellColor(0, state.red) ? "var(--fg)" : "inherit"}">${n.score}</span>
        </button>`;
      })
      .join("");
    el.querySelectorAll(".night-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.sel = parseInt(btn.dataset.i, 10);
        state.selHour = null;
        render();
      });
    });
  }

  function renderLP() {
    const lp = state.lp;
    if (!lp) {
      $("lp-bortle").textContent = "—";
      $("lp-sqm").textContent = "—";
      $("lp-zenith").textContent = "—";
      $("lp-caption").textContent = "Loading VIIRS night lights…";
      return;
    }
    $("lp-bortle").textContent = String(lp.bortle);
    $("lp-sqm").textContent = lp.sqm.toFixed(1);
    $("lp-zenith").textContent = lp.zenithRatio < 0.15 ? "low" : lp.zenithRatio < 1 ? "mod" : "high";
    $("lp-caption").textContent = `Bortle ${lp.bortle} · SQM ~${lp.sqm.toFixed(1)} mag/arcsec² (zenith, clear)`;
  }

  function render() {
    const site = state.site;
    $("site-name").textContent = site ? site.name : "Choose a site";
    $("site-meta").textContent = site ? (state.fetched ? ago(state.fetched) : "Loading…") : "Tap to search";
    document.body.classList.toggle("red", state.red);
    $("red-btn").setAttribute("aria-pressed", state.red ? "true" : "false");

    const night = state.nights[state.sel];
    if (!night) {
      $("score-num").textContent = "—";
      $("score-num").parentElement.className = "score-big";
      $("verdict").textContent = site ? "Loading forecast…" : "Pick a site to begin";
      $("best-window").textContent = "";
      $("score-strip").innerHTML = "";
      $("nights-list").innerHTML = "";
      $("heat-wrap").innerHTML = "";
      return;
    }

    const label =
      night.i === 0 ? "Tonight" : night.i === 1 ? "Tomorrow night" : `Night of ${fmtDay(night.start)}`;
    $("night-label").textContent = label + " · " + fmtDay(night.start).toUpperCase();

    const sc = night.score;
    $("score-num").textContent = String(sc);
    $("score-num").parentElement.className = "score-big " + Scoring.scoreClass(sc);
    $("verdict").textContent = Scoring.verdict(sc);
    $("best-window").textContent = night.best
      ? `Best window ${fmtHour(night.best.s)}–${fmtHour(night.best.e)}`
      : "";

    const strip = $("score-strip");
    strip.innerHTML = "";
    const step = Math.max(1, Math.floor(night.grid.length / 48));
    for (let i = 0; i < night.grid.length; i += step) {
      const span = document.createElement("span");
      span.style.background = cellColor(night.grid[i].score, state.red);
      strip.appendChild(span);
    }

    renderNightsList();
    renderHeatmap(night);
    renderLP();

    const ref =
      night.grid.find((h) => h.t === state.selHour) ||
      (night.best && night.grid.find((h) => h.t >= night.best.s && h.t <= night.best.e)) ||
      night.dark[Math.floor(night.dark.length / 2)] ||
      night.grid[Math.floor(night.grid.length / 2)];

    if (ref?.f) {
      const set = (id, v) => {
        $(id).style.width = `${Math.round(v * 100)}%`;
      };
      set("f-clouds", ref.f.clouds);
      set("f-transp", ref.f.transp);
      set("f-seeing", ref.f.seeing);
      set("f-wind", ref.f.wind);
      set("f-dark", ref.f.dark);
    }

    drawSkyMap(night, ref);
    renderMessier(night, ref);
  }

  async function loadKp() {
    const kp = await fetchKp();
    const el = $("kp-text");
    if (!kp) {
      el.textContent = "Kp unavailable.";
      return;
    }
    el.textContent = `Planetary K-index now ~${kp.now.toFixed(1)}; forecast peak ~${kp.max.toFixed(1)} (${kp.at}). Higher Kp favors aurora at high latitudes.`;
  }

  async function loadLP(site) {
    state.lp = null;
    renderLP();
    try {
      state.lp = await LightPollution.estimate(site.lat, site.lon);
    } catch (e) {
      console.warn(e);
      $("lp-caption").textContent = "Light pollution estimate unavailable";
    }
    const night = state.nights[state.sel];
    if (night) {
      const ref =
        night.grid.find((h) => h.t === state.selHour) ||
        night.dark[Math.floor(night.dark.length / 2)] ||
        night.grid[0];
      drawSkyMap(night, ref);
      renderLP();
    }
  }

  async function loadForSite(site) {
    state.site = site;
    saveSite(site);
    state.lp = null;
    render();
    setBanner(null);
    loadLP(site);
    try {
      const data = await fetchForecast(site);
      state.hours = data.hours;
      state.nights = buildNights(data.hours);
      state.sel = 0;
      state.selHour = null;
      state.fetched = data.fetched;
      try {
        localStorage.setItem(
          STORAGE_CACHE,
          JSON.stringify({
            site,
            hours: data.hours.map((h) => ({ ...h, f: undefined })),
            fetched: data.fetched.toISOString(),
          })
        );
      } catch {}
      render();
      loadKp();
    } catch (e) {
      setBanner("Could not load forecast: " + (e.message || e));
      try {
        const c = JSON.parse(localStorage.getItem(STORAGE_CACHE) || "null");
        if (c?.site?.lat === site.lat && c.hours?.length) {
          state.hours = c.hours.map((h) => {
            const row = { ...h };
            row.f = Scoring.factors(row);
            row.score = Scoring.score(row.f);
            return row;
          });
          state.nights = buildNights(state.hours);
          state.fetched = new Date(c.fetched);
          setBanner("Showing last saved forecast. " + (e.message || ""));
          render();
        }
      } catch {}
    }
  }

  async function loadMessier() {
    try {
      const res = await fetch("data/messier.json");
      state.messier = await res.json();
      render();
    } catch (e) {
      console.warn(e);
    }
  }

  function openSheet() {
    $("sheet").classList.remove("hidden");
    $("site-search").value = "";
    $("search-results").innerHTML = "";
    setTimeout(() => $("site-search").focus(), 100);
  }
  function closeSheet() {
    $("sheet").classList.add("hidden");
  }

  let searchTimer;
  function onSearchInput() {
    clearTimeout(searchTimer);
    const q = $("site-search").value.trim();
    searchTimer = setTimeout(async () => {
      const list = await searchPlaces(q);
      const ul = $("search-results");
      ul.innerHTML = "";
      list.forEach((p) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.innerHTML = `${escapeHtml(p.name)}<small>${p.lat.toFixed(2)}°, ${p.lon.toFixed(2)}°</small>`;
        b.addEventListener("click", () => {
          closeSheet();
          loadForSite(p);
        });
        li.appendChild(b);
        ul.appendChild(li);
      });
    }, 280);
  }

  $("site-btn").addEventListener("click", openSheet);
  $("sheet-close").addEventListener("click", closeSheet);
  $("sheet-backdrop").addEventListener("click", closeSheet);
  $("site-search").addEventListener("input", onSearchInput);
  $("geo-btn").addEventListener("click", () => {
    if (!navigator.geolocation) {
      setBanner("Geolocation is not available in this browser.");
      return;
    }
    $("geo-btn").textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $("geo-btn").textContent = "Use my location";
        closeSheet();
        loadForSite({
          name: "My location",
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        });
      },
      () => {
        $("geo-btn").textContent = "Use my location";
        setBanner("Could not get your location.");
      },
      { enableHighAccuracy: false, timeout: 15000 }
    );
  });
  document.querySelectorAll(".preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      closeSheet();
      loadForSite({
        name: btn.dataset.name,
        lat: parseFloat(btn.dataset.lat),
        lon: parseFloat(btn.dataset.lon),
      });
    });
  });
  $("red-btn").addEventListener("click", () => {
    state.red = !state.red;
    localStorage.setItem(STORAGE_RED, state.red ? "1" : "0");
    render();
  });
  $("refresh-btn").addEventListener("click", () => {
    if (state.site) loadForSite(state.site);
    else openSheet();
  });
  document.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.messierFilter = btn.dataset.filter || "up";
      render();
    });
  });

  state.red = localStorage.getItem(STORAGE_RED) === "1";
  loadMessier();
  const saved = loadSite();
  if (saved) loadForSite(saved);
  else {
    render();
    openSheet();
  }
})();
