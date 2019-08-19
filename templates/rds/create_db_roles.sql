-- Sets up the relevant roles and schemas

create role account_api_worker with nosuperuser login password 'pwd_for_account_api';
create role save_tx_api_worker with nosuperuser login password 'pwd_for_transaction_api';
create role float_api_worker with nosuperuser login password 'pwd_for_float_api';
create role boost_worker with nosuperuser login password 'pwd_for_boost_worker';