create schema if not exists transaction_data;

-- For flags and tags, for the moment, see account ledger

create table if not exists transaction_data.core_transaction_ledger (
    transaction_id uuid not null,
    account_id uuid not null references account_data.core_account_ledger (account_id),
    creation_time timestamp with time zone not null default current_timestamp,
    currency varchar(3),
    amount integer not null,
    transaction_type varchar(50) not null,
    settlement_status varchar(50),
    float_id uuid,
    float_units_at_purchase integer,
    float_purchase_time timestamp with time zone,
    tags text[] default '{}',
    flags text[] default '{}',
    primary key (transaction_id),
    check (amount >= 0)
);

revoke all on transaction_data.core_transaction_ledger from public;

grant usage on schema transaction_data to transaction_api_worker;
grant select (creation_time, currency, amount, settlement_status, float_id, float_units_at_purchase, float_purchase_time, tags, flags) 
    on transaction_data.core_transaction_ledger to transaction_api_worker;
grant insert on transaction_data.core_transaction_ledger to transaction_api_worker;