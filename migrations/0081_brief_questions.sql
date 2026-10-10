-- The question an owner's first brief asks in its place, for the reads of their calendar, mail and
-- tasks they did not allow: the date of the brief it holds back, the call it froze, whose yes allows
-- those reads and sends that brief, and how many times it was asked unanswered, the second one on the
-- next day their brief goes out on. One per owner at most.
create table brief_questions (
	owner text primary key,
	brief_date date not null,
	pending_call_id uuid not null,
	asked smallint not null check (asked > 0)
);

alter table brief_questions enable row level security;
alter table brief_questions force row level security;
create policy brief_questions_owner on brief_questions
	using (owner = current_setting('app.principal', true))
	with check (owner = current_setting('app.principal', true));

-- brief_reads_settled: the owner's brief asks them no more for its reads, once they said yes to that
-- question or a brief found them all allowed. brief_reads_told: the applications whose read the
-- owner took back since, which their brief said once, until it reads them again.
alter table owner_settings
	add column brief_reads_settled boolean not null default false,
	add column brief_reads_told text[] not null default '{}'
		check (brief_reads_told <@ array['calendar', 'mail', 'tasks']);
