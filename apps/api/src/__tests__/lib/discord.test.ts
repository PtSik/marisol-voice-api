import { afterEach, describe, expect, it } from 'bun:test';
import { sendDiscordAlert } from '../../lib/discord';
import type { WorkerBindings } from '../../types';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function env(webhookUrl?: string): WorkerBindings {
  return { DISCORD_ALERT_WEBHOOK_URL: webhookUrl } as unknown as WorkerBindings;
}

describe('sendDiscordAlert', () => {
  it('fails closed without a configured webhook', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    expect(await sendDiscordAlert(env(), 'test')).toBe(false);
    expect(calls).toBe(0);
  });

  it('waits for confirmation and disables mentions', async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const webhook = 'https://discord.com/api/webhooks/123/token?thread_id=456';
    expect(await sendDiscordAlert(env(webhook), '@everyone test')).toBe(true);
    expect(request?.url).toBe(`${webhook}&wait=true`);
    expect(request?.method).toBe('POST');
    expect(await request?.json()).toEqual({
      content: '@everyone test',
      allowed_mentions: { parse: [] },
    });
  });

  it("limits content to Discord's 2000-character maximum", async () => {
    let request: Request | undefined;
    globalThis.fetch = (async (input, init) => {
      request = new Request(input, init);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    expect(
      await sendDiscordAlert(
        env('https://discord.com/api/webhooks/123/token'),
        `\ud83d\udc36${'x'.repeat(2_000)}`,
      ),
    ).toBe(true);
    const body = (await request?.json()) as { content: string };
    expect(Array.from(body.content)).toHaveLength(2_000);
    expect(body.content.startsWith('\ud83d\udc36')).toBe(true);
  });

  it('reports HTTP and malformed-URL failures', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;

    expect(await sendDiscordAlert(env('https://discord.com/api/webhooks/123/token'), 'test')).toBe(
      false,
    );
    expect(await sendDiscordAlert(env('not a URL'), 'test')).toBe(false);
  });
});
