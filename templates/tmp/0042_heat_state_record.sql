-- sufficiently complex with queries could do this in real time, but trade-off is not worth it
-- so will be persisting, and able to retrieve in targeting etc (also: add foreign key reference to point_log after refactor)
create table transaction_data.user_heat_state (
    system_wide_user_id uuid primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    prior_period_points bigint not null default 0,
    current_period_points bigint not null default 0,
    current_level_id uuid references transaction_data.point_heat_level
);

-- should have included in original definition, needed for various calculations
alter table transaction_data.point_log add column reference_time timestamp with time zone not null default current_timestamp;
update transaction_data.point_log set reference_time = creation_time;

-- will use this a lot for sums etc
create index if not exists idx_heat_ref_time on transaction_data.point_log(reference_time);

create trigger update_user_heat_state_modtime before update on transaction_data.user_heat_state
    for each row execute procedure trigger_set_updated_timestamp();

grant select, insert, update on transaction_data.user_heat_state to save_tx_api_worker;

grant select on transaction_data.user_heat_state to admin_api_worker;
grant select on transaction_data.user_heat_state to audience_worker;
