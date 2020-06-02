-- Adding reward_parameters column to boost table
-- Also granting select permission on core friendship table to boost worker

alter table boost_data.boost add column reward_parameters jsonb;
grant select on friend_data.core_friend_relationship to boost_worker;
