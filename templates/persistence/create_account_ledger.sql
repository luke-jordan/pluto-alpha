create schema if not exists account_data;

-- Flags are for things like withdrawal restrictions (eg if a gifted account), tags are for analytics
-- Likely to convert tags and flags into integers in time, but premature optimization for now

create table if not exists account_data.core_account_ledger (
    account_id uuid not null,
    owner_user_id uuid not null,
    opening_user_id uuid not null,
    user_first_name varchar (100) not null,
    user_last_name varchar (100) not null,
    creation_time timestamp with time zone not null default current_timestamp,
    update_time timestamp with time zone not null default current_timestamp,
    last_transaction_time timestamp with time zone not null default current_timestamp,
    tags text[] default '{}',
    flags text[] default '{}',
    primary key (account_id)
);

create index owner_id_idx on account_data.core_account_ledger (owner_user_id);
create index opening_user_idx on account_data.core_account_ledger (opening_user_id);

revoke all on account_data.core_account_ledger from public;

grant usage on schema account_data to account_api_worker;

-- Probably want to narrow the select in time, but needed for now for insert to work
grant select on account_data.core_account_ledger to account_api_worker;
grant insert on account_data.core_account_ledger to account_api_worker;
grant update on account_data.core_account_ledger to account_api_worker;

