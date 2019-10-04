create schema if not exists float_data;

create table if not exists float_data.float_transaction_ledger (
    transaction_id uuid not null primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    client_id varchar(255) not null, 
    float_id varchar(255) not null,
    t_type varchar(50) not null,
    currency varchar(10) not null,
    unit base_unit not null,
    amount integer not null,
    allocated_to_type varchar(50),
    allocated_to_id varchar(50),
    related_entity_type varchar(50),
    related_entity_id varchar(50)
);

-- todo : definitely do not do this once into production
alter table float_data.float_transaction_ledger drop constraint if exists float_transaction_type_check;
alter table float_data.float_transaction_ledger add constraint float_transaction_type_check check (
    t_type in ('ACCRUAL', 'ALLOCATION', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'CAPITALIZATION', 'BOOST_REDEMPTION')
);

-- todo: indices

revoke all on float_data.float_transaction_ledger from public;

grant usage on schema float_data to float_api_worker;
grant select on float_data.float_transaction_ledger to float_api_worker;
grant insert on float_data.float_transaction_ledger to float_api_worker;

-- also need to give insert to account api worker because savings require corresponding entry, and must be in a single tx
grant usage on schema float_data to save_tx_api_worker;
grant select on float_data.float_transaction_ledger to save_tx_api_worker;
grant insert on float_data.float_transaction_ledger to save_tx_api_worker;

grant usage on schema float_data to admin_api_worker;
grant select (client_id, float_id, currency, unit, amount, t_type, allocated_to_type, allocated_to_id) on float_data.float_transaction_ledger to admin_api_worker;
