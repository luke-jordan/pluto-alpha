-- cleaning up some needed perms and adjusting a constraint to allow new transaction type

grant usage on schema friend_data to boost_worker;

grant select (updated_time) on transaction_data.core_transaction_ledger to friend_api_worker;

alter table float_data.float_transaction_ledger drop constraint if exists float_transaction_type_check;
alter table float_data.float_transaction_ledger add constraint float_transaction_type_check check (
    t_type in ('ACCRUAL', 'ADMIN_ALLOCATION', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'CAPITALIZATION', 'BOOST_REDEMPTION', 'ADMIN_BALANCE_RECON', 'BOOST_POOL_FUNDING')
);

alter table transaction_data.core_transaction_ledger drop constraint if exists account_transaction_type_check; 
alter table transaction_data.core_transaction_ledger add constraint account_transaction_type_check check (
    transaction_type in ('ACCRUAL', 'FLOAT_ALLOCATION', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'CAPITALIZATION', 'BOOST_REDEMPTION', 'BOOST_POOL_FUNDING')
);
