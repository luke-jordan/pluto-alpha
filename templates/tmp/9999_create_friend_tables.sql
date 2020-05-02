create schema friend_data;

create table if not exists friend_data.user_reference_table (
    user_id uuid not null primary key,
    account_id text[] not null,
    creation_time timestamp with time zone not null default current_timestamp
);

create table if not exists friend_data.core_friend_relationship (
    relationship_id uuid not null primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    relationship_status varchar (100) not null,
    initiated_user_id uuid not null references friend_data.user_reference_table (user_id),
    accepted_user_id uuid not null references friend_data.user_reference_table (user_id),
    share_items text[] default '{}',
    flags text[] default '{}',
    tags text[] default '{}'
);

alter table friend_data.core_friend_relationship add constraint friend_pair_unique unique(initiated_user_id, accepted_user_id);

create table if not exists friend_data.friend_request (
    request_id uuid not null primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    request_status varchar (100) not null default 'PENDING',
    initiated_user_id uuid not null references friend_data.user_reference_table (user_id),
    target_user_id uuid not null references friend_data.user_reference_table (user_id),
    target_contact_details jsonb,
    requested_share_items text[] default '{}',
    request_type varchar (100) not null default 'CREATE',
    request_code varchar (100)
);

alter table friend_data.friend_request add constraint friend_request_status_type check (
    request_status in ('PENDING', 'ACCEPTED', 'IGNORED'));

create index if not exists idx_request_status on friend_data.friend_request (request_status);

create table if not exists friend_data.friend_log (
    log_id uuid not null primary key,
    request_id uuid references friend_data.friend_request (request_id),
    relationship_id uuid references friend_data.core_friend_relationship (relationship_id),
    creation_time timestamp with time zone not null default current_timestamp,
    log_type varchar (50) not null,
    log_context jsonb default '{}'
);

revoke all on schema friend_data from public cascade;

grant usage on schema friend_data to friend_api_worker;

grant select, insert, update on friend_data.user_reference_table to friend_api_worker;
grant select, insert, update on friend_data.core_friend_relationship to friend_api_worker;
grant select, insert, update on friend_data.friend_request to friend_api_worker;
grant select, insert, update on friend_data.friend_log to friend_api_worker;

grant usage on schema friend_data to save_tx_api_worker;

grant select on friend_data.core_friend_relationship to friend_api_worker;
