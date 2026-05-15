/**
 * Shared types. These mirror the domain model in docs/audrey-tcp-plan.md.
 *
 * Keeping types in one place means tool handlers and repositories see the
 * same shape. When Stage B replaces stub data with Supabase queries, we
 * adjust the repository's mapping function, not every consumer.
 */

export type PrivilegeScope =
  | 'privileged'
  | 'work_product'
  | 'common_interest'
  | 'open';

export type MatterStage =
  | 'pre_draft'
  | 'in_negotiation'
  | 'settled'
  | 'executed'
  | 'closed';

export type PartyKind = 'client' | 'counterparty' | 'common_interest';

export interface MatterParty {
  partyId: string;
  kind: PartyKind;
  role: string;
}

export interface Position {
  clauseType: string;
  currentValue: unknown;
  history?: string;
}

export interface Matter {
  id: string;
  firmId: string;
  clientId: string;
  /** Free-text matter name (e.g. "Acme MSA negotiation"). Optional because legacy rows may not have one. */
  matterName: string | null;
  /** Flat client name for display when client_id alone is unhelpful. */
  clientName: string | null;
  matterType: string;
  stage: MatterStage;
  privilegeScope: PrivilegeScope;
  openedAt: string;
  closedAt: string | null;
  parties: MatterParty[];
  openPositions: Position[];
  settledPositions: Position[];
  state: Record<string, unknown>;
}
