/**
 * The generation model for every Anthropic call the TCP server makes
 * (extraction, review; Stage 3 tools inherit it). One constant, one
 * upgrade point — overridable per-environment without a deploy.
 *
 * Policy: PIN explicitly and upgrade deliberately (re-run the
 * extraction/review spot-checks on bump). Never use auto-tracking
 * aliases: silent model drift is unacceptable in a matter-
 * intelligence system, and extracted_by provenance stamps depend on
 * stable IDs. Upgraded 4-5 -> 5-5 on 2026-10-02 (Raj).
 */
export const GENERATION_MODEL =
  process.env.AUDREY_GENERATION_MODEL ?? 'claude-sonnet-5-5';
