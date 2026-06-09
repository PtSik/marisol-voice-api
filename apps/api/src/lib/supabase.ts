import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import type { WorkerBindings } from '../types';

export function getSupabase(env: WorkerBindings): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    global: {
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
