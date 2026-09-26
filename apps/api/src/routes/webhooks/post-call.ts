import type { Context } from 'hono';
import { readJson } from '../../lib/request';
import { getSupabase } from '../../lib/supabase';
import type { PostCallWebhookPayload, WorkerBindings } from '../../types';

export async function handlePostCall(c: Context<{ Bindings: WorkerBindings }>): Promise<Response> {
  const payload = await readJson<PostCallWebhookPayload>(c);
  if (!payload) return c.json({ error: 'Invalid JSON' }, 400);

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
