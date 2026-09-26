import type { BookableService } from './lib/service-catalog';

export interface ConversationDynamicVariables {
  shop_id: string;
  shop_name: string;
  hours_summary: string;
  services_summary: string;
  staff_summary: string;
  // Both may be empty — shops onboarded before these existed have neither, and the prompt treats an
  // empty value as "not known" and escalates, exactly as it did before.
  shop_address: string;
  shop_notes: string;
  escalation_phone: string;
  ai_disclosure_text: string;
  caller_phone: string;
  shop_timezone: string;
  shop_local_date: string;
  shop_local_datetime: string;
  sms_available: string;
}

export interface ConversationInitiationClientData {
  dynamic_variables: ConversationDynamicVariables;
  conversation_config_override?: {
    agent?: {
      language?: string;
    };
  };
}

export interface ElevenLabsToolWebhookResponse {
  result: string;
  success: boolean;
  data?: Record<string, unknown>;
}

export interface CheckAvailabilityParams {
  staff?: string;
  date: string;
  service?: string;
  duration_minutes?: number;
}

export interface AvailableSlot {
  start_time: string;
  end_time: string;
  staff_name: string;
  label: string;
}

export interface BookAppointmentParams {
  staff_name: string;
  start_time: string;
  duration_minutes: number;
  customer_phone: string;
  customer_name?: string;
  service?: string;
  notes?: string;
  language?: 'en' | 'es';
  sms_consent?: boolean;
}

export interface LookupCustomerParams {
  phone_number: string;
}

export interface CancelAppointmentParams {
  booking_id: string;
  code: string;
  reason?: string;
  language?: 'en' | 'es';
}

export interface RescheduleAppointmentParams {
  booking_id: string;
  code: string;
  new_start_time: string;
  new_duration_minutes?: number;
  new_staff_name?: string;
  language?: 'en' | 'es';
}

export interface EscalateParams {
  reason: string;
  escalation_type: 'transfer' | 'callback';
  customer_phone?: string;
}

// Only the fields handlePostCall reads; the webhook carries the transcript and analysis too.
export interface PostCallWebhookPayload {
  type: 'post_call_transcription';
  event_timestamp: number;
  data: {
    conversation_id: string;
    status: string;
    metadata?: { call_duration_secs?: number };
  };
}

export interface CalendarAttribution {
  mode: 'off' | 'color' | 'title_prefix';
  // Google colorId → staff id. Only used with mode 'color'.
  colors?: Record<string, string>;
}

export interface CalendarRouting {
  write_calendar_id: string;
  // Keyed by staff.id (not name) so renaming a staff member never orphans the mapping.
  staff_calendars: Record<string, string>;
  busy_calendar_ids: string[];
  attribution: CalendarAttribution;
}

export interface ShopRow {
  transfers_enabled?: boolean;
  service_catalog?: BookableService[] | null;
  id: string;
  name: string;
  twilio_number: string;
  escalation_phone: string;
  owner_escalation_phone: string;
  owner_email: string;
  timezone: string;
  ai_disclosure_text: string;
  hours_json: string;
  closures_json: string;
  staff_json: string;
  integration: string;
  integration_credentials_encrypted: string | null;
  address: string | null;
  notes: string | null;
  calendar_routing: CalendarRouting | null;
  elevenlabs_agent_id: string | null;
  primary_language: 'en' | 'es';
  // The landing-page demo lines only. Suppresses anything that reaches a real person — see
  // `handleEscalate`.
  is_demo?: boolean;
  reminders_enabled: boolean;
  sms_enabled?: boolean;
  calendar_access_granted_at?: string | null;
  status: string;
  created_at: string;
}

export interface BookingRow {
  id: string;
  shop_id: string;
  customer_phone: string;
  customer_name: string | null;
  staff: string;
  service: string | null;
  start_at: string;
  end_at: string;
  status: string;
  notes: string | null;
  cancellation_reason: string | null;
  gcal_event_id: string | null;
  gcal_calendar_id: string | null;
  cancelled_via: string | null;
  gcal_sync_pending: boolean;
  idempotency_key: string | null;
  language: string;
  reminder_sent_at: string | null;
  sms_consent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarSyncStateRow {
  shop_id: string;
  calendar_id: string;
  sync_token: string | null;
  synced_at: string;
}

export interface WorkerBindings {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ELEVENLABS_WEBHOOK_SECRET: string;
  TOOLS_WEBHOOK_SECRET?: string;
  ELEVENLABS_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_SMS_FROM?: string;
  // Fail closed: SMS stays disabled unless production explicitly opts in after A2P registration.
  SMS_ENABLED?: string;
  PORTAL_URL?: string;
  ENCRYPTION_KEY: string;
  ADMIN_API_KEYS: string;
  ADMIN_IP_ALLOWLIST?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  // Secret incoming-webhook URL. Unset means team alerts are off.
  DISCORD_ALERT_WEBHOOK_URL?: string;
}
