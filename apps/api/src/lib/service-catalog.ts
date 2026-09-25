export interface BookableService {
  name: string;
  // What gets booked when the caller asks for this service, and the lower end of what the agent
  // quotes. A service with no spread has this and nothing else.
  duration_minutes: number;
  // Optional upper bounds, spoken but never booked. Grooming quotes a spread — a full groom is a
  // different job on a Yorkie and on a matted Bernedoodle — and a barbershop leaves them off.
  duration_max_minutes?: number;
  price?: number;
  price_max?: number;
}

const MAX_SERVICES = 30;

function validBound(value: unknown, floor: number, ceiling: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= floor && value <= ceiling;
}

// An optional upper bound is either absent or a number at least as large as its lower bound. Equal
// is allowed: the summary collapses "90-90" to "90" rather than rejecting the row.
function validOptionalUpper(value: unknown, lower: number, ceiling: number): boolean {
  return value === undefined || validBound(value, lower, ceiling);
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
        (v.duration_max_minutes === undefined ||
          (Number.isInteger(v.duration_max_minutes) &&
            validOptionalUpper(v.duration_max_minutes, v.duration_minutes, 1440))) &&
        (v.price === undefined || validBound(v.price, 0, 100000)) &&
        (v.price_max === undefined || validOptionalUpper(v.price_max, v.price ?? 0, 100000)) &&
        // A price ceiling with no floor reads as a range with a missing end, so refuse it here
        // rather than render "$-110" into the agent's mouth.
        (v.price_max === undefined || v.price !== undefined),
    ) &&
    new Set(value.map((v) => v.name.trim().toLowerCase())).size === value.length
  );
}

function findService(catalog: BookableService[], service: string): BookableService | undefined {
  return catalog.find((s) => s.name.trim().toLowerCase() === service.trim().toLowerCase());
}

// null is legacy mode. A configured catalog never falls back to an agent-invented duration.
export function serviceDuration(catalog: unknown, service: unknown): number | null | undefined {
  if (catalog == null) return undefined;
  if (!validServiceCatalog(catalog) || typeof service !== 'string') return null;
  const match = findService(catalog, service);
  if (!match) return null;
  // Book the top of the spread. Reserving longer than the job takes leaves a gap; reserving
  // shorter overlaps the next caller's slot.
  return match.duration_max_minutes ?? match.duration_minutes;
}

function span(lower: number, upper: number | undefined): string {
  return upper === undefined || upper === lower ? `${lower}` : `${lower}-${upper}`;
}

// The one sentence the agent reads out when a caller asks what the shop does. Built from the same
// catalog that decides bookable durations, so it can never advertise a service booking refuses.
export function servicesSummary(catalog: unknown): string {
  if (!validServiceCatalog(catalog)) return '';
  return catalog
    .map((s) => {
      const parts: string[] = [];
      parts.push(`${span(s.duration_minutes, s.duration_max_minutes)} min`);
      if (s.price !== undefined) parts.push(`$${span(s.price, s.price_max)}`);
      // " / " between a service's own fields, because the list itself joins on commas — with
      // commas both ways the agent cannot see where one service ends.
      return `${s.name.trim()} — ${parts.join(' / ')}`;
    })
    .join(', ');
}
