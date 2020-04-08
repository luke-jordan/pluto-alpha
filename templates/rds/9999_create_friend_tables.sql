create schema friends_data;

create table if not exists friends_data.user_reference_table (
    user_id uuid not null primary key,
    account_id text[] not null
);

create table if not exists friends_data.core_friend_relationship (
    relationship_id uuid not null primary key,
    initiated_user_id uuid not null references friends_data.user_reference_table(user_id),
    accepted_user_id uuid not null references friends_data.user_reference_table(user_id)
);

create table if not exists friends_data.friend_request (
    request_id uuid not null primary key,
    initiated_user_id uuid not null references friends_data.core_friend_relationship(initiated_user_id),
    target_user_id uuid,
    target_contact_details jsonb,
    request_type varchar (200)
);