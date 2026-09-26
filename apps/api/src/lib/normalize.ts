import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js';

// US numbers may arrive without a country code; an international one carries its own `+`.
export function tryToE164(phone: string): string | null {
  return isValidPhoneNumber(phone, 'US') ? parsePhoneNumber(phone, 'US').format('E.164') : null;
}
