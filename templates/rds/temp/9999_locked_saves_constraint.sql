-- Add 'LOCKED' float transaction type
alter table float_data.float_transaction_ledger drop constraint if exists float_transaction_type_check;
alter table float_data.float_transaction_ledger add constraint float_transaction_type_check check (
    t_type in ('ACCRUAL', 'ALLOCATION', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'CAPITALIZATION', 'BOOST_REDEMPTION', 'ADMIN_BALANCE_RECON', 'LOCKED')
);

-- Add 'LOCKED' account transaction type
alter table transaction_data.core_transaction_ledger drop constraint if exists account_transaction_type_check; 
alter table transaction_data.core_transaction_ledger add constraint account_transaction_type_check check (
        transaction_type in ('ACCRUAL', 'FLOAT_ALLOCATION', 'USER_SAVING_EVENT', 'WITHDRAWAL', 'CAPITALIZATION', 'BOOST_REDEMPTION', 'LOCKED')
);
