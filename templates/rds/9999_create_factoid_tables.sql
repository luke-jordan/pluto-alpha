
create table if not exists factoids (
    factoid_id uuid not null primary key,
    factoid_body text not null,
    creating_user_id uuid not null,
    active boolean not null default true,
    factoid_status  varchar(100) not null,
    response_options jsonb,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    tags text[] default '{}'
    flags text[] default '{}'
);
