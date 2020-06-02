-- Adding reward_parameters column to boost table
-- Also granting select permission on core friendship table to boost worker
alter table boost_data.boost add column reward_parameters jsonb;

grant select (relationship_id, initiated_user_id, accepted_user_id, relationship_status) on friend_data.core_friend_relationship to boost_worker;

-- Fixing some earlier null initiation time issues, and allowing friend worker to remove tags from transactions (for pool)
update transaction_data.core_transaction_ledger set initiation_time = creation_time where initiation_time is null;
alter table transaction_data.core_transaction_ledger alter column initiation_time set default current_timestamp;

grant update (updated_time, tags) on transaction_data.core_transaction_ledger to friend_api_worker;
