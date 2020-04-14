create schema friends_data;

create table if not exists friends_data.user_reference_table (
    user_id uuid not null primary key,
    account_id text[] not null
);

create table if not exists friends_data.core_friend_relationship (
    relationship_id uuid not null primary key,
    relationship_status varchar (100) not null,
    initiated_user_id uuid not null references friends_data.user_reference_table(user_id),
    accepted_user_id uuid not null references friends_data.user_reference_table(user_id)
);

create table if not exists friends_data.friend_request (
    request_id uuid not null primary key,
    initiated_user_id uuid not null references friends_data.core_friend_relationship(initiated_user_id),
    target_user_id uuid,
    target_contact_details jsonb,
    request_type varchar (100)
);

create table if not exists friend_data.friend_log (
    log_id uuid not null primary key,
    relationship_id uuid not null references friend_data.core_friend_relationship(relationship_id);
    creation_time timestamp with time zone not null default current_timestamp,
    log_type varchar (50) not null,
    log_context jsonb default '{}'
);

revoke all on schema friend_data from public cascade;

grant usage on schema friend_data to friend_api_worker;

grant select, insert, update on friends_data.user_reference_table to friend_api_worker;
grant select, insert, update on friends_data.core_friend_relationship to friend_api_worker;
grant select, insert, update on friends_data.friend_request to friend_api_worker;
grant select, insert, update on friends_data.friend_log to friend_api_worker;