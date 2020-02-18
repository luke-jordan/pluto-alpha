alter table boost_data.boost drop constraint if exists boost_initial_status_check;
alter table boost_data.boost add constraint boost_initial_status_check check (
    initial_status in ('CREATED', 'OFFERED', 'PENDING', 'UNLOCKED', 'REDEEMED', 'REVOKED', 'EXPIRED')
);

alter table boost_data.boost_account_status drop constraint if exists boost_account_status_boost_status_check;
alter table boost_data.boost_account_status add constraint boost_account_status_boost_status_check check (
    boost_status in ('CREATED', 'OFFERED', 'PENDING', 'UNLOCKED', 'REDEEMED', 'REVOKED', 'EXPIRED')
);

alter table boost_data.boost add column game_params jsonb;
