-- Sets up the relevant roles and schemas; there is no create role if not exists and a function is cumbersome because of 
-- not using text as role name, hence doing it this way; new roles should be minimal. If this fails no migrations run.

DO $$
BEGIN
  create role account_api_worker with nosuperuser login password 'pwd_for_account_api';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role account_api_worker -- it already exists';
END
$$;

DO $$
BEGIN
  create role save_tx_api_worker with nosuperuser login password 'pwd_for_transaction_api';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role save_tx_api_worker -- it already exists';
END
$$;

DO $$
BEGIN
  create role float_api_worker with nosuperuser login password 'pwd_for_float_api';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role float_api_worker -- it already exists';
END
$$;

DO $$
BEGIN
  create role boost_worker with nosuperuser login password 'pwd_for_boost_worker';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role boost_worker -- it already exists';
END
$$;

DO $$
BEGIN
  create role message_api_worker with nosuperuser login password 'pwd_for_message_worker';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role message_api_worker -- it already exists';
END
$$;

DO $$
BEGIN
  create role admin_api_worker with nosuperuser login password 'pwd_for_admin_api';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role admin_api_worker -- it already exists';
END
$$;

DO $$
BEGIN
  create role account_api_worker with nosuperuser login password 'pwd_for_audience_worker';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role account_api_worker -- it already exists';
END
$$;
