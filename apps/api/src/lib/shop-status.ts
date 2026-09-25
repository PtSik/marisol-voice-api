// One way in: a shop answers the phone when an operator has turned it on.
//
// Two values used to be here. "trial" was also the column default, from before assisted launch —
// a status that answered the phone the moment a row existed is a gate skipped by omission, and
// migrations 0020 and 0021 retire it. "demo" was a second spelling of `shops.is_demo` that only
// granted callability, which `active` already grants; what actually keeps a demo from reaching a
// real person is `is_demo`, and that is the copy that fails closed. Migration 0028 retires it.
export const CALLABLE_STATUSES = ['active'] as const;

export function canServeCalls(status: string | null | undefined): boolean {
  return (CALLABLE_STATUSES as readonly string[]).includes(status ?? '');
}
