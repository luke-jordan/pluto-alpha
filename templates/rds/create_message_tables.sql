create schema if not exists message_data;

create table if not exists message_data.message_instruction (
    instruction_id uuid not null,
    presentation_type varchar (100) not null,
    active boolean not null default true,
    audience_type varchar (100) not null,
    templates jsonb not null,
    selection_instruction varchar,
    recurrence_instruction jsonb,
    response_action varchar (100),
    response_context jsonb,
    start_time timestamp with time zone not null,
    end_time timestamp with time zone not null,
    last_processed_time timestamp with time zone not null,
    message_priority int not null,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    flags text[] default '{}'
    primary key (instruction_id)
);

create index if not exists idx_creation_time on message_data.message_instruction (creation_time);
drop trigger if exists update_msg_instruction_modtime on message_data.message_instruction;
create trigger update_msg_instruction_modtime before update on message_data.message_instruction for each row execute procedure trigger_set_updated_timestamp();

create table if not exists message_data.user_message (
    message_id uuid not null,
    creation_time timestamp with time zone not null default current_timestamp,
    destination_user_id uuid not null,
    instruction_id uuid not null,
    message_title varchar(255) not null,
    message_body text not null,
    start_time timestamp with time zone not null,
    end_time timestamp with time zone not null,
    message_priority int not null,
    updated_time timestamp with time zone not null default current_timestamp,
    processed_status varchar (100) not null,
    display_type varchar (100) not null,
    display_instructions jsonb,
    action_context jsonb,
    follows_prior_message boolean not null default false,
    has_following_message boolean not null default true,
    following_messages jsonb,
    deliveries_max integer not null default 1,
    deliveries_done integer not null default 0,
    flags text[] default '{}',
    primary key (message_id)
);

create index if not exists idx_creation_time on message_data.user_message (creation_time);
drop trigger if exists update_msg_instruction_modtime on message_data.message_instruction;
create trigger update_msg_instruction_modtime before update on message_data.message_instruction for each row execute procedure trigger_set_updated_timestamp();

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
