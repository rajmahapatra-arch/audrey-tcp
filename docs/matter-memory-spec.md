*Audrey: Matter Memory Spec*
**Handover Spec**
**Matter Memory: Working Record and Decision Records**
*Capture everything, bind only what the user settles, and keep the reasons*
| From | Raj |
| --- | --- |
| For | Sisi |
| Date | 30 September 2026 |
| Phase | Matter memory (sequencing against External Onboarding to be confirmed by Raj, see section 9) |
| Goal | Replace the end-of-session commit list with automatic capture plus inline approval, and store the reasons behind every settled decision |
| Status | Draft for Raj sign-off, then ready to scope into tickets |

| Why this, why nowTwo problems have surfaced in real use. First, a long conversation ends with Audrey asking the user to approve up to 20 memory items. In practice the user approves two or three and skims the rest, so curation has become a formality.Second, Audrey stores the outcome of a decision but not the reasoning. The nuance sits in why a position was taken, and that is exactly what Audrey needs to spot a later conflict. This spec fixes both with one model. |
| --- |
# 1. Scope
## In scope
- Two-tier matter memory: a working record (captured automatically) and a settled record (authoritative, approved by the user)
- Decision records that hold the decision, the reasons, the alternatives rejected, what would reopen it, provenance and supersession
- Inline decision cards in the taskpane, raised at the moment a decision is reached
- End-of-session summary capped at three proposed decisions, ranked by salience
- Cross-tool capture via the Audrey MCP, with an explicit user confirmation required to settle
- Proposals captured outside Word shown as cards when the matter is next opened in Word
- Conflict detection that cites the settled decision and its reasons
- Migration of existing committed matter memory into the new model
## Out of scope
- Let’s Think integration (the provenance and propose-only rules in this spec anticipate it; the integration itself is a separate spec)
- Matter ID contract and external references table for third-party systems (separate spec)
- Authority precedence between users on a shared matter (needed once a second person works a matter)
- Memory decay and salience weighting at client level
- Voice capture ("Let’s think about this" button) in the taskpane
- Any local file storage of memory. All state stays in Supabase, consistent with the device portability principle
# 2. Principles
This spec changes one settled principle and adds four rules. Raj to update the principles record once signed off.
| Before | After |
| --- | --- |
| Curated over automatic memory ingestion. Nothing is kept without the user approving it. | Automatic capture, curated promotion. Everything is kept in the working record. Only what the user settles becomes authoritative. |

## Rules
- **Capture is automatic everywhere.** Anything said about a matter, in any connected tool, lands in the working record.
- **Settling needs an explicit act by the user.** Approval can be given in any tool (Audrey in Word, Claude, Cowork), but it must be the user’s act.
- **Model inference never settles.** "I’m inclined to concede the cap" is a note or a proposal, never a settled decision.
- **Third-party systems can only propose.** An integrated system can write to the working record or raise a proposal. It cannot settle.
- **The working record never overrides the settled record.** Where they conflict, Audrey follows the settled record and flags the note.
| Why approval stays with the userOutside Word the user often lacks the document and the matter context. If a phone conversation or a model’s reading of it could bind a matter, a half-formed thought could override a position negotiated line by line. Capture is cheap and reversible; settling is neither. |
| --- |
# 3. Data model
Both records sit under a matter and inherit RLS via matter_id, as matter_memory does today. Content must be terse: the model reads these records at retrieval time, and length costs attention.
## 3.1 Working record
| Field | Notes |
| --- | --- |
| id, matter_id, user_id | RLS via matter_id; subquery on matters.user_id |
| content | Terse extraction, not a transcript. One point per entry |
| kind | note | reasoning | context | open_question |
| source_tool, source_session_id | Stamped server side from the authenticated client, never supplied by the model |
| captured_at | Server timestamp |
| promoted_to | decision id, if later promoted |
| dismissed_at | Soft delete; user can remove from view |

## 3.2 Decision records
| Field | Notes |
| --- | --- |
| id, matter_id, user_id | RLS via matter_id |
| decision | One sentence |
| reasons | One to three short reasons. Audrey drafts; user can edit |
| alternatives_rejected | List of option plus why rejected. May be empty |
| reopen_conditions | What would reopen this. Optional |
| position_id | Link to the related position, where one exists |
| status | proposed | settled | superseded | dismissed |
| source_tool, source_session_id | Where the decision was captured. Server stamped |
| settled_via, settled_at | Where and when the user confirmed it |
| confirmation_text | The user’s confirming words when settled outside the Word taskpane. Audit trail |
| supersedes_id, superseded_by_id | One supersession chain. Superseded records are retained, never deleted |
| proposed_at | Server timestamp |

| Extend, do not duplicateAudrey already records positions and position history. Before building, Sisi to confirm whether position history already handles supersession, and propose either extending that model or a new decision table linked by position_id (AUD-601). Either way there must be one supersession chain, not two. Raj signs off the choice. |
| --- |
# 4. Behaviour in Audrey (Word taskpane)
## 4.1 Inline decision cards
When Audrey detects a decision in the conversation, it renders a card beneath its reply showing the decision and a one-line reason, with three actions.
- **Approve:** status becomes settled; settled_via is audrey_word.
- **Edit:** decision and reasons become editable inline; saving settles.
- **Dismiss:** the card closes and the content moves to the working record as a note. Nothing is deleted.
- **Ignored:** the record stays proposed and reappears in the end-of-session summary.
What counts as a decision: the user states a choice, accepts or rejects a counterparty point, gives or relays a client instruction, or trades one concession for another. What does not: inclinations, hypotheticals, questions, and Audrey’s own suggestions the user has not adopted. At most two cards per turn.
## 4.2 Working record capture
Audrey extracts working record entries from the conversation automatically, without prompting the user. No confirmation UI. The user can view and dismiss entries from the matter view.
## 4.3 End-of-session summary
Shown when the user switches matter, closes the chat session, or signs out (Sisi to confirm the trigger is reliable in the taskpane). It lists at most three outstanding proposed decisions, ranked by salience, followed by a single line: "N further points saved as notes." If more than three proposals are outstanding, a link opens the full list.
## 4.4 Salience ranking
Ranking signals within a matter, highest first:
- Changes or conflicts with a settled decision or position (deterministic boost)
- Records a concession or a trade
- Is a client instruction
- Has commercial value attached: money, liability, term, exclusivity
- Recency, as a tie-breaker
## 4.5 Proposals from other tools
When the user opens a matter in Word, any proposals captured elsewhere appear as cards at the top of the chat, labelled with their source and date (for example, "Captured in Claude, 29 September"). Same actions as 4.1.
## 4.6 Supersession
When a new decision would replace a settled one, Audrey asks: "This replaces [earlier decision], settled on [date]. Confirm?" On confirmation the earlier record becomes superseded and is linked. Never silent.
## 4.7 Conflict detection
When checking a draft or proposing wording, Audrey compares against settled decisions and cites the reason, not just the position. Target behaviour: "You accepted the lower cap on 12 September because the counterparty dropped the indemnity. This draft reinstates the indemnity." Working record entries may inform the check but are flagged as lower confidence.
## 4.8 Retrieval
- Settled decisions for the active matter are always in context.
- Working record entries are retrieved by relevance to the current turn.
- Superseded records are retrieved only when the user asks about history.
# 5. MCP changes (cross-tool)
| Tool | Behaviour |
| --- | --- |
| capture_note | Writes to the working record. Callable freely by any authenticated client |
| propose_decision | Creates a decision record with status proposed. Callable by any authenticated client, including third-party integrations |
| settle_decision | Settles a proposed decision, or creates and settles one. Requires user_confirmed: true and confirmation_text containing the user’s own confirming words. Server rejects calls without both. Available to user-authenticated sessions only |

- Tool descriptions must instruct the model to call settle_decision only after the user has explicitly confirmed in the current conversation, and never on inference.
- source_tool and session are stamped server side from the authenticated client. The model cannot set them.
- Existing tools (add_matter_note, add_position) to be mapped onto the new model. Sisi to propose whether they become aliases or are retired.
| Limits of the confirmation flagThe server cannot prove the confirmation text came from the user rather than the model. The flag and the stored text are a discipline and an audit trail, not a guarantee. The real control is that third-party clients cannot settle at all, and every settled record shows where and how it was confirmed. |
| --- |
# 6. Tickets
*Priorities: P0 = blocks the new memory model going live. P1 = needed before external users receive it. P2 = nice to have within phase.*
## 6.1 Data model
| Ticket | What | Owner | Priority |
| --- | --- | --- | --- |
| AUD-601 | Review existing positions and position history; propose extend versus new decision table; Raj to sign off | Sisi | P0 |
| AUD-602 | Create working record table with RLS via matter_id | Sisi | P0 |
| AUD-603 | Create or extend decision records per section 3.2, including status, reasons, provenance and supersession, with RLS | Sisi | P0 |
| AUD-604 | Stamp source_tool and session server side from the authenticated client | Sisi | P0 |
| AUD-605 | Migrate existing committed matter memory into settled decisions, marked "reasons not recorded" | Sisi | P1 |

## 6.2 Audrey in Word
| Ticket | What | Owner | Priority |
| --- | --- | --- | --- |
| AUD-611 | Decision detection in chat: system prompt update and structured output, per the criteria in 4.1 | Sisi | P0 |
| AUD-612 | Review decision detection criteria and salience wording in the system prompt | Raj | P0 |
| AUD-613 | Inline decision card with approve, edit and dismiss | Sisi | P0 |
| AUD-614 | Automatic working record extraction from chat | Sisi | P0 |
| AUD-615 | Retrieval rules per 4.8 | Sisi | P0 |
| AUD-616 | Supersession confirmation flow | Sisi | P0 |
| AUD-617 | Proposals from other tools shown as cards on matter open, with source and date | Sisi | P0 |
| AUD-618 | End-of-session summary capped at three, with "N further points saved as notes" | Sisi | P1 |
| AUD-619 | Salience ranking per 4.4 | Sisi | P1 |
| AUD-620 | Working record view in the matter screen, with dismiss | Sisi | P1 |
| AUD-621 | Conflict detection citing settled decisions and reasons (extend audrey_check_draft) | Sisi | P1 |

## 6.3 MCP
| Ticket | What | Owner | Priority |
| --- | --- | --- | --- |
| AUD-631 | Add capture_note, propose_decision and settle_decision per section 5 | Sisi | P0 |
| AUD-632 | Server-side rejection of settle_decision without user_confirmed and confirmation_text | Sisi | P0 |
| AUD-633 | Restrict settle_decision to user-authenticated sessions; third-party scopes propose only | Sisi | P1 |
| AUD-634 | Map or retire add_matter_note and add_position | Sisi | P1 |
# 7. Acceptance criteria
| Acceptance criterion | How to verify |
| --- | --- |
| Decisions raise one inline card in the same turn; non-decisions raise none | Scripted conversation with three decisions and two hypotheticals: three cards, none for the hypotheticals |
| Approve settles, dismiss moves to working record, nothing is deleted | Exercise each action; inspect both tables |
| Working record is captured without prompts | Twenty-minute session on a real matter: entries present; no prompts other than decision cards |
| End-of-session summary never shows more than three proposals | Leave five proposals outstanding; close session |
| A decision captured in Claude without confirmation arrives in Word as a proposal | Raj discusses a matter in Claude on his phone, then opens the matter in Word: card shown with source and date |
| A decision confirmed in Claude is settled and raises no card | Confirm explicitly in Claude; record shows settled_via claude and confirmation_text |
| Model inference never settles | In Claude, say "I’m inclined to concede the cap" without confirming: record is a note or proposal, never settled |
| settle_decision without confirmation is rejected | Direct MCP call without the flag or text returns an error |
| Third-party scope cannot settle | Call settle_decision with a test integration token: rejected |
| Supersession is confirmed, never silent | Settle a contrary decision: Audrey asks; earlier record retained and linked |
| Conflict detection cites the reason | Settle a decision with a reason, then draft contrary wording: Audrey cites decision, reason and date |
| Working record never overrides the settled record | Add a contradicting note: Audrey follows the settled decision and flags the note |
| RLS holds on both new tables | Extend the AUD-105 two-account runbook to both tables |
| State is identical on a second device | Repeat the migration test on the second machine |
# 8. Sequence
### Stage 1: Data model
- AUD-601 to AUD-605
- Gate: Raj signs off the schema choice (AUD-601) and reviews migrated records on one real matter
### Stage 2: Audrey in Word
- AUD-611 to AUD-621
- Gate: Raj uses Audrey on live matters for one week. The end-of-session list no longer exceeds three, and no decision card fires on a hypothetical
### Stage 3: Cross-tool
- AUD-631 to AUD-634
- Gate: phone-to-Word test. Raj captures and confirms one decision in Claude, leaves one unconfirmed, and both appear correctly in Word
Durations to be estimated by Sisi at ticket scoping.
# 9. Decisions made and open questions
## Decided
| Question | Decision |
| --- | --- |
| Automatic capture | Yes, for the working record |
| When decisions are proposed | Inline, at the moment the decision is reached |
| Where approval can happen | In any tool, provided it is an explicit act by the user |
| Outside Audrey | Captured automatically to the working record; unconfirmed decisions arrive in Word as proposals |
| Third-party systems | Propose only; never settle |

## Open
- **Sequencing against External Onboarding.** Onboarding users on the current memory model means migrating their data later. Raj to decide whether this work lands before user one or after Stage 4 of onboarding.
- **Extend or new table** (AUD-601). Sisi to propose; Raj to sign off.
- **Session-end trigger** in the taskpane. Sisi to confirm what is reliably detectable.
# 10. Notes for later
- Let’s Think integration: the matter ID contract and external references table come first. A "Let’s think about this" button in the taskpane is the natural demonstration once that exists.
- Authority precedence: once a matter is shared, "later wins" is not enough. Seniority and role need to decide which decision stands.
- Client-level decay: within a matter, positions should not drift, so the job is inconsistency detection. At client level, salience and decay become relevant.