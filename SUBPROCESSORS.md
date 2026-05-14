# Subprocessors

This file lists all third-party services that may process customer data
on behalf of Audrey TCP. Maintained from day one as evidence for
SOC2 / ISO27001 audit and as transparency for customers.

When this list changes, customers will be notified per the Data Processing
Agreement.

## Active subprocessors

| Service | Purpose | Data processed | Location | Compliance | DPA on file |
|---|---|---|---|---|---|
| Supabase | Primary database (Postgres + pgvector), auth | All matter content, embeddings, user identities | EU (Frankfurt) | SOC 2 Type 2 | TBD |
| Railway | Hosting for MCP server and config UI | Application logs, transit traffic | US/EU | SOC 2 Type 2 (in progress) — verify before pilot | TBD |
| Anthropic | Claude API (called by user's own subscription, NOT by Audrey) | User prompts and responses, processed under user's own Anthropic agreement | US/EU | SOC 2 + HIPAA | Customer's own |
| OpenAI | Embeddings (text-embedding-3-small / -large) | Document text chunks | US | SOC 2 Type 2 | TBD |
| Microsoft (Graph API) | Outlook email ingestion (opt-in per customer) | Email content from customer's mailbox | Customer's M365 region | SOC 2, ISO 27001, multiple | Customer's own |
| Stripe | Subscription billing | Customer payment details, billing email | US/EU | SOC 1, SOC 2 | TBD |
| GitHub | Source code hosting, CI | Application code (not customer data) | US | SOC 2 Type 2 | N/A (no customer data) |

## Notes

- **Anthropic is intentionally not a subprocessor in the legal sense** —
  Claude inference is paid for and contracted by the customer directly
  via their Anthropic subscription. Audrey TCP never relays customer
  data to Anthropic; we provide context to Claude that runs in the
  customer's own subscription.

- **OpenAI is in use for embeddings only** — text chunks of customer
  documents are sent to compute vector representations. No prompt
  content, no chat history, no PII beyond document text. Replaced with
  in-house embeddings if a customer demands no-OpenAI processing.

- **Microsoft Graph** is opt-in per customer and uses the customer's own
  M365 tenant — Audrey TCP does not move email content outside the
  customer's Microsoft tenancy except to compute embeddings.

## Pending verifications before Stage C pilot

- [ ] Railway SOC 2 status confirmed (in progress as of plan date)
- [ ] DPA signed with Supabase
- [ ] DPA signed with OpenAI
- [ ] DPA signed with Stripe
- [ ] EU data-residency confirmed end-to-end if first pilot is UK-based
