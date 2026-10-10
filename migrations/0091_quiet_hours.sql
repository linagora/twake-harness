-- What each owner chose of their quiet hours, next to their brief, null where they kept the
-- deployment's, QUIET_HOURS_DEFAULT, read on the wall clock of their zone. quiet_start and
-- quiet_end bound their daily range, in minutes after midnight, on the quarter hour, which crosses
-- midnight when it ends before it starts; the same minute for both means no daily range.
-- quiet_days are the whole days of the week that are quiet, none when empty.
alter table owner_settings
	add column quiet_start smallint check (quiet_start between 0 and 1425 and quiet_start % 15 = 0),
	add column quiet_end smallint check (quiet_end between 0 and 1425 and quiet_end % 15 = 0),
	add column quiet_days text[] check (
		quiet_days <@ array['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
	),
	add constraint owner_settings_quiet_range check ((quiet_start is null) = (quiet_end is null));

-- An activity that arrived during its owner's quiet hours, held until its way out: the wake-up its
-- turn will need, as the listener cleaned it on arrival, and when the worker role's scheduler wakes
-- it, at the end of those hours, or once their brief could go out no more when that brief goes out
-- on the day they end, should it not name it. The brief that names it, or its release, erases it.
create table held_activities (
	owner text not null,
	source text not null,
	event_id text not null,
	held_at timestamptz not null,
	release_at timestamptz not null,
	wakeup jsonb not null,
	primary key (owner, source, event_id)
);

-- What the scheduler looks for at each pass, owner by owner
create index held_activities_release_idx on held_activities (owner, release_at);

alter table held_activities enable row level security;
alter table held_activities force row level security;
create policy held_activities_owner on held_activities
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

-- An activity held during its owner's quiet hours: quiet_hours, until its release wakes them or
-- their brief names it
alter table listening_journal drop constraint listening_journal_outcome_check;
alter table listening_journal add constraint listening_journal_outcome_check check (
	outcome in (
		'woken', 'suggested', 'nothing_useful', 'abandoned', 'failed', 'capped', 'for_brief',
		'share_spent', 'quiet_hours'
	)
);
