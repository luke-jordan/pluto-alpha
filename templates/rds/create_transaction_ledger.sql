create schema if not exists transaction_data;

-- For flags and tags, for the moment, see account ledger

create table if not exists transaction_data.core_transaction_ledger (
    transaction_id uuid not null,
    account_id uuid not null references account_data.core_account_ledger (account_id),
    creation_time timestamp with time zone not null default current_timestamp,
    currency varchar(10),
    unit varchar(20),
    amount integer not null,
    transaction_type varchar(50) not null,
    settlement_status varchar(50),
    float_id varchar(255) not null,
    client_id varchar(255) not null,
    matching_float_tx_id varchar(50),
    tags text[] default '{}',
    flags text[] default '{}',
    primary key (transaction_id),
    check (amount >= 0)
);

-- todo : indices
-- todo : tighten up / narrow grants
revoke all on transaction_data.core_transaction_ledger from public;

-- as above, tighten up grants here, worker probably doesn't need select, but getting tricky with 
-- Postgres and interaction with insertion, etc.
grant usage on schema transaction_data to save_tx_api_worker;
grant select on transaction_data.core_transaction_ledger to save_tx_api_worker;
grant insert on transaction_data.core_transaction_ledger to save_tx_api_worker;

-- So that the accrual worker can persist to account table
grant usage on schema transaction_data to float_api_worker;
grant select (transaction_id, creation_time, account_id, transaction_type, settlement_status, amount, currency, unit, float_id, tags) on transaction_data.core_transaction_ledger to float_api_worker;
grant insert on transaction_data.core_transaction_ledger to float_api_worker;
