create schema if not exists audience_data;

-- Note: condition instructions cannot change, if they change, it is a new audience, so this is immutable
-- is_dynamic indicates if the audience should be refreshed each time it is gathered (e.g., for recurring boost/messages), or not
create table if not exists audience_data.audience (
    audience_id uuid not null primary key,
    creating_user_id uuid not null,
    client_id varchar(50) not null,
    creation_time timestamp with time zone not null default current_timestamp,
    is_dynamic boolean default false,
    selection_instruction jsonb not null,
    property_conditions jsonb
);

-- The 'active' column is for dynamic audiences in which someone may drop out but we want to retain record that they were selected 
create table if not exists audience_data.audience_account_join (
    audience_id uuid not null references audience_data.audience (audience_id),
    account_id uuid not null references account_data.core_account_ledger(account_id),
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    active boolean default true,
    unique (audience_id, account_id)
);

create index if not exists audience_join_audience_id on audience_data.audience_account_join (audience_id);
create index if not exists audience_join_account_id on audience_data.audience_account_join (account_id); 

revoke all on schema audience_data from public cascade;

grant usage on schema audience_data to audience_worker;

grant select, insert on audience_data.audience to audience_worker;
grant select, insert, update on audience_data.audience_account_join to audience_join_audience_id;

-- So that boost worker and message worker can populate their tables with reference to here
grant usage on schema audience_data to boost_worker;
grant select (account_id, active) on audience_data.audience_account_join to boost_worker;

grant usage on schema audience_data to message_api_worker;
grant select (account_id, active) on audience_data.audience_account_join to message_api_worker;
