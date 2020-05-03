-- Creates worker for friend tables

DO $$
BEGIN
  create role friend_api_worker with nosuperuser login password 'pwd_for_friend_worker';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role friend_api_worker -- it already exists';
END
$$;
