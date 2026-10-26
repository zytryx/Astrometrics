(() => {
  const STORAGE_SITE = "astrometric.site";
  const STORAGE_RED = "astrometric.red";
  const STORAGE_CACHE = "astrometric.cache";

  const state = {
    site: null,
    hours: [],
    nights: [],
    sel: 0,
    fetched: null,
    red: false,
    banner: null,
    messier: [],
    messierFilter: "up",
  };

  const $ = (id) => document.getElementById(id);

  // ——— Persistence ———

  function loadSite() {
    try {
      const raw = localStorage.getItem(STORAGE_SITE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveSite(site) {
    localStorage.setItem(STORAGE_SITE, JSON.stringify(site));
  }

  // ——— Open-Meteo ———

  async function fetchForecast(site) {
    const vars =
      "temperature_2m,dewpoint_2m,relative_humidity_2m,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,wind_gusts_10m,wind_speed_10m,precipitation_probability,visibility,surface_pressure";
    // 250 hPa wind as seeing proxy (optional; may be null)
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${site.lat.toFixed(4)}&longitude=${site.lon.toFixed(4)}` +
      `&hourly=${vars},wind_speed_250hPa` +
      `&timezone=auto&forecast_days=7`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Forecast HTTP ${res.status}`);
    const j = await res.json();
    const h = j.hourly;
    if (!h?.time?.length) throw new Error("Empty forecast");

    const offMin = (j.utc_offset_seconds || 0) / 60;
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
        gust: h.wind_gusts_10m[i] ?? h.wind_speed_10m[i] ?? 0,
        wind: h.wind_speed_10m[i] ?? 0,
        pp: h.precipitation_probability[i] ?? 0,
        vis: h.visibility?.[i],
        pres: h.surface_pressure?.[i],
        jet: h.wind_speed_250hPa?.[i] ?? null,
        sun: Astro.sunAlt(date, site.lat, site.lon),
        moon: Astro.moonAlt(date, site.lat, site.lon),
        illum: Astro.moonIllum(date),
      };
      // Open-Meteo wind often in km/h — scoring expects roughly mph-like gust scale (good 10, bad 32).
      // Convert km/h → mph for gust/wind so weights match the iOS app.
      row.gust *= 0.621371;
      row.wind *= 0.621371;
      if (row.jet != null) row.jet *= 0.621371;
      row.f = Scoring.factors(row);
      row.score = Scoring.score(row.f);
      return row;
    });

    return { hours, off: offMin, fetched: new Date(), timezone: j.timezone };
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
      const res = await fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json");
      const j = await res.json();
      // rows: [time_tag, kp, observed, noaa_scale] — first row is header
      const rows = j.slice(1).map((r) => ({ t: r[0], kp: parseFloat(r[1]) })).filter((r) => !Number.isNaN(r.kp));
      if (!rows.length) return null;
      const now = Date.now();
      const current = [...rows].reverse().find((r) => Date.parse(r.t + "Z") <= now) || rows[rows.length - 1];
      const future = rows.filter((r) => Date.parse(r.t + "Z") >= now);
      const max = future.reduce((a, b) => (b.kp > a.kp ? b : a), future[0] || current);
      return { now: current.kp, max: max.kp, at: max.t };
    } catch {
      return null;
    }
  }

  // ——— Nights (noon–noon) ———

  function buildNights(hours) {
    if (!hours.length) return [];
    const nights = [];
    // Group by local calendar day of the hour near midnight: use sun altitude cycle
    // Simpler: split at local noon using UTC hour adjusted by offset — use date string from timestamps
    let i = 0;
    while (i < hours.length) {
      const startIdx = i;
      const startDate = new Date(hours[i].t * 1000);
      // Advance until next local noon-ish: when sun crosses high and day changes
      // Practical approach: nights as consecutive hours where sun < 0 for the bulk, bounded by local midnights
      i++;
      while (i < hours.length) {
        const d0 = new Date(hours[i - 1].t * 1000);
        const d1 = new Date(hours[i].t * 1000);
        // New "night bucket" when local date's noon boundary: hour jumps across 12:00
        const h0 = d0.getHours();
        const h1 = d1.getHours();
        if (h0 < 12 && h1 >= 12) break;
        i++;
      }
      const slice = hours.slice(startIdx, i);
      if (!slice.length) continue;
      const darkHours = slice.filter((h) => h.sun < -6);
      const grid = slice.filter((h) => h.sun < 0 || darkHours.length === 0);
      const use = darkHours.length ? darkHours : grid;
      const score =
        use.length === 0
          ? 0
          : Math.round(use.reduce((s, h) => s + h.score, 0) / use.length);
      // Best continuous window (≥3h of relatively high scores)
      let best = null;
      if (use.length) {
        let runStart = 0;
        for (let a = 0; a < use.length; a++) {
          for (let b = a; b < use.length; b++) {
            const seg = use.slice(a, b + 1);
            if (seg.length < 3) continue;
            const avg = seg.reduce((s, h) => s + h.score, 0) / seg.length;
            const hoursLen = (seg[seg.length - 1].t - seg[0].t) / 3600 + 1;
            if (!best || avg > best.avg + 0.01 || (Math.abs(avg - best.avg) < 0.01 && hoursLen > best.hours)) {
              best = { s: seg[0].t, e: seg[seg.length - 1].t, hours: hoursLen, avg };
            }
          }
        }
      }
      const labelDate = new Date(slice[Math.floor(slice.length / 2)].t * 1000);
      nights.push({
        i: nights.length,
        start: slice[0].t,
        end: slice[slice.length - 1].t,
        grid: slice,
        dark: darkHours,
        score,
        best,
        labelDate,
      });
      if (nights.length >= 6) break;
    }
    return nights;
  }

  // ——— UI ———

  function fmtHour(t) {
    const d = new Date(t * 1000);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function fmtDay(t) {
    return new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
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

  function render() {
    const site = state.site;
    $("site-name").textContent = site ? site.name : "Choose a site";
    $("site-meta").textContent = site
      ? state.fetched
        ? ago(state.fetched)
        : "Loading…"
      : "Tap to search";

    document.body.classList.toggle("red", state.red);
    $("red-btn").setAttribute("aria-pressed", state.red ? "true" : "false");

    const night = state.nights[state.sel];
    if (!night) {
      $("score-num").textContent = "—";
      $("score-num").parentElement.className = "score-big";
      $("verdict").textContent = site ? "Loading forecast…" : "Pick a site to begin";
      $("best-window").textContent = "";
      $("score-strip").innerHTML = "";
      $("nights-tabs").innerHTML = "";
      $("hour-body").innerHTML = "";
      return;
    }

    const label =
      night.i === 0 ? "Tonight" : night.i === 1 ? "Tomorrow night" : `Night of ${fmtDay(night.start)}`;
    $("night-label").textContent = label;

    const sc = night.score;
    $("score-num").textContent = String(sc);
    $("score-num").parentElement.className = "score-big " + Scoring.scoreClass(sc);
    $("verdict").textContent = Scoring.verdict(sc);

    if (night.best) {
      $("best-window").textContent = `Best window ${fmtHour(night.best.s)}–${fmtHour(night.best.e)}`;
    } else {
      $("best-window").textContent = "";
    }

    // Strip
    const strip = $("score-strip");
    strip.innerHTML = "";
    const step = Math.max(1, Math.floor(night.grid.length / 48));
    for (let i = 0; i < night.grid.length; i += step) {
      const span = document.createElement("span");
      span.style.background = Scoring.barColor(night.grid[i].score, state.red);
      strip.appendChild(span);
    }

    // Tabs
    const tabs = $("nights-tabs");
    tabs.innerHTML = "";
    state.nights.forEach((n, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent =
        idx === 0 ? `Tonight · ${n.score}` : idx === 1 ? `Tomorrow · ${n.score}` : `${fmtDay(n.start)} · ${n.score}`;
      if (idx === state.sel) b.classList.add("active");
      b.addEventListener("click", () => {
        state.sel = idx;
        render();
      });
      tabs.appendChild(b);
    });

    // Hour table — focus on evening/night hours
    const body = $("hour-body");
    body.innerHTML = "";
    const rows = night.grid.filter((h) => h.sun < 6);
    const show = rows.length ? rows : night.grid;
    let bestStart = night.best?.s;
    let bestEnd = night.best?.e;
    show.forEach((h) => {
      const tr = document.createElement("tr");
      if (bestStart != null && h.t >= bestStart && h.t <= bestEnd) tr.classList.add("best");
      const pill = `<span class="pill" style="background:${Scoring.barColor(h.score, state.red)};color:${state.red ? "#000" : "#070b16"}">${h.score}</span>`;
      tr.innerHTML = `
        <td>${fmtHour(h.t)}</td>
        <td>${pill}</td>
        <td>${Math.round(h.cc)}%</td>
        <td>${Math.round(h.rh)}%</td>
        <td>${Math.round(h.gust)}</td>
        <td>${h.sun.toFixed(0)}°</td>
        <td>${h.moon.toFixed(0)}°</td>`;
      body.appendChild(tr);
    });

    // Factors from median dark hour or best hour
    const ref =
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

  /** Map time used for sky: mid-dark of night, or middle of grid. */
  function mapTime(night, ref) {
    if (ref) return new Date(ref.t * 1000);
    if (night.dark?.length) {
      const mid = night.dark[Math.floor(night.dark.length / 2)];
      return new Date(mid.t * 1000);
    }
    return new Date(night.start * 1000);
  }

  /** Stereographic-ish: zenith centre, horizon circle, N up. */
  function project(alt, az, cx, cy, r) {
    if (alt < -1) return null;
    const z = Math.max(0, Math.min(1, (90 - alt) / 90));
    const rad = z * r;
    const a = ((az - 0) * Math.PI) / 180; // 0 = north
    // x east, y south in math; canvas y down → north is up means -cos
    const x = cx + rad * Math.sin(a);
    const y = cy - rad * Math.cos(a);
    return { x, y };
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
    const muted = red ? "#86231a" : "#8a94ad";
    const accent = red ? "#dc4230" : "#9fb6ff";
    const moonCol = red ? "#d23a2a" : "#e9ecf4";

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    // Altitude rings
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    [30, 60].forEach((alt) => {
      const rad = ((90 - alt) / 90) * R;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
    });
    // Horizon
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // Cardinals
    ctx.fillStyle = muted;
    ctx.font = "14px system-ui,sans-serif";
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

    // Messier dots
    if (state.messier.length) {
      state.messier.forEach((m) => {
        const horiz = Astro.horizontal(m.ra, m.dec, date, lat, lon);
        const p = project(horiz.alt, horiz.az, cx, cy, R);
        if (!p) return;
        ctx.beginPath();
        ctx.fillStyle = accent;
        ctx.globalAlpha = horiz.alt > 20 ? 0.95 : 0.45;
        ctx.arc(p.x, p.y, m.nb ? 3.5 : 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      });
    }

    // Moon
    const moon = Astro.moonHoriz(date, lat, lon);
    const mp = project(moon.alt, moon.az, cx, cy, R);
    if (mp) {
      ctx.beginPath();
      ctx.fillStyle = moonCol;
      ctx.arc(mp.x, mp.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = muted;
      ctx.font = "11px system-ui,sans-serif";
      ctx.fillText("Moon", mp.x, mp.y + 16);
    }

    // Sun (if up / twilight)
    const sun = Astro.sunHoriz(date, lat, lon);
    const sp = project(sun.alt, sun.az, cx, cy, R);
    if (sp && sun.alt > -18) {
      ctx.beginPath();
      ctx.fillStyle = red ? "#9a2a1b" : "#f0b44c";
      ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
      ctx.fill();
    }

    $("skymap-caption").textContent =
      `Zenith centre · N up · ${date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
  }

  function messierMaxAlt(m, night) {
    if (!state.site || !night?.grid?.length) return -90;
    let max = -90;
    // Sample a few hours for speed
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

    const date = mapTime(night, ref);
    const rows = state.messier.map((m) => {
      const maxAlt = messierMaxAlt(m, night);
      const now = Astro.horizontal(m.ra, m.dec, date, state.site.lat, state.site.lon);
      return { m, maxAlt, nowAlt: now.alt };
    });

    const filtered =
      state.messierFilter === "up" ? rows.filter((r) => r.maxAlt > 10) : rows.slice();
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

  async function loadMessier() {
    try {
      const res = await fetch("data/messier.json");
      state.messier = await res.json();
      const night = state.nights[state.sel];
      if (night) {
        const ref =
          (night.best && night.grid.find((h) => h.t >= night.best.s && h.t <= night.best.e)) ||
          night.dark[Math.floor(night.dark.length / 2)] ||
          night.grid[Math.floor(night.grid.length / 2)];
        drawSkyMap(night, ref);
        renderMessier(night, ref);
      }
    } catch (e) {
      console.warn("Messier catalogue failed", e);
    }
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

  async function loadForSite(site, { fromCache = false } = {}) {
    state.site = site;
    saveSite(site);
    render();
    setBanner(null);

    try {
      const data = await fetchForecast(site);
      state.hours = data.hours;
      state.nights = buildNights(data.hours);
      state.sel = 0;
      state.fetched = data.fetched;
      try {
        localStorage.setItem(
          STORAGE_CACHE,
          JSON.stringify({ site, hours: data.hours.map((h) => ({ ...h, f: undefined })), fetched: data.fetched.toISOString() })
        );
      } catch { /* quota */ }
      render();
      loadKp();
    } catch (e) {
      setBanner("Could not load forecast: " + (e.message || e));
      // try cache
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
      } catch { /* ignore */ }
    }
  }

  // ——— Sheet ———

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

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ——— Events ———

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
      const night = state.nights[state.sel];
      if (night) {
        const ref =
          (night.best && night.grid.find((h) => h.t >= night.best.s && h.t <= night.best.e)) ||
          night.dark[Math.floor(night.dark.length / 2)] ||
          night.grid[Math.floor(night.grid.length / 2)];
        renderMessier(night, ref);
      }
    });
  });

  // ——— Boot ———

  state.red = localStorage.getItem(STORAGE_RED) === "1";
  loadMessier();
  const saved = loadSite();
  if (saved) {
    loadForSite(saved);
  } else {
    render();
    openSheet();
  }
})();
