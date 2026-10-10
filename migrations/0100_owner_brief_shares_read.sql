-- The instant an owner's last brief read the shares made to them, which their next brief reads them
-- from: null until a brief did
alter table owner_settings add column brief_shares_read_at timestamptz;
