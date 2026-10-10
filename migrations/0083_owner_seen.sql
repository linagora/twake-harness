-- owner_seen_at: when the owner was last seen in their assistant's room, the one their brief goes to,
-- by a message of theirs there or a read receipt of theirs, public or private, at the instant the
-- matrix role received it; or, before either, at their first brief that looked. Only the instant is
-- kept. Their brief stops once ten working days went by without them.
alter table owner_settings add column owner_seen_at timestamptz;
