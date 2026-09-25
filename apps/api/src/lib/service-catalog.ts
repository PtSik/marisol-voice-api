export interface BookableService {
  name: string;
  // One number, because it is the slot that gets reserved. It is also the honest answer to what
  // the caller is really asking — not "how long is the job" but "when can I collect".
  duration_minutes: number;
  // Price may be a range, because nothing computes with it: it is only ever spoken. A groomer
  // cannot quote one figure for a job that is $65 on a Yorkie and $135 on a matted Bernedoodle,
  // and quoting either end alone loses the call or the margin.
  price?: number;
  price_max?: number;
}

const MAX_SERVICES = 30;

function validBound(value: unknown, floor: number, ceiling: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= floor && value <= ceiling;
}

export function validServiceCatalog(value: unknown): value is BookableService[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_SERVICES &&
    value.every(
      (v) =>
        v &&
        typeof v.name === 'string' &&
        v.name.trim().length > 0 &&
        v.name.length <= 120 &&
        Number.isInteger(v.duration_minutes) &&
        v.duration_minutes >= 5 &&
        v.duration_minutes <= 1440 &&
        (v.price === undefined || validBound(v.price, 0, 100000)) &&
        // Equal bounds are allowed — the summary collapses "$65-65" to "$65" rather than refusing
        // the row — but a ceiling with no floor would be spoken as "$-135".
        (v.price_max === undefined ||
          (v.price !== undefined && validBound(v.price_max, v.price, 100000))),
    ) &&
    new Set(value.map((v) => v.name.trim().toLowerCase())).size === value.length
  );
}

// null is legacy mode. A configured catalog never falls back to an agent-invented duration.
export function serviceDuration(catalog: unknown, service: unknown): number | null | undefined {
  if (catalog == null) return undefined;
  if (!validServiceCatalog(catalog) || typeof service !== 'string') return null;
  return (
    catalog.find((s) => s.name.trim().toLowerCase() === service.trim().toLowerCase())
      ?.duration_minutes ?? null
  );
}

// The one sentence the agent reads out when a caller asks what the shop does. Built from the same
// catalog that decides bookable durations, so it can never advertise a service booking refuses.
export function servicesSummary(catalog: unknown): string {
  if (!validServiceCatalog(catalog)) return '';
  return catalog
    .map((s) => {
      const parts = [`${s.duration_minutes} min`];
      if (s.price !== undefined) {
        const price =
          s.price_max === undefined || s.price_max === s.price
            ? `${s.price}`
            : `${s.price}-${s.price_max}`;
        parts.push(`$${price}`);
      }
      // " / " between a service's own fields, because the list itself joins on commas — with
      // commas both ways the agent cannot see where one service ends.
      return `${s.name.trim()} — ${parts.join(' / ')}`;
    })
    .join(', ');
}
