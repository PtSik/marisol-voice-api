import type { WorkerBindings } from '../types';

// A tool webhook awaits this on a live call, so a hung Twilio request is dead air the caller
// hears — and long enough to trip the ElevenLabs tool timeout.
const SMS_TIMEOUT_MS = 5_000;

export async function sendSms(
  env: WorkerBindings,
  fromFallback: string,
  to: string,
  body: string,
): Promise<boolean> {
  if (env.SMS_ENABLED !== 'true') {
    console.log('[sms] blocked: SMS_ENABLED is not true');
    return false;
  }
  const from = env.TWILIO_SMS_FROM || fromFallback;
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: from, To: to, Body: body }),
        signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
