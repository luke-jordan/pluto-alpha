-- Adjusts friend logs to distinguish ones that need alerts

alter table friend_data.friend_log add column is_alert_active boolean not null default false;
alter table friend_data.friend_log add column to_alert_user_id uuid[] default '{}';
alter table friend_data.friend_log add column alerted_user_id uuid[] default '{}';

alter table friend_data.friend_log add column updated_time timestamp default current_timestamp;
update friend_data.friend_log set updated_time = creation_time;

create trigger update_friend_modtime before update on friend_data.core_friend_relationship 
    for each row execute procedure trigger_set_updated_timestamp();

create trigger update_friend_req_modtime before update on friend_data.friend_request 
    for each row execute procedure trigger_set_updated_timestamp();

create trigger update_friend_log_modtime before update on friend_data.friend_log
    for each row execute procedure trigger_set_updated_timestamp();
