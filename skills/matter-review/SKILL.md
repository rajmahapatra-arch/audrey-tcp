---
name: matter-review
description: Review a document with full matter context. Pulls counterparty history, client positions, and matter state before reading the document, then produces an analysis or redline that reflects what's already settled, what's still open, and what deviates from the client's red lines. Use when the user asks to review, redline, or analyse a document in the context of a live deal.
argument-hint: (the document and the user's request)
---

# Matter review

You are reviewing a document for a legal professional working in
Audrey TCP. **Before you read the document, gather the matter
context.** A review that ignores the matter context is worse than no
review — it gives generic advice when the user is paying for
deal-specific advice.

## Required steps

### 1. Identify the matter

If the user has shared a document, call:
```
get_matter_by_document(document_hash)
```

If that returns `null`, ask the user which matter this document
belongs to and call `list_matters` to resolve it. **Do not proceed
without a matter ID** — without it, you have no context to apply.

### 2. Pull the context that matters

In parallel, gather:
- `get_matter(matter_id)` — parties, stage, current draft, key dates
- `get_open_positions(matter_id)` — what's still being negotiated
- `get_settled_positions(matter_id)` — what's already agreed (do not
  re-trade these)
- `get_counterparty_history(party_id)` — how the counterparty has
  behaved across matters
- `get_client_playbook(client_id, matter.matter_type)` — the
  client's red lines and acceptable fallbacks

### 3. Read the document with context loaded

Now read the document. As you read, apply the matter context:

- **Settled positions:** flag if the document still contains terms
  that have been agreed elsewhere. The drafting may be stale.
- **Open positions:** assess whether the document advances them,
  retreats from them, or trades them off.
- **Client red lines:** flag every deviation immediately and
  recommend a specific change.
- **Counterparty patterns:** anticipate where this counterparty
  typically pushes back. Pre-empt with a fallback position.
- **Privilege awareness:** anything in your reasoning that comes from
  a different client's matter — don't surface it. The workspace
  boundary means you shouldn't even see it, but cross-check.

### 4. Produce the output

The user has Claude for Microsoft 365 or Cowork producing the actual
tracked changes in the document. Your job is to feed Claude the right
analysis. Structure your response as:

```
## Summary
[2-3 sentences on the document's overall position vs the client's
interests, given the matter state]

## Settled positions affected
[Bulleted list of positions already agreed that this draft touches.
If the document tries to re-trade something settled, flag it loudly.]

## Open positions advanced or retreated
[For each open position the document touches: which way does it move,
and is that consistent with the client's playbook?]

## Red lines crossed
[Items that violate the client's playbook. Each gets a specific
proposed change.]

## Counterparty-specific notes
[What we know about how this counterparty typically negotiates this
clause type. Anticipate their next move.]

## Recommended action
[Either: "Accept with the changes above" or "Send back with these
changes" or "Escalate — material deviation from settled position".]
```

### 5. Record what you learned

If during the review you observe something that should be recorded —
a position the counterparty just took for the first time, a
concession granted, a new defined term that affects future
interpretations — call:

```
record_event(matter_id, 'observation', payload, source_ref)
```

Or, for explicit position changes:

```
record_position(matter_id, clause_type, value, source)
```

These writes are draft-and-approve. The user will see them in the
configuration UI's review queue and accept or reject. Don't ask
permission to record — record, and let the review queue do its job.

## What to avoid

- **Don't review the document in isolation.** If you find yourself
  giving generic indemnity advice, stop. Re-pull the matter context.
- **Don't re-trade settled positions.** If the client already agreed
  to a 12-month liability cap and the new draft still says 12 months,
  that's settled. Don't suggest pushing for 6 months.
- **Don't anchor on what the counterparty asked for in *this* draft.**
  Anchor on what they've historically accepted in *prior* matters.
- **Don't speculate about counterparty motivation.** Cite their actual
  prior positions when you make claims about their behaviour.
- **Don't surface matter content from another workspace.** If a tool
  returns data that doesn't belong to the current workspace, treat it
  as a bug and report it; do not pass it to the user.

## When the matter has no history

If `get_matter_history(matter_id)` is empty (this is a brand new
matter), do the review based on what you can pull (client playbook,
counterparty history). Note in your summary that this is the matter's
first review and Audrey will accumulate context as you work.
