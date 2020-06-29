-- Creates db worker for snippet-api

DO $$
BEGIN
  create role snippet_worker with nosuperuser login password 'pwd_for_snippet_worker';
  EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'not creating role snippet_worker -- it already exists';
END
$$;
