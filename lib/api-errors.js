// @ts-check
// lib/api-errors.js
// One error shape for every route: full detail to the server log, a generic
// sentence to the client. An exception message can name a store, a path or a
// dependency, and on the auth routes that is a map for whoever is probing.

import { NextResponse } from "next/server";

/**
 * @param {unknown} e
 * @param {{ status?: number, label?: string }} [opts]
 */
export function serverError(e, { status = 500, label = "api" } = {}) {
  const err = /** @type {any} */ (e);
  console.error(`[forge:${label}]`, err?.stack || err?.message || err);
  return NextResponse.json({ error: "Something went wrong. Try again." }, { status });
}
