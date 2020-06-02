update transaction_data.core_transaction_ledger set initiation_time = creation_time where initiation_time is null;

alter table transaction_data.core_transaction_ledger alter column initiation_time set default current_timestamp;

grant update (updated_time, tags) on transaction_data.core_transaction_ledger to friend_api_worker;
