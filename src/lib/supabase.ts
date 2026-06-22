import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  // Vite build still works, but runtime data sync needs these env vars.
  console.warn('Supabase env vars are missing. Create .env.local with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
}

export const supabase = createClient(
  supabaseUrl ?? 'https://example.supabase.co',
  supabaseAnonKey ?? 'public-anon-key-placeholder',
);
