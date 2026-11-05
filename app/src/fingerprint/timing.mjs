// Cadence taken from the supplied Arena-numeric-5.7.6/controller.js.
export const NUMERIC_REPLY_TIMEOUT_MS = 240_000;
export function readyDelay(random = Math.random) { return 1500 + Math.floor(random() * 2000); }
export function probeDelay(random = Math.random) { return 3000 + Math.floor(random() * 4000); }
export function cardDelay(base, random = Math.random) { return base + Math.floor(random() * 4000); }
