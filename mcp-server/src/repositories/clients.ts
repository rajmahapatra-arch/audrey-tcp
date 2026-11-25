/**
 * Clients repository — find-or-create for the client directory.
 *
 * Same discipline as matters.ts: tool handlers come through here, every
 * method takes firmId first and every query is firm-scoped explicitly
 * (the service client bypasses RLS).
 *
 * Matching is deliberately forgiving so a client is never duplicated by
 * a spelling variant: "Let's Think Limited", "Lets Think Ltd" and
 * "let's think" are the same client. See normaliseName().
 */

import { getSupabase, isSupabaseConfigured } from '../db/supabase.js';

export interface Client {
  id: string;
  name: string;
}

const COMPANY_SUFFIXES = /\b(limited|ltd|llp|plc|inc|incorporated|llc|gmbh|sa|bv|corp|corporation|co)\b\.?/g;

/** Comparison key: case, punctuation, spacing and company suffixes ignored. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

export const clientsRepository = {
  async findByName(firmId: string, name: string): Promise<Client | null> {
    if (!isSupabaseConfigured()) return null;
    const supabase = getSupabase();
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('clients')
      .select('id, name')
      .eq('firm_id', firmId)
      .limit(1000);
    if (error) throw new Error(`Failed to look up clients: ${error.message}`);

    const key = normaliseName(name);
    const match = (data ?? []).find((c) => normaliseName(String(c.name ?? '')) === key);
    return match ? { id: match.id as string, name: match.name as string } : null;
  },

  async findById(firmId: string, clientId: string): Promise<Client | null> {
    if (!isSupabaseConfigured()) return null;
    const supabase = getSupabase();
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('clients')
      .select('id, name')
      .eq('firm_id', firmId)
      .eq('id', clientId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load client: ${error.message}`);
    return data ? { id: data.id as string, name: data.name as string } : null;
  },

  async create(firmId: string, name: string): Promise<Client> {
    const supabase = getSupabase();
    if (!isSupabaseConfigured() || !supabase) {
      throw new Error('Audrey database is not configured');
    }

    const { data, error } = await supabase
      .from('clients')
      .insert({ name: name.trim(), context: {}, firm_id: firmId })
      .select('id, name')
      .single();
    if (error || !data) throw new Error(`Failed to create client: ${error?.message ?? 'unknown'}`);
    return { id: data.id as string, name: data.name as string };
  },
};
