// The one SSE connection is owned by App (Shell's useSse). Pages that need
// live frames subscribe here; App publishes into it. Unsubscribe on unmount
// so a disposed page never paints into a dead tree.
export type SseHandler = (type: string, data: unknown) => void;

const subs = new Set<SseHandler>();

export function publish(type: string, data: unknown): void {
  for (const fn of subs) fn(type, data);
}

export function subscribe(fn: SseHandler): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

// --- the boot snapshot -----------------------------------------------------
//
// App fetches /api/overview once, at boot, and hands it to the Overview page.
// Anything that changes what that snapshot says has to invalidate it, or the
// Overview keeps rendering a value the operator has just changed.
//
// The vanilla app handled this with takeOverview(). The port dropped it, which
// left two visible staleness bugs: hiding a job on Tasks left the Overview
// showing the old job, and deleting the in-use session left it showing an
// account and a balance that no longer exist. Both looked like the Overview
// ignoring the change until a full page reload.
//
// This is a separate channel from the SSE bus on purpose: these are local
// invalidations, not frames from the server, and mixing them means a page
// subscribing to live events also gets called for a local edit.
const staleListeners = new Set<() => void>();

/** Tell App the boot snapshot no longer describes reality. */
export function invalidateOverview(): void {
  for (const fn of staleListeners) fn();
}

export function onOverviewInvalidated(fn: () => void): () => void {
  staleListeners.add(fn);
  return () => {
    staleListeners.delete(fn);
  };
}
