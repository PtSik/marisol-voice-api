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

describe('buildPersonalizationData — services_summary', () => {
  // The spoken list and the bookable durations come from one field, so the agent cannot offer a
  // service book_appointment would then refuse.
  it('reads the list the caller hears from the service catalog', () => {
    const data = buildPersonalizationData(
      shop({
        service_catalog: [
          { name: 'Haircut', duration_minutes: 30, price: 35 },
          {
            name: 'Full groom',
            duration_minutes: 75,
            duration_max_minutes: 180,
            price: 65,
            price_max: 135,
          },
        ],
      }),
      '+13055550199',
    );
    expect(data.dynamic_variables.services_summary).toBe(
      'Haircut — 30 min / $35, Full groom — 75-180 min / $65-135',
    );
  });

  it('leaves the summary empty when a shop has no catalog', () => {
    expect(
      buildPersonalizationData(shop(), '+13055550199').dynamic_variables.services_summary,
    ).toBe('');
  });
});
