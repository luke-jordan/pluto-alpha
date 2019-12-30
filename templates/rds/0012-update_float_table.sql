-- Adding transaction state, also some permissions

alter table float_data.float_transaction_ledger add column t_state varchar (50) default 'SETTLED' not null;
alter table float_data.float_transaction_ledger add column updated_time timestamp with time zone default current_timestamp not null;

update float_data.float_transaction_ledger set updated_time = creation_time; 

alter table float_data.float_transaction_ledger add constraint float_transaction_status_check check (
    t_state in ('SETTLED', 'EXPIRED', 'PENDING', 'SUPERCEDED')
);

create index if not exists id_client_float_id on float_data.float_transaction_ledger (client_id, float_id);

create trigger update_float_modtime before update on float_data.float_transaction_ledger 
    for each row execute procedure trigger_set_updated_timestamp();

grant update (t_state, updated_time, settlement_time) on float_data.float_transaction_ledger to float_api_worker;

grant select (account_id, owner_user_id, human_ref, frozen) on account_data.core_account_ledger to float_api_worker;

grant update (settlement_status, updated_time) on transaction_data.core_transaction_ledger to float_api_worker; 
grant select (transaction_id, creation_time, account_id, transaction_type, settlement_status, amount, currency, unit, float_id, client_id, tags) on transaction_data.core_transaction_ledger to float_api_worker;

-- May put these in a patch instead, but this is the sequence to get rid of a bad mistake

update float_data.float_transaction_ledger set t_type = 'WITHDRAWAL' where t_type = 'ALLOCATION' and related_entity_id in 
    (select transaction_id::text from transaction_data.core_transaction_ledger where transaction_type = 'WITHDRAWAL');

update float_data.float_transaction_ledger set t_type = 'USER_SAVING_EVENT' where t_type = 'ALLOCATION' and related_entity_id in 
    (select transaction_id::text from transaction_data.core_transaction_ledger where transaction_type = 'USER_SAVING_EVENT');

update float_data.float_transaction_ledger set t_type = 'BOOST_REDEMPTION' where t_type = 'ALLOCATION' and related_entity_id in 
    (select boost_id::text from  boost_data.boost);

-- the remainder are accruals, or admin results
update float_data.float_transaction_ledger set t_type = 'ACCRUAL' where t_type = 'ALLOCATION' and allocated_to_type in 'END_USER_ACCOUNT';
update float_data.float_transaction_ledger set t_type = 'ACCRUAL' where t_type = 'ALLOCATION' and related_entity_id like 'SYSTEM_CALC_DAILY_%';

alter table float_data.float_transaction_ledger drop constraint if exists float_transaction_type_check;
alter table float_data.float_transaction_ledger add constraint float_transaction_type_check check (
    t_type in ('ACCRUAL', 'ALLOCATION', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'CAPITALIZATION', 'BOOST_REDEMPTION', 'ADMIN_BALANCE_RECON',
        'BOOST_REVERSAL', 'ADMIN_ALLOCATION')
);

update float_data.float_transaction_ledger set t_type = 'ADMIN_ALLOCATION' where t_type = 'ALLOCATION' and related_entity_id in 
    (select log_id::test from float_data.float_log);
