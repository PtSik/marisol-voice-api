// "trial" is the legacy default used by all shops created before assisted launch. New onboarding
// explicitly creates "suspended" rows and only the admin activation flow changes them to "active",
// so keeping legacy trial rows callable prevents a deploy from cutting off existing test/client
// lines without weakening the new manual gate.
//
// "demo" is the sales pool: five leased numbers renamed per prospect. They are deliberately live —
// gating them out is not a safety win, it is five dead sales lines with a 404 and nothing in the
// logs to say why. What keeps a demo from doing real work is `shops.is_demo`, not this list.
export const CALLABLE_STATUSES = ['active', 'trial', 'demo'] as const;

export function canServeCalls(status: string | null | undefined): boolean {
  return (CALLABLE_STATUSES as readonly string[]).includes(status ?? '');
}
