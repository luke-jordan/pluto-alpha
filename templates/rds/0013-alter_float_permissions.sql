-- Should have added into prior but now in here

grant select (t_state, updated_time) on float_data.float_transaction_ledger to admin_api_worker;

grant update (settlement_status, updated_time) on transaction_data.core_transaction_ledger to float_api_worker;

update transaction_data.core_transaction_ledger set transaction_type = 'ACCRUAL' where settlement_status = 'ACCRUED' and 
    transaction_type = 'FLOAT_ALLOCATION';
