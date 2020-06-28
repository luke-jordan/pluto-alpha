-- we will extend this in the future, as becomes clear what users want
create table message_data.user_message_preference (
    system_wide_user_id uuid not null primary key,
    halt_push_messages boolean default false,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
);

grant select, insert, update on message_data.user_message_preference to message_api_worker;
grant select, insert, update on message_data.user_message_preference to admin_api_worker;

create trigger update_user_msg_prefs_modtime before update on message_data.user_message_preference 
    for each row execute procedure trigger_set_updated_timestamp();
