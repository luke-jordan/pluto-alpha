-- to prevent running for now
cause failure;

alter table boost_data.boost_account_status drop constraint if exists boost_account_status_boost_status_check;
alter table boost_data.boost_account_status add constraint boost_account_status_boost_status_check check (
    boost_status in ('CREATED', 'OFFERED', 'PENDING', 'UNLOCKED', 'REDEEMED', 'CONSOLED', 'REVOKED', 'EXPIRED', 'FAILED')
);

-- for upcoming quiz game
grant usage on schema snippet_data to boost_worker;
grant select on snippet_data.snippet to boost_worker;
