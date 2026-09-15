export interface BookableService {
  name: string;
  duration_minutes: number;
}
export function validServiceCatalog(value: unknown): value is BookableService[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 30 &&
    value.every(
      (v) =>
        v &&
        typeof v.name === 'string' &&
        v.name.trim().length > 0 &&
        v.name.length <= 120 &&
        Number.isInteger(v.duration_minutes) &&
        v.duration_minutes >= 5 &&
        v.duration_minutes <= 1440,
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
