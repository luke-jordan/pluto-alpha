-- Add LOCKED float transaction status
alter table float_data.float_transaction_ledger drop constraint if exists float_transaction_status_check;
alter table float_data.float_transaction_ledger add constraint float_transaction_status_check check (
    t_state in ('SETTLED', 'EXPIRED', 'PENDING', 'SUPERCEDED', 'LOCKED')
);
