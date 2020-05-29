
create table if not exists friend_data.saving_pool (
    saving_pool_id uuid not null primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    pool_name text not null,
    active boolean not null default true,
    creating_user_id uuid not null references friend_data.user_reference_table (user_id),
    target_amount integer not null,
    target_unit base_unit not null,
    target_currency varchar(10) not null
);

create table if not exists friend_data.saving_pool_participant (
    participation_id uuid not null primary key,
    saving_pool_id uuid not null references friend_data.saving_pool (saving_pool_id),
    user_id uuid not null references friend_data.user_reference_table (user_id),
    relationship_id uuid references friend_data.core_friend_relationship (relationship_id),
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    active boolean not null default true
);

alter table friend_data.friend_log add column saving_pool_id uuid references friend_data.saving_pool (saving_pool_id);
alter table friend_data.friend_log add column relevant_user_id uuid references friend_data.user_reference_table (user_id);

create trigger update_friend_pool_modtime before update on friend_data.saving_pool 
    for each row execute procedure trigger_set_updated_timestamp();

create trigger update_friend_pool_part_modtime before update on friend_data.saving_pool_participant 
    for each row execute procedure trigger_set_updated_timestamp();

grant select, insert, update on friend_data.saving_pool to friend_api_worker;
grant select, insert, update on friend_data.saving_pool_participant to friend_api_worker;

-- For the summations etc
grant usage on schema transaction_data to friend_api_worker;

grant select (transaction_id, account_id, creation_time, transaction_type, settlement_status, settlement_time, amount, currency, unit, tags) 
    on transaction_data.core_transaction_ledger to friend_api_worker;
