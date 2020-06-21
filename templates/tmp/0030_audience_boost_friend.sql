-- For the audience worker to run selections on these
grant usage on schema boost_data to audience_worker;
grant select (boost_id, account_id, boost_status) on boost_data.boost_account_status to audience_worker;

grant usage on schema friend_data to audience_worker;
grant select (initiated_user_id, accepted_user_id, relationship_status) on friend_data.core_friend_relationship to audience_worker;

grant usage on schema message_data to audience_worker;
grant select (destination_user_id, processed_status, creation_time) on message_data.user_message to audience_worker;
