-- we will extend this in the future, as becomes clear what users want
create table message_data.user_message_preference (
    destination_user_id uuid not null primary key,
    halt_push_messages boolean default false
);

grant select, insert, update on message_data.user_message_preference to admin_api_worker;
