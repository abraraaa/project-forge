// scripts/build.mjs
// ─────────────────────────────────────────────────────────────────────────────
// `npm run build`: next build with the Google fonts; if that build fails
// because a Google Fonts fetch failed, build once more with the local copies
// in app/fonts/ (HEATWAYVE_FONT_SOURCE=local, read by next.config.mjs). Any
// other failure exits with its own code and no retry.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Text next/font prints when it cannot reach Google: the stylesheet fetch
// ("Failed to fetch Bodoni Moda from Google Fonts." up to 16.3, "Failed to
// download ..." from 16.4), the font file download ("There was an issue
// establishing a connection while requesting https://fonts.gstatic.com/..."),
// or Turbopack failing to resolve the font file it could not download ("Can't
// resolve '@vercel/turbopack-next/internal/font/google/font'", with the host
// cut short in the printed URL). Config errors (an unknown weight, say) print
// a different path and must not match: they would otherwise ship the local
// fonts silently.
const FETCH_FAILURE = [
  /Failed to (fetch|download) .+ from Google Fonts/,
  /fonts\.(googleapis|gstatic)\.com/,
  /Can't resolve '@vercel\/turbopack-next\/internal\/font\/google\/font'/,
];

/** True when build output shows a failed Google Fonts fetch. */
export function isGoogleFontFetchFailure(output) {
  return FETCH_FAILURE.some((re) => re.test(output));
}

// Runs next build, streaming output live and keeping a copy of it.
function nextBuild(args, env) {
  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  return new Promise((done) => {
    let output = "";
    const child = spawn(process.execPath, [nextBin, "build", ...args], {
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    child.stdout.on("data", (c) => { process.stdout.write(c); output += c; });
    child.stderr.on("data", (c) => { process.stderr.write(c); output += c; });
    child.on("close", (code) => done({ code: code ?? 1, output }));
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const first = await nextBuild(args, process.env);
  if (first.code === 0 || !isGoogleFontFetchFailure(first.output)) process.exit(first.code);
  console.log("[build] Google Fonts fetch failed; retrying the build with the local fonts in app/fonts/.");
  const retry = await nextBuild(args, { ...process.env, HEATWAYVE_FONT_SOURCE: "local" });
  process.exit(retry.code);
}
