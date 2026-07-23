export interface PersonalizationWebhookRequest {
  caller_id: string;
  agent_id: string;
  called_number: string;
  call_sid: string;
}

export interface ConversationDynamicVariables {
  shop_id: string;
  shop_name: string;
  hours_summary: string;
  services_summary: string;
  staff_summary: string;
  escalation_phone: string;
  ai_disclosure_text: string;
  caller_phone: string;
  shop_timezone: string;
  shop_local_date: string;
  shop_local_datetime: string;
}

export interface ConversationInitiationClientData {
  dynamic_variables: ConversationDynamicVariables;
  conversation_config_override?: {
    language?: string;
    voice_id?: string;
    max_duration_seconds?: number;
    agent?: {
      prompt?: {
        prompt?: string;
      };
      first_message?: string;
    };
  };
}

export interface ElevenLabsToolWebhookRequest<P = Record<string, unknown>> {
  tool_call_id: string;
  tool_name: string;
  parameters: P;
  conversation_id: string;
}

export interface ElevenLabsToolWebhookResponse {
  result: string;
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface CheckAvailabilityParams {
  staff?: string;
  date: string;
  duration_minutes?: number;
}

export interface AvailableSlot {
  start_time: string;
  end_time: string;
  staff_name: string;
  label: string;
}

export interface CheckAvailabilityResult {
  available_slots: AvailableSlot[];
  total_available: number;
  date: string;
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
}

export interface BookAppointmentResult {
  booking_id: string;
  confirmed_start_time: string;
  confirmed_end_time: string;
  staff_name: string;
  calendar_event_id?: string;
  sms_sent: boolean;
}

export interface LookupCustomerParams {
  phone_number: string;
}

export interface LookupCustomerResult {
  found: boolean;
  customer_name?: string;
  last_visit?: string;
  visit_count?: number;
  preferred_service?: string;
  preferred_staff?: string;
  upcoming_bookings?: Array<{
    booking_id: string;
    start_at: string;
    end_at: string;
    service: string | null;
    staff: string;
  }>;
}

export interface CancelAppointmentParams {
  booking_id: string;
  code: string;
  reason?: string;
  language?: 'en' | 'es';
}

export interface CancelAppointmentResult {
  cancelled: boolean;
  booking_id: string;
  original_start_time?: string;
  sms_sent: boolean;
}

export interface RescheduleAppointmentParams {
  booking_id: string;
  code: string;
  new_start_time: string;
  new_duration_minutes?: number;
  new_staff_name?: string;
  language?: 'en' | 'es';
}

export interface RescheduleAppointmentResult {
  rescheduled: boolean;
  booking_id: string;
  old_start_time: string;
  new_start_time: string;
  new_end_time: string;
  staff_name: string;
  sms_sent: boolean;
}

export interface EscalateParams {
  reason: string;
  escalation_type: 'transfer' | 'callback';
  customer_phone?: string;
}

export interface EscalateResult {
  escalated: boolean;
  escalation_type: 'transfer' | 'callback';
  message: string;
  transfer_to?: string;
}

export interface PostCallWebhookPayload {
  type: 'post_call_transcription';
  event_timestamp: number;
  data: PostCallData;
}

export interface PostCallData {
  agent_id: string;
  conversation_id: string;
  status: string;
  transcript?: PostCallTranscriptEntry[];
  metadata?: PostCallMetadata;
  analysis?: PostCallAnalysis;
  conversation_initiation_client_data?: {
    dynamic_variables?: ConversationDynamicVariables;
  };
}

export interface PostCallTranscriptEntry {
  role: string;
  message: string;
}

export interface PostCallMetadata {
  call_duration_secs?: number;
  cost?: number;
}

export interface PostCallAnalysis {
  call_successful?: string;
  transcript_summary?: string;
  data_collection_results?: Record<string, { value: unknown }>;
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
  services_json: string;
  staff_json: string;
  integration: string;
  integration_credentials_encrypted: string | null;
  calendar_routing: CalendarRouting | null;
  elevenlabs_agent_id: string | null;
  reminders_enabled: boolean;
  status: string;
  trial_ends_at: string | null;
  cancelled_at: string | null;
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
  confirmation_code: string | null;
  language: string;
  reminder_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarSyncStateRow {
  shop_id: string;
  calendar_id: string;
  sync_token: string | null;
  synced_at: string;
}

export interface CallbackRow {
  id: string;
  shop_id: string;
  customer_phone: string;
  reason: string | null;
  elevenlabs_conversation_id: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

export interface VerificationCodeRow {
  id: string;
  booking_id: string;
  code_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export interface VerifiedWebhookContext {
  signature: string;
  timestamp: number;
  idempotency_key: string;
}

export interface WorkerBindings {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ELEVENLABS_WEBHOOK_SECRET: string;
  TOOLS_WEBHOOK_SECRET?: string;
  ELEVENLABS_TEMPLATE_AGENT_ID: string;
  ELEVENLABS_API_KEY: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_SMS_FROM?: string;
  ENCRYPTION_KEY: string;
  ADMIN_API_KEYS: string;
  ADMIN_IP_ALLOWLIST?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  // Unset means calendar failure alerts are off.
  TEAM_ALERT_PHONE?: string;
}

export interface WorkerVariables {
  webhook: VerifiedWebhookContext;
  shop: ShopRow;
}
