create schema if not exists user_data;

create table if not exists user_data.user (
    insertion_id serial not null,
    system_wide_user_id uuid not null,
    salt text not null,
    verifier text not null,
    server_ephemeral_secret text,
    creation_time timestamp with time zone not null default current_timestamp,
    update_time timestamp with time zone not null default current_timestamp,
    tags text[] default '{}',
    flags text[] default '{}',
    primary key (system_wide_user_id)
);

create index idx_creation_time on user_data.user (creation_time);

grant usage on user_data to auth_api_worker;

revoke all on user_data.user from public;

grant select on user_data.user to auth_api_worker;
grant insert on user_data.user to auth_api_worker;
grant update on user_data.user to auth_api_worker;