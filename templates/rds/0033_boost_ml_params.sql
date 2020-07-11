-- this will store boost configuration for regular calls to ML for auto offers
alter table boost_data.boost add column ml_parameters jsonb;

alter table boost_data.boost_account_status drop constraint if exists boost_account_status_boost_status_check;
alter table boost_data.boost_account_status add constraint boost_account_status_boost_status_check check (
    boost_status in ('CREATED', 'OFFERED', 'PENDING', 'UNLOCKED', 'REDEEMED', 'REVOKED', 'EXPIRED', 'FAILED')
);
