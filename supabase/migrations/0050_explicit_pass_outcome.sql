-- Distinguish a deliberate pass from simply not being chosen this round.
--
-- These are separate migrations on purpose: PostgreSQL will not let a newly
-- added enum value be *used* in the transaction that adds it, so anything
-- referencing 'explicit_pass' must land in a later migration than this one.
--
-- Outcome vocabulary after this change:
--
--   kept        -> selected
--   released    -> not_selected_this_round  (weak, situational, may return)
--   explicit_pass -> a deliberate refusal   (never resurfaced)
--   expired     -> the round lapsed unresolved
--
-- 'blocked' and 'reported' deliberately gain no enum value. The blocks and
-- reports tables already record them and are already consulted by eligibility;
-- a third copy of the same fact could only drift.

alter type selection_decision add value if not exists 'explicit_pass';
