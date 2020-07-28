-- could have had two possibilities here : could have made this required on all rows,
-- but then for large number of boosts, where expiry = end, would have to continually sync
-- if they changed; whereas this allows a not-too-complicated case query to do the work
alter table boost_data.boost_account_status add column expiry_time timestamp;
