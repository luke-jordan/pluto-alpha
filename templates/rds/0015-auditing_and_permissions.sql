grant usage on schema boost_data to message_api_worker;

grant select (boost_id, start_time, end_time, active) on boost_data.boost to save_tx_api_worker;
grant select (boost_id, account_id, boost_status) on boost_data.boost_account_status to save_tx_api_worker;

grant usage on schema boost_data to admin_api_worker;
grant select (boost_id, start_time, end_time, active) on boost_data.boost to admin_api_worker;
grant update (active) on boost_data.boost to admin_api_worker;

grant select on boost_data.boost_account_status to admin_api_worker;
grant update (boost_status) on boost_data.boost_account_status to admin_api_worker;

alter table float_data.float_transaction_ledger add column log_id uuid[];

create table account_data.account_log (
    log_id uuid not null primary key,
    account_id uuid references account_data.core_account_ledger (account_id) not null,
    transaction_id uuid references transaction_data.core_transaction_ledger (transaction_id),
    creation_time timestamp with time zone not null default current_timestamp,
    reference_time timestamp with time zone not null default current_timestamp,
    creating_user_id varchar(50) not null,
    log_type varchar(50) not null,
    log_context jsonb default '{}'
);

grant insert, select on account_data.account_log to admin_api_worker;

create table message_data.message_log (
    log_id uuid not null primary key,
    instruction_id uuid not null references message_data.message_instruction (instruction_id),
    message_id uuid references message_data.user_message (message_id),
    creation_time timestamp with time zone not null default current_timestamp,
    reference_time timestamp with time zone not null default current_timestamp,
    creating_user_id varchar(50) not null,
    log_type varchar(50) not null,
    log_context jsonb default '{}'    
);

grant insert, select on message_data.message_log to admin_api_worker;
