import type { WorkerBindings, ConversationInitiationClientData } from '../types';

const BASE_URL = 'https://api.elevenlabs.io/v1';

export async function registerCall(
  env: WorkerBindings,
  fromNumber: string,
  toNumber: string,
  clientData: ConversationInitiationClientData,
): Promise<{ twiml: string; conversation_id: string }> {
  const res = await fetch(`${BASE_URL}/convai/twilio/register-call`, {
    method: 'POST',
    headers: {
      'xi-api-key': env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_TEMPLATE_AGENT_ID,
      from_number: fromNumber,
      to_number: toNumber,
      direction: 'inbound',
      conversation_initiation_client_data: clientData,
    }),
  });

  const twiml = await res.text();
  if (!res.ok) {
    throw new Error(`ElevenLabs register-call failed ${res.status}: ${twiml}`);
  }

  // conversation_id is embedded in the TwiML as a Stream Parameter
  const match = twiml.match(/name="conversation_id"\s+value="([^"]+)"/);
  const conversation_id = match?.[1] ?? '';

  return { twiml, conversation_id };
}

export async function getAgent(
  env: WorkerBindings,
  agentId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}/convai/agents/${agentId}`, {
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ElevenLabs getAgent failed ${res.status}: ${text}`);
  }

  return res.json<Record<string, unknown>>();
}
