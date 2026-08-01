// lib/share-card.js
// ─────────────────────────────────────────────────────────────────────────────
// "Share metrics": renders a point-in-time snapshot of a lift's e1RM trend
// to a canvas, in the Bone & Ember palette, for the user to push wherever
// THEY choose via the Web Share API. Deliberately not-social: a one-way
// export, no account linking, no backend — the artifact is generated
// entirely on-device from local data.
//
// Canvas 2D only (no deps, no assets). 1080×1350 (4:5 portrait) — the size
// share sheets and feeds treat kindly. Colours mirror lib/tokens.js; kept
// as literals because canvas can't consume CSS vars. The card always
// renders in the LIGHT identity — ink on bone — regardless of the viewer's
// mode: it's print, not screen.
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  ground: "#F2E9E3",
  ink: "#241C19",
  ink2: "#6A5B54",
  ink3: "#9C8B83",
  rule: "#E0D2C9",
  ramp: ["#E3CFC6", "#D3A492", "#C07B63", "#A65340", "#82301F"],
  oxide: "#A65340",
};

// Font stacks: the card carries the app's actual typefaces (Bodoni Moda
// display, Familjen Grotesk text, Spline Sans Mono numbers). next/font
// scopes the family names, so resolve them from the CSS vars at runtime.
// Canvas silently ignores an invalid ctx.font assignment, so an empty var
// can't break rendering: `font()` below sets the fallback first, then
// attempts the upgrade.
const SERIF_TAIL = "'Bodoni MT', 'Didot', Georgia, serif";
const SANS_TAIL = "-apple-system, system-ui, sans-serif";
const MONO_TAIL = "ui-monospace, 'SF Mono', Menlo, monospace";
function fontStacks() {
  const css = getComputedStyle(document.documentElement);
  const displayVar = css.getPropertyValue("--font-bodoni").trim();
  const textVar = css.getPropertyValue("--font-familjen").trim();
  const monoVar = css.getPropertyValue("--font-spline").trim();
  return {
    display: displayVar ? `${displayVar}, ${SERIF_TAIL}` : SERIF_TAIL,
    text: textVar ? `${textVar}, ${SANS_TAIL}` : SANS_TAIL,
    mono: monoVar ? `${monoVar}, ${MONO_TAIL}` : MONO_TAIL,
  };
}

// series: [{ date: "YYYY-MM-DD", est1RM: kg, ... }, ...] (ascending) —
// the exact shape lib/analytics.js mainLiftTrend emits.
// Async only for document.fonts.ready — the canvas must not rasterise the
// faces before they've loaded.
export async function renderShareCard({ lift, series }) {
  try { await document.fonts?.ready; } catch { /* draw with what we have */ }
  const { display, text, mono } = fontStacks();
  const W = 1080, H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const font = (spec, stack, tail) => {
    ctx.font = `${spec} ${tail}`;
    if (stack !== tail) ctx.font = `${spec} ${stack}`;
  };

  // Bone ground — flat. Softness lives in tone and space, not texture the
  // canvas would have to fake.
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, W, H);

  const PAD = 96;

  // Wordmark + header — sentence case, no letterspaced caps.
  ctx.fillStyle = C.ink2;
  font("500 34px", text, SANS_TAIL);
  ctx.fillText("Heatwayve", PAD, PAD + 24);

  ctx.fillStyle = C.ink3;
  font("400 30px", text, SANS_TAIL);
  ctx.fillText("Estimated 1RM", PAD, PAD + 116);

  // The lift — the noun that matters, in the display voice.
  ctx.fillStyle = C.ink;
  font("400 88px", display, SERIF_TAIL);
  ctx.fillText(lift, PAD, PAD + 224);

  // Headline number: latest value + delta across the series. Measured →
  // mono.
  const latest = series[series.length - 1]?.est1RM ?? 0;
  const first = series[0]?.est1RM ?? latest;
  const delta = Math.round((latest - first) * 10) / 10;

  ctx.fillStyle = C.ink;
  font("300 170px", mono, MONO_TAIL);
  const numText = `${latest}`;
  ctx.fillText(numText, PAD, PAD + 434);
  const numW = ctx.measureText(numText).width;
  ctx.fillStyle = C.ink3;
  font("400 52px", text, SANS_TAIL);
  ctx.fillText("kg", PAD + numW + 20, PAD + 434);

  ctx.fillStyle = delta >= 0 ? C.oxide : C.ink3;
  font("400 42px", mono, MONO_TAIL);
  ctx.fillText(
    `${delta >= 0 ? "+" : ""}${delta} kg over ${series.length} session${series.length === 1 ? "" : "s"}`,
    PAD, PAD + 522
  );

  // Trend line — the artifact's centrepiece. The stroke heats along its
  // own length: the line literally warms as it climbs the card.
  const chart = { x: PAD, y: 760, w: W - PAD * 2, h: 330 };
  const vals = series.map(s => s.est1RM);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const px = (i) => chart.x + (series.length === 1 ? chart.w / 2 : (i / (series.length - 1)) * chart.w);
  const py = (v) => chart.y + chart.h - ((v - min) / span) * chart.h;

  // Soft fill under the line — oxide fading to nothing.
  if (series.length > 1) {
    const fill = ctx.createLinearGradient(0, chart.y, 0, chart.y + chart.h + 60);
    fill.addColorStop(0, "rgba(166,83,64,0.16)");
    fill.addColorStop(1, "rgba(166,83,64,0)");
    ctx.beginPath();
    ctx.moveTo(px(0), py(vals[0]));
    vals.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(px(vals.length - 1), chart.y + chart.h + 60);
    ctx.lineTo(px(0), chart.y + chart.h + 60);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  const stroke = ctx.createLinearGradient(chart.x, 0, chart.x + chart.w, 0);
  stroke.addColorStop(0, C.ramp[1]);
  stroke.addColorStop(0.6, C.ramp[2]);
  stroke.addColorStop(1, C.ramp[3]);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  vals.forEach((v, i) => (i === 0 ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v))));
  ctx.stroke();

  // End-point dot
  ctx.fillStyle = C.oxide;
  ctx.beginPath();
  ctx.arc(px(vals.length - 1), py(vals[vals.length - 1]), 10, 0, Math.PI * 2);
  ctx.fill();

  // Date range under the chart — measured values, mono.
  ctx.fillStyle = C.ink3;
  font("400 26px", mono, MONO_TAIL);
  const fmt = (d) => {
    const [, m, day] = d.split("-");
    return `${day}/${m}`;
  };
  if (series[0]?.date) ctx.fillText(fmt(series[0].date), chart.x, chart.y + chart.h + 110);
  if (series.length > 1 && series[series.length - 1]?.date) {
    const t = fmt(series[series.length - 1].date);
    ctx.fillText(t, chart.x + chart.w - ctx.measureText(t).width, chart.y + chart.h + 110);
  }

  // Footer — hairline rule, plain declaratives.
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, H - 150);
  ctx.lineTo(W - PAD, H - 150);
  ctx.stroke();
  ctx.fillStyle = C.ink2;
  font("400 32px", text, SANS_TAIL);
  ctx.fillText("Train with intention.", PAD, H - 84);
  ctx.fillStyle = C.ink3;
  font("400 28px", text, SANS_TAIL);
  const site = "heatwayve.app";
  ctx.fillText(site, W - PAD - ctx.measureText(site).width, H - 84);

  return canvas;
}

// Share the canvas via the Web Share API (files), falling back to a plain
// PNG download where share-with-files isn't available (desktop Safari,
// Firefox). Returns "shared" | "downloaded" | "failed".
export async function shareCanvas(canvas, filename) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) return "failed";
  const file = new File([blob], filename, { type: "image/png" });
  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (e) {
      // AbortError = user dismissed the sheet — not a failure worth surfacing.
      if (e?.name === "AbortError") return "shared";
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return "downloaded";
}
