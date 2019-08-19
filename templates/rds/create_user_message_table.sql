create schema if not exists message_data.user_message;

create table if not exists message_data.user_message (
    message_id uuid not null,
    destination_user_id uuid not null,
    instruction_id uuid not null,
    user_message varchar not null,
    start_time timestamp with time zone not null,
    end_time timestamp with time zone not null,
    presentation_type varchar (100) not null,
    message_priority int not null
    creation_time timestamp with time zone not null default current_timestamp,
    update_time timestamp with time zone not null default current_timestamp,
    primary key (message_id)
);

create index idx_creation_time on message_data.user_message (creation_time);

grant usage on message_data.user_message to notifications_api_worker;

revoke all on message_data.user_message from public;

grant select on message_data.user_message to notifications_api_worker;
grant insert on message_data.user_message to notifications_api_worker;
grant update on message_data.user_message to notifications_api_worker;
