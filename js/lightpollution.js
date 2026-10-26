/** Light pollution from NASA GIBS VIIRS Night Lights (zoom 8 tiles). */
const LightPollution = (() => {
  const ZOOM = 8;
  const NATURAL_SQM = 22.0;

  function lon2tile(lon, z) {
    return ((lon + 180) / 360) * (1 << z);
  }
  function lat2tile(lat, z) {
    const r = (lat * Math.PI) / 180;
    return (
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z)
    );
  }

  function tileUrl(x, y) {
    const n = 1 << ZOOM;
    const col = ((x % n) + n) % n;
    return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Night_Lights/default/default/GoogleMapsCompatible_Level8/${ZOOM}/${y}/${col}.png`;
  }

  function loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function sampleTile(img) {
    if (!img) return null;
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    try {
      return ctx.getImageData(0, 0, 256, 256).data;
    } catch {
      return null;
    }
  }

  /** Radiance proxy 0–1 from grey×alpha at pixel. */
  function radAt(data, px, py) {
    if (!data) return 0;
    const x = Math.max(0, Math.min(255, px | 0));
    const y = Math.max(0, Math.min(255, py | 0));
    const i = (y * 256 + x) * 4;
    const a = data[i + 3] / 255;
    if (a <= 0) return 0;
    const g = data[i] / 255;
    return g * a;
  }

  /**
   * Estimate zenith ratio, horizon bins (36), bortle, sqm for a site.
   * Walker's-law style: sum radiance * d^-2.5 within ~150 km.
   */
  async function estimate(lat, lon) {
    const tx = lon2tile(lon, ZOOM);
    const ty = lat2tile(lat, ZOOM);
    const ix = Math.floor(tx);
    const iy = Math.floor(ty);
    // 3×3 neighbourhood of tiles
    const tiles = {};
    const jobs = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = ix + dx;
        const y = iy + dy;
        const key = `${x},${y}`;
        jobs.push(
          loadImage(tileUrl(x, y)).then((img) => {
            tiles[key] = sampleTile(img);
          })
        );
      }
    }
    await Promise.all(jobs);

    // metres per pixel at this lat (WebMercator rough)
    const n = 1 << ZOOM;
    const mPerTile = (40075016.68 * Math.cos((lat * Math.PI) / 180)) / n;
    const mPerPx = mPerTile / 256;

    let zenith = 0;
    let near = 0;
    const bins = new Array(36).fill(0);
    const maxR = 150000; // m

    const fx = (tx - ix) * 256;
    const fy = (ty - iy) * 256;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const data = tiles[`${ix + dx},${iy + dy}`];
        if (!data) continue;
        for (let py = 0; py < 256; py += 4) {
          for (let px = 0; px < 256; px += 4) {
            const r = radAt(data, px, py);
            if (r < 0.02) continue;
            const gx = (dx * 256 + px - fx) * mPerPx;
            const gy = (dy * 256 + py - fy) * mPerPx;
            const dist = Math.sqrt(gx * gx + gy * gy);
            if (dist < 200 || dist > maxR) continue;
            const w = r / Math.pow(dist / 1000, 2.5);
            zenith += w;
            if (dist < 10000) near += w;
            // horizon contribution slower falloff
            const az = ((Math.atan2(gx, -gy) * 180) / Math.PI + 360) % 360;
            const bi = Math.min(35, Math.floor(az / 10));
            bins[bi] += r / Math.pow(dist / 1000, 1.5);
          }
        }
      }
    }

    // Scale to order-of-magnitude natural sky units (fitted loosely to known sites)
    const scale = 0.15;
    const zenithRatio = Math.min(40, zenith * scale);
    const horizonScale = 0.08;
    const horizon = bins.map((b) => Math.min(25, b * horizonScale));
    // smooth
    const sm = horizon.map((_, k) => {
      const a = horizon[(k + 35) % 36];
      const b = horizon[k];
      const c = horizon[(k + 1) % 36];
      return 0.25 * a + 0.5 * b + 0.25 * c;
    });

    const sqm = NATURAL_SQM - 2.5 * Math.log10(1 + zenithRatio);
    let bortle = 9;
    if (sqm >= 21.75) bortle = 2;
    else if (sqm >= 21.5) bortle = 3;
    else if (sqm >= 20.5) bortle = 4;
    else if (sqm >= 19.5) bortle = 5;
    else if (sqm >= 18.94) bortle = 6;
    else if (sqm >= 18.38) bortle = 7;
    else if (sqm >= 17.8) bortle = 8;

    return {
      zenithRatio,
      nearShare: zenith > 0 ? near / zenith : 1,
      horizon: sm,
      sqm,
      bortle,
    };
  }

  /** Brightness contribution at alt/az (deg) from LP model. */
  function brightness(lp, alt, az) {
    if (!lp || alt < 0) return 0;
    const z = lp.zenithRatio * Math.pow(Math.sin((Math.max(alt, 5) * Math.PI) / 180), 0.6);
    const bi = Math.min(35, Math.floor(((az % 360) + 360) % 360 / 10));
    const h = lp.horizon[bi] || 0;
    // horizon dome stronger near horizon
    const horizW = Math.pow(Math.max(0, 1 - alt / 35), 1.4);
    return z * 0.35 + h * horizW;
  }

  return { estimate, brightness, NATURAL_SQM };
})();
