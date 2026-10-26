/** Same weights as the iOS / original web app. */
const Scoring = (() => {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  function lin(x, good, bad) {
    return clamp((x - bad) / (good - bad), 0, 1);
  }

  function factors(h) {
    const cloudEff = Math.max(h.cc, h.ccl * 1.15, h.pp > 60 ? 80 : 0);
    const clouds = Math.pow(1 - clamp(cloudEff, 0, 100) / 100, 1.4);
    const transp = lin(h.rh, 45, 97);
    const seeing = h.jet != null ? lin(h.jet, 20, 100) : 0.6;
    const wind = lin(h.gust, 10, 32);
    let dark = h.sun > -6 ? 0 : h.sun > -18 ? 0.25 + (0.5 * (-6 - h.sun)) / 12 : 1;
    if (h.moon > 0) {
      dark *= 1 - h.illum * (0.55 + 0.4 * Math.min(h.moon / 40, 1));
    }
    return { clouds, transp, seeing, wind, dark };
  }

  function score(f) {
    return Math.round(100 * f.clouds * (0.3 * f.transp + 0.22 * f.seeing + 0.13 * f.wind + 0.35 * f.dark));
  }

  function verdict(s) {
    if (s >= 75) return "Excellent night";
    if (s >= 55) return "Good night";
    if (s >= 35) return "Patchy night";
    return "Poor night";
  }

  function scoreClass(s) {
    if (s >= 75) return "good";
    if (s >= 55) return "ok";
    if (s >= 35) return "warn";
    return "bad";
  }

  function barColor(s, red) {
    const t = clamp(s / 100, 0, 1);
    if (red) {
      const r = 0.2 + (0.86 - 0.2) * t;
      const g = 0.03 + (0.38 - 0.03) * t;
      const b = 0.02 + (0.31 - 0.02) * t;
      return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
    }
    const r = 0.12 + 0.49 * t;
    const g = 0.16 + 0.49 * t;
    const b = 0.32 + 0.42 * t;
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  }

  return { factors, score, verdict, scoreClass, barColor, clamp };
})();
