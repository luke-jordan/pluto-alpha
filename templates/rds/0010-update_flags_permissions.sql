-- This is to allow for updating flags on accounts and transactions, which system admin or event processor needs

grant update (tags, flags, updated_time) on account_data.core_account_ledger to admin_api_worker;

grant select (account_id, owner_user_id, creation_time, updated_time, tags, flags) on account_data.core_account_ledger to admin_api_worker;

grant select (transaction_id, account_id, creation_time, updated_time, transaction_type, settlement_status, settlement_time, client_id, float_id, amount, currency, unit, human_reference, tags, flags) on transaction_data.core_transaction_ledger to admin_api_worker;
grant update (settlement_status, tags, flags, updated_time) on transaction_data.core_transaction_ledger to admin_api_worker;
