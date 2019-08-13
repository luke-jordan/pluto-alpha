create table if not exists message_instructions (
    presentation_type text not null,
    active boolean not null,
    audience_type text not null,
    templates json not null,
    selection_instruction json,
    recurrence_instruction json,
    response_action text not null,
    start_time timestamp with time zone not null,
    end_time timestamp with time zone not null,
    creation_time timestamp with time zone not null default current_timestamp,
    update_time timestamp with time zone not null default current_timestamp,
    priority int
);

create index idx_creation_time on message_instructions (creation_time);

grant usage on message_instructions to notifications_api_worker;

revoke all on message_instructions from public;

grant select on message_instructions to notifications_api_worker;
grant insert on message_instructions to notifications_api_worker;
grant update on message_instructions to notifications_api_worker;