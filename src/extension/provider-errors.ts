// extension/provider-errors.ts — classify provider HTTP statuses for the
// activity announcements. TRANSIENT = retrying later can succeed (peers
// pause reminders, wait_all says "retry later"); PERMANENT = retrying will
// not heal it (auth errors, not found…) — flagged blocked, needs a human.

/** True when a retry later can realistically succeed. */
export function isTransientProviderError(status: number): boolean {
  return status === 429 || status === 408 || status === 425 || status >= 500;
}

/** Map a provider status to the announced activity state (or undefined when
 *  the response is not an error). */
export function providerErrorState(
  status: number,
): "rate_limited" | "blocked" | undefined {
  if (status < 400) return undefined;
  return isTransientProviderError(status) ? "rate_limited" : "blocked";
}
