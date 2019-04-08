-- Wipes all the tables

drop schema if exists account_data cascade;
drop schema if exists transaction_data cascade;

drop role if exists account_api_worker;
drop role if exists transaction_api_worker;
