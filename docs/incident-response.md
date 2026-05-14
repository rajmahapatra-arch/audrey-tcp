# Incident response — one-page runbook

This is the working playbook for what happens when something goes wrong
in production. Lives at one page deliberately. Long playbooks don't get
read during an incident.

## Definitions

**Incident** = any of:
- MCP server down or returning errors for >5 minutes
- Database (Supabase) unreachable or returning errors
- Suspected data leak or unauthorized access (any duration)
- Successful exploitation of a vulnerability
- Loss of >24h of customer data

**Severity:**
- **SEV-1** — customer data exposed or destroyed; total service outage
- **SEV-2** — partial outage; service degraded for >50% of users
- **SEV-3** — single tool failing; degraded performance; minor data
  issue affecting <10 customers

## Who responds

Stage A: Raj is on-call. Sisi assists.
Stage C onwards: rotation TBD.

## SEV-1 response (data exposure or total outage)

1. **Stop the bleeding.** If a data leak is in progress, take the
   affected service offline. Faster than apologizing later for
   continuing to leak.
2. **Notify Raj** within 15 minutes. Phone, not email.
3. **Snapshot the state** — logs, database state, deploy version, any
   active sessions. Don't try to remediate before snapshotting; you
   need the evidence for post-incident review.
4. **Begin remediation.** Roll back to last-known-good if possible.
5. **Within 1 hour: hold-the-line communication** to affected
   customers. Even *"investigating, will update in 1 hour"* is
   better than silence.
6. **GDPR notification clock starts.** If personal data is involved,
   you have 72 hours to notify the ICO. Plan accordingly.

## SEV-2 / SEV-3 response

1. Snapshot logs and state.
2. Notify Raj within 1 hour for SEV-2; same day for SEV-3.
3. Roll back if a recent deploy is the suspected cause.
4. Communicate with affected customers when fix is in flight.

## Post-incident review

Within 5 business days of resolution, complete a one-page review:

- What happened (timeline)
- Why it happened (root cause)
- What we did right
- What we'd do differently
- Specific changes committed to (with owner + due date)

File in `docs/incidents/YYYY-MM-DD-shortname.md`.

## Customer notification template

```
Subject: Audrey TCP service incident — [date]

[Customer name],

On [date and time], Audrey TCP experienced [brief description]. As a
result, [impact on customer's data or service].

We took the following actions: [list]

The matter is now resolved / the matter is being investigated and we
will follow up by [time].

If you have any questions, reach out to [contact].

[Name]
```

## Subprocessor incidents

If a subprocessor (Supabase, Railway, Anthropic, OpenAI, etc.) reports
an incident affecting our service:

1. Note in `docs/incidents/YYYY-MM-DD-shortname.md` with a link to
   their post-mortem.
2. Assess customer impact and notify affected customers if material.
3. Review whether the incident reveals a vendor-management gap (e.g.
   we lacked sufficient monitoring of their status).

## Contacts

- **Supabase support:** support@supabase.com
- **Railway support:** team@railway.app
- **Anthropic API status:** status.anthropic.com
- **OpenAI API status:** status.openai.com
- **ICO (UK GDPR):** 0303 123 1113 / casework@ico.org.uk
