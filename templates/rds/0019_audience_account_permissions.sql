-- For the audience worker to run what it needs, including several complex queries
grant usage on schema account_data to audience_worker;
grant select on account_data.core_account_ledger to audience_worker;
