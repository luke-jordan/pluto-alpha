-- For adjusting transaction amounts
grant update (amount, unit, currency) on transaction_data.core_transaction_ledger to admin_api_worker;
