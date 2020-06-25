create schema snippet_data;

create table if not exists snippet_data.snippet (
    snippet_id uuid not null primary key,
    title varchar (100) not null,
    body text not null,
    created_by uuid not null,
    active boolean not null default true,
    preview_mode boolean not null default true,
    country_code varchar (50) not null,
    snippet_priority int not null,
    snippet_language varchar (50) not null,
    response_options jsonb,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    tags text[] default '{}'
    flags text[] default '{}'
);

create table if not exists snippet_data.snippet_user_join_table (
    user_id uuid not null primary key,
    snippet_id uuid not null  references snippet_data.snippet (snippet_id),
    snippet_status varchar (100) not null,
    view_count int not null default 0,
    fetch_count int not null default 0,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp
);

create table if not exists snippet_data.preview_user_table (
    user_id uuid not null primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    tags text[] default '{}',
    flags text[] default '{}'
)

create table if not exists snippet_data.snippet_log (
    log_id uuid not null primary key,
    user_id uuid not null,
    snippet_id varchar(255) not null,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    log_type varchar(50) not null,
    log_context jsonb default '{}'
);
