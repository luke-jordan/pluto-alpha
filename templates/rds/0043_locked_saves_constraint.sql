-- Add locked_until_time to account tx table
alter table transaction_data.core_transaction_ledger add column locked_until_time timestamp;
