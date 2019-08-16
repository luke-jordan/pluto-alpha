create table if not exists message_instructions (
    instruction_id uuid not null,
    presentation_type varchar (100) not null,
    active boolean not null,
    audience_type varchar (100) not null,
    templates jsonb not null,
    selection_instruction varchar,
    recurrence_instruction jsonb,
    response_action varchar (100) not null,
    response_context jsonb,
    start_time timestamp with time zone not null,
    end_time timestamp with time zone not null,
    last_processed_time timestamp with time zone not null,
    message_priority int not null,
    creation_time timestamp with time zone not null default current_timestamp,
    update_time timestamp with time zone not null default current_timestamp,
    primary key (instruction_id)
);

create index idx_creation_time on message_instructions (creation_time);

grant usage on message_instructions to notifications_api_worker;

revoke all on message_instructions from public;

grant select on message_instructions to notifications_api_worker;
grant insert on message_instructions to notifications_api_worker;
grant update on message_instructions to notifications_api_worker;