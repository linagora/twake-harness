-- An encrypted channel may have the assistants of several of its members, each by the yes of all
-- the others
alter table assistant_listened_rooms drop constraint assistant_listened_rooms_pkey;
alter table assistant_listened_rooms add primary key (room_id, user_id);
