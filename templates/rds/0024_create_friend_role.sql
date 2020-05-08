-- Creates worker for friend tables

DO $$
BEGIN
  create role friend_api_worker with nosuperuser login password 'pwd_for_friend_worker';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role friend_api_worker -- it already exists';
END
$$;

-- Necessary for the friend worker to pick up account IDs

grant usage on schema account_data to friend_api_worker;

grant select (account_id, owner_user_id) on account_data.core_account_ledger to friend_api_worker;
