-- What an owner's assistant spent of their day on its own, apart from the total every turn counts
-- in: the turns activities woke and the briefs. Their sum is the share of the day admission holds
-- against CHAT_RESERVE. share_noticed is set once the assistant told its owner that share was
-- spent, so that it tells them once a day. Columns rather than a new key, so that a replica of the
-- previous version, which adds to the total alone, keeps writing during a rollout.
alter table usage_daily
	add column event_tokens bigint not null default 0,
	add column brief_tokens bigint not null default 0,
	add column share_noticed boolean not null default false;

-- A turn an activity woke that admission refused once that share, or the whole day, was spent:
-- share_spent, kept for the brief
alter table listening_journal drop constraint listening_journal_outcome_check;
alter table listening_journal add constraint listening_journal_outcome_check check (
	outcome in (
		'woken', 'suggested', 'nothing_useful', 'abandoned', 'failed', 'capped', 'for_brief', 'share_spent'
	)
);
