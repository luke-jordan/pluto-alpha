create schema if not exists transaction_data;

-- For flags and tags, for the moment, see account ledger

create table if not exists transaction_data.core_transaction_ledger (
    transaction_id uuid not null primary key,
    account_id uuid not null references account_data.core_account_ledger (account_id),
    creation_time timestamp with time zone not null default current_timestamp,
    currency varchar(10) not null,
    unit base_unit not null,
    amount integer not null,
    transaction_type varchar(50) not null,
    initiation_time timestamp with time zone,
    settlement_status varchar(50) not null,
    settlement_time timestamp with time zone,
    float_id varchar(255) not null,
    client_id varchar(255) not null,
    float_adjust_tx_id varchar(50),
    float_alloc_tx_id varchar(50),
    payment_reference varchar(255),
    payment_provider varchar(255),
    human_reference varchar(50),
    updated_time timestamp with time zone not null default current_timestamp,
    tags text[] default '{}',
    flags text[] default '{}'
);

drop trigger if exists update_transaction_modtime on transaction_data.core_transaction_ledger;
create trigger update_transaction_modtime before update on transaction_data.core_transaction_ledger 
    for each row execute procedure trigger_set_updated_timestamp();

-- as with float, replace with proper before production (as well as general migration)
alter table transaction_data.core_transaction_ledger drop constraint account_transaction_type_check; 
alter table transaction_data.core_transaction_ledger add constraint account_transaction_type_check check (
        transaction_type in ('ACCRUAL', 'FLOAT_ALLOCATION', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'CAPITALIZATION', 'BOOST_REDEMPTION')
);

-- todo : indices

-- todo : tighten up / narrow grants
revoke all on transaction_data.core_transaction_ledger from public;

-- as above, tighten up grants here, worker probably doesn't need select, but getting tricky with 
-- Postgres and interaction with insertion, etc.
grant usage on schema transaction_data to save_tx_api_worker;
grant select on transaction_data.core_transaction_ledger to save_tx_api_worker;
grant insert on transaction_data.core_transaction_ledger to save_tx_api_worker;
grant update on transaction_data.core_transaction_ledger to save_tx_api_worker;

-- So that the accrual worker can persist to account table
grant usage on schema transaction_data to float_api_worker;
grant select (transaction_id, creation_time, account_id, transaction_type, settlement_status, amount, currency, unit, float_id, tags) on transaction_data.core_transaction_ledger to float_api_worker;
grant insert on transaction_data.core_transaction_ledger to float_api_worker;

-- So that messaging can do sums (todo : restrict to aggregates)
grant usage on schema transaction_data to message_api_worker;
grant select on transaction_data.core_transaction_ledger to message_api_worker;

-- And so that analytics can work, as well as cleaning up old transactions
grant usage on schema transaction_data to admin_api_worker;
grant select (transaction_id, account_id, creation_time, transaction_type, settlement_status, settlement_time, client_id, float_id, amount, currency, unit, human_reference) on transaction_data.core_transaction_ledger to admin_api_worker;
grant update (settlement_status) on transaction_data.core_transaction_ledger to admin_api_worker;