-- Mail can now be listened to, and an owner's brief reads their mail only while their assistant
-- listens there, which it does not by default. Every owner who had let their assistant read their
-- mail, whose brief read it until now, has it listen there from now on, unless they already chose
-- for Mail: their brief does not change.
--
-- Consents and listened sources are rows under forced row-level security. The table owner lifts the
-- force for these statements, inside the migration's transaction whose locks keep every other
-- session out, and puts it back.
alter table consents no force row level security;
alter table listened_sources no force row level security;

insert into listened_sources (owner, source, listening)
select distinct owner, 'mail', true from consents where domain = 'mail' and level = 'read'
on conflict (owner, source) do nothing;

alter table listened_sources force row level security;
alter table consents force row level security;
