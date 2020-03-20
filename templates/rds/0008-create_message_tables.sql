create schema if not exists message_data;

create table if not exists message_data.message_instruction (
    instruction_id uuid not null primary key,
    creating_user_id uuid not null,
    presentation_type varchar (100) not null,
    active boolean not null default true,
    audience_type varchar (100) not null,
    templates jsonb not null,
    audience_id uuid references audience_data.audience (audience_id),
    recurrence_parameters jsonb,
    response_action varchar (100),
    response_context jsonb,
    start_time timestamp with time zone not null,
    end_time timestamp with time zone not null,
    last_processed_time timestamp with time zone not null,
    message_priority int not null,
    processed_status varchar not null,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    flags text[] default '{}'
);

drop trigger if exists update_msg_instruction_modtime on message_data.message_instruction;
create trigger update_msg_instruction_modtime before update on message_data.message_instruction for each row execute procedure trigger_set_updated_timestamp();

create table if not exists message_data.user_message (
    message_id uuid not null primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    destination_user_id uuid not null,
    instruction_id uuid not null references message_data.message_instruction(instruction_id),
    message_title varchar(255) not null,
    message_body text not null,
    last_displayed_body text not null,
    start_time timestamp with time zone not null,
    end_time timestamp with time zone not null,
    message_priority int not null,
    updated_time timestamp with time zone not null default current_timestamp,
    processed_status varchar (100) not null,
    display jsonb not null,
    action_context jsonb,
    follows_prior_message boolean not null default false,
    has_following_message boolean not null default true,
    message_sequence jsonb,
    deliveries_max integer not null default 1,
    deliveries_done integer not null default 0,
    message_variant varchar(255) default 'DEFAULT' not null,
    flags text[] default '{}'
);

drop trigger if exists update_msg_instruction_modtime on message_data.message_instruction;
create trigger update_msg_instruction_modtime before update on message_data.message_instruction for each row execute procedure trigger_set_updated_timestamp();

create index if not exists idx_message_destination_id on message_data.user_message (destination_user_id);
create index if not exists idx_message_processed_status on message_data.user_message (processed_status);

create table if not exists message_data.user_push_token (
    insertion_id serial primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    user_id uuid not null,
    push_provider varchar (255) not null,
    push_token varchar(255) not null,
    active boolean not null default true,
    unique(user_id, push_provider)
);

-- then permissions

grant usage on schema message_data to message_api_worker;

revoke all on schema message_data from public;

grant select, insert, update on message_data.message_instruction to message_api_worker;
grant select, insert, update on message_data.user_message to message_api_worker;

grant select, insert, delete on message_data.user_push_token to message_api_worker;
grant usage, select on message_data.user_push_token_insertion_id_seq to message_api_worker;

grant usage on schema message_data to boost_worker;
grant select on message_data.message_instruction to boost_worker;
