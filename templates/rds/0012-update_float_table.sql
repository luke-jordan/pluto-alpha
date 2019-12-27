-- Adding transaction state, also some permissions

alter table float_data.float_transaction_ledger add column t_state varchar (50) default 'SETTLED' not null;
alter table float_data.float_transaction_ledger add column updated_time timestamp with time zone default current_timestamp not null;

update float_data.float_transaction_ledger set updated_time = creation_time; 

alter table float_data.float_transaction_ledger add constraint float_transaction_status_check check (
    t_state in ('SETTLED', 'EXPIRED', 'PENDING', 'SUPERCEDED')
);

create trigger update_float_modtime before update on float_data.float_transaction_ledger 
    for each row execute procedure trigger_set_updated_timestamp();

grant update (t_state, updated_time, settlement_time) on float_data.float_transaction_ledger to float_api_worker;

grant select (account_id, owner_user_id, human_ref, frozen) on account_data.core_account_ledger to float_api_worker;

grant update (settlement_status, updated_time) on transaction_data.core_transaction_ledger to float_api_worker; 
grant select (transaction_id, creation_time, account_id, transaction_type, settlement_status, amount, currency, unit, float_id, client_id, tags) on transaction_data.core_transaction_ledger to float_api_worker;
