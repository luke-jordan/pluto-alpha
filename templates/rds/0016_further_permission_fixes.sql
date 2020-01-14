-- Should have added into prior but now in here

grant update (log_id) on transaction_data.core_transaction_ledger to float_api_worker;

grant usage on schema boost_data to save_tx_api_worker;
grant select (boost_id, start_time, end_time, active) on boost_data.boost to save_tx_api_worker;
grant select (boost_id, account_id, boost_status) on boost_data.boost_account_status to save_tx_api_worker;

grant insert on account_data.account_log to save_tx_api_worker;

grant update (tags) on transaction_data.core_transaction_ledger to float_api_worker;