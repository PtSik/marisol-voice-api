// "demo" is the public demo line: a shop whose number is meant to be dialled by anyone. Gating it
// out is not a safety win, it is a dead sales line with a 404 and nothing in the logs to say why.
// What keeps a demo from doing real work is `shops.is_demo`, not this list.
//
// "trial" used to be here, and was the column default, from before assisted launch. A shop is now
// born `suspended` and an operator turns it on by hand, so a status that answered the phone the
// moment a row existed was a gate that could be skipped by omission. Migrations 0020 and 0021
// retire it.
export const CALLABLE_STATUSES = ['active', 'demo'] as const;

export function canServeCalls(status: string | null | undefined): boolean {
  return (CALLABLE_STATUSES as readonly string[]).includes(status ?? '');
}
