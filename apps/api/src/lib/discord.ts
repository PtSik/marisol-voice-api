import type { WorkerBindings } from '../types';

const DISCORD_TIMEOUT_MS = 5_000;
const DISCORD_CONTENT_LIMIT = 2_000;

function limitContent(content: string): string {
  return Array.from(content).slice(0, DISCORD_CONTENT_LIMIT).join('');
}

export async function sendDiscordAlert(env: WorkerBindings, content: string): Promise<boolean> {
  if (!env.DISCORD_ALERT_WEBHOOK_URL) {
    console.log('[discord-alert] blocked: DISCORD_ALERT_WEBHOOK_URL is not configured');
    return false;
  }

  try {
    const url = new URL(env.DISCORD_ALERT_WEBHOOK_URL);
    // Without wait=true Discord can return 204 before the message is persisted, hiding a failure.
    url.searchParams.set('wait', 'true');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: limitContent(content),
        // Shop names are external data and must never turn into @everyone/@role pings.
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
