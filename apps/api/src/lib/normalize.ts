import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';

export function toE164(phone: string, country: CountryCode = 'US'): string {
  if (!isValidPhoneNumber(phone, country)) {
    throw new Error(`Invalid phone number: ${phone}`);
  }
  return parsePhoneNumber(phone, country).format('E.164');
}

export function tryToE164(phone: string, country: CountryCode = 'US'): string | null {
  try {
    return toE164(phone, country);
  } catch {
    return null;
  }
}
