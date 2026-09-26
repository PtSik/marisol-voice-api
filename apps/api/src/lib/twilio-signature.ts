import { timingSafeEqual } from './crypto';
export async function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string,
): Promise<boolean> {
  if (!authToken || !signature) return false;

  // Twilio signs the complete URL followed by sorted form keys and values.
  const sortedKeys = Object.keys(params).sort();
  const message = url + sortedKeys.map((key) => `${key}${params[key] ?? ''}`).join('');
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return timingSafeEqual(signature, expected);
}

export async function readSignedTwilioForm(
  request: Request,
  authToken: string,
): Promise<Record<string, string> | null> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  form.forEach((value, key) => {
    if (typeof value === 'string') params[key] = value;
  });
  const valid = await validateTwilioSignature(
    authToken,
    request.url,
    params,
    request.headers.get('X-Twilio-Signature') ?? '',
  );
  return valid ? params : null;
}
