// lib/share-card.js
// ─────────────────────────────────────────────────────────────────────────────
// "Share metrics" (parked → shipped): renders a point-in-time snapshot of a
// lift's e1RM trend to a canvas, in the Forge palette, for the user to push
// wherever THEY choose via the Web Share API. Deliberately not-social: a
// one-way export, no account linking, no Forge-side backend — the artifact
// is generated entirely on-device from local data.
//
// Canvas 2D only (no deps, no assets). 1080×1350 (4:5 portrait) — the size
// share sheets and feeds treat kindly. Colours mirror lib/tokens.js; kept as
// literals because canvas can't consume CSS vars and this card should stay
// stable even if the app theme evolves.
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  base: "#131110",
  field: "#1D1A19",
  text1: "#EDEBE7",
  text2: "#A09890",
  text3: "#857D75",
  coral: "#E0956A",
  gold: "#C4A882",
  line: "#38342E",
};

// series: [{ date: "YYYY-MM-DD", est1RM: kg, ... }, ...] (ascending) —
// the exact shape lib/analytics.js mainLiftTrend emits.
export function renderShareCard({ lift, series }) {
  const W = 1080, H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Field: base + two warm radial glows (the OG-image recipe).
  ctx.fillStyle = C.base;
  ctx.fillRect(0, 0, W, H);
  const glow = (x, y, r, rgba) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  glow(W * 0.2, H * 0.16, 620, "rgba(224,149,106,0.16)");
  glow(W * 0.85, H * 0.9, 560, "rgba(196,168,130,0.12)");

  const PAD = 96;

  // Wordmark + header
  ctx.fillStyle = C.coral;
  ctx.font = "500 30px -apple-system, system-ui, sans-serif";
  // letterspaced wordmark drawn char-by-char
  let x = PAD;
  for (const ch of "FORGE") { ctx.fillText(ch, x, PAD + 24); x += 42; }

  ctx.fillStyle = C.text3;
  ctx.font = "500 28px -apple-system, system-ui, sans-serif";
  ctx.fillText("ESTIMATED 1RM", PAD, PAD + 118);

  ctx.fillStyle = C.text1;
  ctx.font = "300 84px Georgia, 'Times New Roman', serif";
  ctx.fillText(lift, PAD, PAD + 218);

  // Headline number: latest value + delta across the series
  const latest = series[series.length - 1]?.est1RM ?? 0;
  const first = series[0]?.est1RM ?? latest;
  const delta = Math.round((latest - first) * 10) / 10;

  ctx.fillStyle = C.text1;
  ctx.font = "300 170px Georgia, 'Times New Roman', serif";
  const numText = `${latest}`;
  ctx.fillText(numText, PAD, PAD + 430);
  const numW = ctx.measureText(numText).width;
  ctx.fillStyle = C.text3;
  ctx.font = "300 56px Georgia, 'Times New Roman', serif";
  ctx.fillText("kg", PAD + numW + 18, PAD + 430);

  ctx.fillStyle = delta >= 0 ? C.gold : C.text3;
  ctx.font = "italic 300 44px Georgia, 'Times New Roman', serif";
  ctx.fillText(
    `${delta >= 0 ? "+" : ""}${delta}kg over ${series.length} session${series.length === 1 ? "" : "s"}`,
    PAD, PAD + 520
  );

  // Trend line — the artifact's centrepiece.
  const chart = { x: PAD, y: 760, w: W - PAD * 2, h: 330 };
  const vals = series.map(s => s.est1RM);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const px = (i) => chart.x + (series.length === 1 ? chart.w / 2 : (i / (series.length - 1)) * chart.w);
  const py = (v) => chart.y + chart.h - ((v - min) / span) * chart.h;

  // Soft fill under the line
  if (series.length > 1) {
    const fill = ctx.createLinearGradient(0, chart.y, 0, chart.y + chart.h + 60);
    fill.addColorStop(0, "rgba(224,149,106,0.28)");
    fill.addColorStop(1, "rgba(224,149,106,0)");
    ctx.beginPath();
    ctx.moveTo(px(0), py(vals[0]));
    vals.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(px(vals.length - 1), chart.y + chart.h + 60);
    ctx.lineTo(px(0), chart.y + chart.h + 60);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  ctx.strokeStyle = C.coral;
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  vals.forEach((v, i) => (i === 0 ? ctx.moveTo(px(i), py(v)) : ctx.lineTo(px(i), py(v))));
  ctx.stroke();

  // End-point dot
  ctx.fillStyle = C.coral;
  ctx.beginPath();
  ctx.arc(px(vals.length - 1), py(vals[vals.length - 1]), 10, 0, Math.PI * 2);
  ctx.fill();

  // Date range under the chart
  ctx.fillStyle = C.text3;
  ctx.font = "400 26px -apple-system, system-ui, sans-serif";
  const fmt = (d) => {
    const [, m, day] = d.split("-");
    return `${day}/${m}`;
  };
  if (series[0]?.date) ctx.fillText(fmt(series[0].date), chart.x, chart.y + chart.h + 110);
  if (series.length > 1 && series[series.length - 1]?.date) {
    const t = fmt(series[series.length - 1].date);
    ctx.fillText(t, chart.x + chart.w - ctx.measureText(t).width, chart.y + chart.h + 110);
  }

  // Footer
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, H - 150);
  ctx.lineTo(W - PAD, H - 150);
  ctx.stroke();
  ctx.fillStyle = C.text2;
  ctx.font = "italic 300 34px Georgia, 'Times New Roman', serif";
  ctx.fillText("Train with intention.", PAD, H - 84);
  ctx.fillStyle = C.text3;
  ctx.font = "400 28px -apple-system, system-ui, sans-serif";
  const site = "theforged.fit";
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
