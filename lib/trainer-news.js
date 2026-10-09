// @ts-check
// lib/trainer-news.js
// ─────────────────────────────────────────────────────────────────────────────
// What is new on the trainer side, for the Trainer section on Profile. An
// entry shows for a week from the day it shipped, then goes quiet on its own:
// it is a date in the code, so nothing is stored, marked seen or cleaned up.
// Add an entry when a trainer-facing change ships; old entries can stay.
// ─────────────────────────────────────────────────────────────────────────────

import { daysBetween } from "./dates.js";

/** Days an entry shows, counting the day it shipped. */
export const NEW_DAYS = 7;

/**
 * @typedef {{ key: string, shipped: string }} TrainerNews
 * `shipped` is a local "YYYY-MM-DD". The row keeps its own subline; the tag alone says New.
 */

/** @type {ReadonlyArray<Readonly<TrainerNews>>} */
export const TRAINER_NEWS = Object.freeze([
  Object.freeze({ key: "ledger-export", shipped: "2026-10-09" }),
]);

/**
 * The entries new on `todayIso`: shipped on or before it, fewer than
 * NEW_DAYS days ago (shipped <= today < shipped + 7). Newest first. A
 * malformed date on either side matches nothing.
 * @param {string} todayIso
 * @param {ReadonlyArray<Readonly<TrainerNews>>} [news]
 * @returns {Readonly<TrainerNews>[]}
 */
export function newFor(todayIso, news = TRAINER_NEWS) {
  return news
    .filter(({ shipped }) => {
      const age = daysBetween(shipped, todayIso);
      return age !== null && age >= 0 && age < NEW_DAYS;
    })
    .sort((a, b) => (a.shipped < b.shipped ? 1 : a.shipped > b.shipped ? -1 : 0));
}
