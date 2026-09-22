import { describe, expect, it } from 'bun:test';
import { buildPersonalizationData } from '../../routes/webhooks/personalization';
import type { ShopRow } from '../../types';

function shop(overrides: Partial<ShopRow> = {}): ShopRow {
  return {
    id: 'shop-1',
    name: 'Barbarossa Barbershop',
    twilio_number: '+18336596941',
    escalation_phone: '+13055550111',
    owner_escalation_phone: '+13055550111',
    owner_email: 'owner@example.com',
    timezone: 'America/New_York',
    ai_disclosure_text: 'This call is handled by an AI assistant.',
    hours_json: '{}',
    closures_json: '[]',
    services_json: '[]',
    staff_json: '[]',
    integration: 'none',
    integration_credentials_encrypted: null,
    calendar_routing: null,
    elevenlabs_agent_id: null,
    primary_language: 'en',
    reminders_enabled: false,
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildPersonalizationData — primary_language', () => {
  it('sends no language override for an English-first shop', () => {
    const data = buildPersonalizationData(shop({ primary_language: 'en' }), '+13055550199');
    expect(data.conversation_config_override).toBeUndefined();
  });

  it('opens in Spanish for a Spanish-first shop', () => {
    const data = buildPersonalizationData(shop({ primary_language: 'es' }), '+13055550199');
    expect(data.conversation_config_override?.language).toBe('es');
  });

  // The override must not touch the voice — both languages run on the same bilingual voice, so
  // a caller switching mid-call keeps hearing the same receptionist.
  it('never overrides the voice', () => {
    const data = buildPersonalizationData(shop({ primary_language: 'es' }), '+13055550199');
    expect(data.conversation_config_override?.voice_id).toBeUndefined();
  });

  it('still carries the dynamic variables when overriding the language', () => {
    const data = buildPersonalizationData(shop({ primary_language: 'es' }), '+13055550199');
    expect(data.dynamic_variables.shop_name).toBe('Barbarossa Barbershop');
    expect(data.dynamic_variables.caller_phone).toBe('+13055550199');
  });
});
