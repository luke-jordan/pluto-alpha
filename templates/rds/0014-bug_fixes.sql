grant select (client_id, updated_time) on transaction_data.core_transaction_ledger to float_api_worker;

alter table message_data.user_push_token drop constraint user_push_token_user_id_push_provider_key;
