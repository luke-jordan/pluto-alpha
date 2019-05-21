create schema if not exists float_data;

create table if not exists float_data.float_transaction_ledger (
    transaction_id uuid not null,
    creation_time timestamp with time zone not null default current_timestamp,
    client_id varchar(255) not null, 
    float_id varchar(255) not null,
    t_type varchar(50) not null,
    currency varchar(10) not null,
    unit varchar(50) not null,
    amount integer not null,
    allocated_to_type varchar(50),
    allocated_to_id varchar(50),
    related_entity_type varchar(50),
    related_entity_id varchar(50)
);

-- todo: indices

revoke all on transaction_data.core_transaction_ledger from public;

grant usage on schema float_data to float_api_worker;
grant select on float_data.float_transaction_ledger to float_api_worker;
grant insert on float_data.float_transaction_ledger to float_api_worker;
