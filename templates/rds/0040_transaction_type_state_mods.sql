-- Add BOOST_REVOCATION to types in float and transaction
alter table float_data.float_transaction_ledger drop constraint if exists float_transaction_type_check;
alter table float_data.float_transaction_ledger add constraint float_transaction_type_check check (
    t_type in ('ACCRUAL', 'ADMIN_ALLOCATION', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'CAPITALIZATION', 'BOOST_REDEMPTION', 'BOOST_REVOCATION', 'ADMIN_BALANCE_RECON', 'BOOST_POOL_FUNDING')
);

alter table transaction_data.core_transaction_ledger drop constraint if exists account_transaction_type_check; 
alter table transaction_data.core_transaction_ledger add constraint account_transaction_type_check check (
    transaction_type in ('ACCRUAL', 'FLOAT_ALLOCATION', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'CAPITALIZATION', 'BOOST_REDEMPTION', 'BOOST_REVOCATION', 'BOOST_POOL_FUNDING')
);

-- Add LOCKED float transaction status
alter table float_data.float_transaction_ledger drop constraint if exists float_transaction_status_check;
alter table float_data.float_transaction_ledger add constraint float_transaction_status_check check (
    t_state in ('SETTLED', 'EXPIRED', 'PENDING', 'SUPERCEDED', 'LOCKED')
);
