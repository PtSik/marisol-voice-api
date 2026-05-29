import type { Context } from 'hono';
import type { WorkerBindings, PostCallWebhookPayload } from '../../types';
import { getSupabase } from '../../lib/supabase';

export async function handlePostCall(c: Context<{ Bindings: WorkerBindings }>): Promise<Response> {
  let payload: PostCallWebhookPayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (payload.type !== 'post_call_transcription') {
    return c.json({ received: true });
  }

  const { conversation_id, status, metadata } = payload.data;
  const db = getSupabase(c.env);

  await db
    .from('calls')
    .update({
      outcome: status,
      duration_seconds: metadata?.call_duration_secs ?? null,
      ended_at: new Date(payload.event_timestamp * 1000).toISOString(),
    })
    .eq('elevenlabs_conversation_id', conversation_id);

  return c.json({ received: true });
}
