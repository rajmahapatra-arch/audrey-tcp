# Agents

Plugin agents are scheduled or event-driven workflows that run inside
Claude. Audrey TCP's first agents will live here.

Planned for Stage B:

- `matter-state-watcher.md` — scheduled. Flags matters that have been
  in `in_negotiation` for >30 days without activity (likely stalled
  or forgotten). Prompts the user to either record the current state
  or close the matter.
- `deviation-logger.md` — scheduled. After signed agreements come
  back, prompts the user to record the final positions vs prior
  drafts.

Agents are markdown files following Anthropic's agent format. Empty
in Stage A.
