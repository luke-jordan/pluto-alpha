create schema factoid_data;

create table if not exists factoid_data.factoid (
    factoid_id uuid not null primary key,
    title varchar (100) not null,
    body text not null,
    creating_user_id uuid not null,
    active boolean not null default true,
    factoid_status  varchar (100) not null,
    response_options jsonb,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    tags text[] default '{}'
    flags text[] default '{}'
);

create table if not exists factoid_data.preview_table (
    user_id uuid not null primary key,
    factoid_id uuid not null  references factoid_data.factoid (factoid_id),
    factoid_status varchar (100) references factoid_data.factoid (factoid_status),
    creation_time timestamp with time zone not null default current_timestamp
);
