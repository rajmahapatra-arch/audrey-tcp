# Legal templates

This directory holds the legal templates Audrey TCP needs to operate as
a compliant SaaS business. **Raj (legally-qualified founder) fills these
in.** Empty placeholders for now.

## Files (when populated)

- `data-processing-agreement.md` — DPA template that customers can
  sign. Off-the-shelf vendor template is fine as starting point (e.g.
  Iubenda, Stripe Atlas). Customise the subprocessor list per the
  separate `SUBPROCESSORS.md` at the repo root.
- `privacy-policy.md` — for the public-facing `app.audrey.xeqtor.com`
  site
- `terms-of-service.md` — same
- `acceptable-use-policy.md` — what users can/can't do with Audrey
- `data-retention-policy.md` — how long we hold data, deletion process

## When these are needed

| Document | Needed by | Reason |
|---|---|---|
| DPA template | First paid pilot (Stage C) | Customers won't sign without one |
| Privacy policy | First sign-up by any user | UK GDPR / EU GDPR requirement |
| Terms of Service | First paid pilot (Stage C) | Defines our relationship with customers |
| Acceptable use | First pilot (Stage C) | Backs up enforcement actions |
| Data retention | SOC 2 Type 1 audit (~Month 6) | Auditor will ask for written policy |

## Reminder for Raj

These don't need to be perfect for Stage A. They need to exist by
Stage C. Resist the temptation to over-engineer. The pilot customer
is more likely to care that the documents exist than to scrutinise
their terms in detail (until they hire their own counsel to review,
which is a fine outcome).
