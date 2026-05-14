---
name: counterparty-history
description: Produce a summary of how a specific counterparty has behaved across all prior matters. Useful at deal kickoff, before a negotiation call, or when assessing whether a counterparty's current ask is in line with their pattern. Returns positions taken, concessions granted, recurring asks, and quirks worth knowing about.
argument-hint: counterparty name or party ID
---

# Counterparty history

Produce a focused intelligence brief on a specific counterparty. The
user is typically prepping for a negotiation, reviewing a fresh draft,
or scoping a new matter and wants to know what they're walking into.

## Steps

### 1. Resolve the counterparty

If the user gave a name, call:
```
list_counterparties(name_query)
```

If multiple match, ask the user which one. If none match, say so and
offer to create a profile.

### 2. Pull the data

```
get_counterparty(party_id)
list_counterparty_precedents(party_id)   # all observed positions
get_counterparty_recent_activity(party_id, days=180)   # what they've
                                                       # been doing
                                                       # lately
```

### 3. Synthesise

Don't just list every observation. Group them by clause type and
extract the pattern:

```
## [Counterparty name] — negotiation profile

### How they negotiate
[2-3 sentences on overall style. Are they collaborative or adversarial?
Do they pick battles strategically or push on everything? How
quickly do they concede?]

### Recurring positions
[For each clause type with 3+ observations, summarise their position:
opening ask, typical fallback, walk-away. Cite the number of matters
the pattern is drawn from.]

### Quirks worth knowing
[Specific recurring behaviours: e.g. "always requires sign-off from
two named signatories", "consistently asks for the indemnity cap to
exclude IP infringement", "responds within 24h on substance but takes
a week on signature pages".]

### Recent activity (last 180 days)
[Matters they've been active in, where they currently sit on open
issues. Useful for: are they currently softer or harder than usual?]

### Open questions
[Things we don't know about them that would be worth finding out in
upcoming conversations.]
```

### 4. Cite

Every claim should be traceable to specific matters. Use citation
format `[Matter: ACME-2024-NDA-03]` so the user can audit.

## What to avoid

- **Don't speculate beyond what's recorded.** If we have 3 observations,
  say so. Don't generalise from 3 data points to "they always..."
- **Don't confuse counterparty behaviour with their lawyer's
  preferences.** If a new external counsel is on the other side, our
  prior observations may not apply.
- **Don't fabricate quirks.** If you can't find a quirk in the
  recorded data, don't make one up to fill the section. Leave it
  out.
- **Don't surface privileged material from other clients' matters.**
  Counterparty observations should be the WHAT (what positions they
  took) not the WHY (our internal reasoning, advice we gave the
  client, etc.).
