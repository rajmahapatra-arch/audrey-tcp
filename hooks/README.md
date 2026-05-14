# Hooks

Plugin hooks run before and after tool calls to enforce policy or
augment behaviour. Audrey TCP's hooks live here.

Planned for Stage A/B:

- `pre-tool/check-privilege-scope.md` — enforces that the authenticated
  user's selected workspace matches the matter being accessed. Even
  though RLS handles this at the database layer, the hook provides
  defense in depth and clear error messaging for the user.
- `pre-tool/check-writeable-on-record-tools.md` — for `record_*`
  tools, confirms that the user has write permission on the matter
  (some users have read-only access to certain matters).

Hooks are markdown files following Anthropic's hook format. Empty in
Stage A; populated as the privilege model evolves (see `docs/
audrey-tcp-plan.md` §Privilege).
