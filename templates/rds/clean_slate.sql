-- Wipes all the tables

drop schema if exists account_data cascade;
drop schema if exists transaction_data cascade;
drop schema if exists float_data cascade;
drop schema if exists user_data cascade;

drop role if exists account_api_worker;
drop role if exists save_tx_api_worker;
drop role if exists float_api_worker;
drop role if exists auth_api_worker;
