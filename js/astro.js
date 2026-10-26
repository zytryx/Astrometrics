/** Sun / moon altitude and illumination (simplified, good enough for scoring). */
const Astro = (() => {
  const rad = Math.PI / 180;
  const dayMs = 86400000;
  const J1970 = 2440588;
  const J2000 = 2451545;

  function toJulian(date) {
    return date.valueOf() / dayMs - 0.5 + J1970;
  }

  function toDays(date) {
    return toJulian(date) - J2000;
  }

  function rightAscension(l, b) {
    return Math.atan2(Math.sin(l) * Math.cos(23.4397 * rad) - Math.tan(b) * Math.sin(23.4397 * rad), Math.cos(l));
  }

  function declination(l, b) {
    return Math.asin(Math.sin(b) * Math.cos(23.4397 * rad) + Math.cos(b) * Math.sin(23.4397 * rad) * Math.sin(l));
  }

  function azimuth(H, phi, dec) {
    return Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  }

  function altitude(H, phi, dec) {
    return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  }

  function siderealTime(d, lw) {
    return rad * (280.16 + 360.9856235 * d) - lw;
  }

  function solarMeanAnomaly(d) {
    return rad * (357.5291 + 0.98560028 * d);
  }

  function eclipticLongitude(M) {
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const P = rad * 102.9372;
    return M + C + P + Math.PI;
  }

  function sunCoords(d) {
    const M = solarMeanAnomaly(d);
    const L = eclipticLongitude(M);
    return { ra: rightAscension(L, 0), dec: declination(L, 0) };
  }

  function moonCoords(d) {
    const L = rad * (218.316 + 13.176396 * d);
    const M = rad * (134.963 + 13.064993 * d);
    const F = rad * (93.272 + 13.229350 * d);
    const l = L + rad * 6.289 * Math.sin(M);
    const b = rad * 5.128 * Math.sin(F);
    return { ra: rightAscension(l, b), dec: declination(l, b) };
  }

  /** Altitude in degrees for a body at date, lat, lon (degrees). */
  function altitudeDeg(getCoords, date, lat, lon) {
    const lw = rad * -lon;
    const phi = rad * lat;
    const d = toDays(date);
    const c = getCoords(d);
    const H = siderealTime(d, lw) - c.ra;
    return altitude(H, phi, c.dec) / rad;
  }

  function sunAlt(date, lat, lon) {
    return altitudeDeg(sunCoords, date, lat, lon);
  }

  function moonAlt(date, lat, lon) {
    return altitudeDeg(moonCoords, date, lat, lon);
  }

  /** Illuminated fraction 0–1. */
  function moonIllum(date) {
    const d = toDays(date);
    const s = sunCoords(d);
    const m = moonCoords(d);
    const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    const inc = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    const angle = Math.abs(inc);
    return ((1 + Math.cos(phi)) / 2) * (angle < Math.PI / 2 ? 1 : 1);
  }

  /**
   * Horizontal coords (alt, az degrees; az from north through east) for
   * equatorial RA hours and Dec degrees at a given time/site.
   */
  function horizontal(raH, decD, date, lat, lon) {
    const lw = rad * -lon;
    const phi = rad * lat;
    const d = toDays(date);
    const ra = raH * 15 * rad;
    const dec = decD * rad;
    const H = siderealTime(d, lw) - ra;
    const alt = altitude(H, phi, dec) / rad;
    let az = azimuth(H, phi, dec) / rad;
    az = (az + 180) % 360; // 0 = north
    return { alt, az };
  }

  function sunHoriz(date, lat, lon) {
    const d = toDays(date);
    const c = sunCoords(d);
    const lw = rad * -lon;
    const phi = rad * lat;
    const H = siderealTime(d, lw) - c.ra;
    return { alt: altitude(H, phi, c.dec) / rad, az: (azimuth(H, phi, c.dec) / rad + 180) % 360 };
  }

  function moonHoriz(date, lat, lon) {
    const d = toDays(date);
    const c = moonCoords(d);
    const lw = rad * -lon;
    const phi = rad * lat;
    const H = siderealTime(d, lw) - c.ra;
    return { alt: altitude(H, phi, c.dec) / rad, az: (azimuth(H, phi, c.dec) / rad + 180) % 360 };
  }

  return { sunAlt, moonAlt, moonIllum, horizontal, sunHoriz, moonHoriz };
})();
