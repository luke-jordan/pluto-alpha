create schema if not exists boost_data;

create table if not exists boost_data.boost (
    boost_id uuid not null primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    creating_user_id uuid not null,
    label varchar(255) not null,
    start_time timestamp with time zone not null default current_timestamp,
    end_time timestamp with time zone not null,
    active boolean not null default true,
    boost_type varchar(100) not null,
    boost_category varchar(100) not null,
    boost_amount bigint not null default 0,
    boost_unit base_unit not null,
    boost_currency varchar(10) not null,
    boost_budget bigint not null default 0,
    boost_redeemed bigint not null default 0,
    from_bonus_pool_id varchar(255) not null,
    from_float_id varchar (255) not null,
    for_client_id varchar (255) not null,
    status_conditions jsonb not null,
    boost_audience_type varchar (255) not null,
    audience_id uuid references audience_data.audience (audience_id),
    message_instruction_ids jsonb,
    initial_status varchar (100) check (initial_status in ('CREATED', 'OFFERED', 'PENDING', 'REDEEMED', 'REVOKED', 'EXPIRED')),
    flags text[] default '{}',
    updated_time timestamp with time zone not null default current_timestamp
);

drop trigger if exists update_boost_modtime on boost_data.boost;
create trigger update_boost_modtime before update on boost_data.boost for each row execute procedure trigger_set_updated_timestamp();

create table if not exists boost_data.boost_account_status (
    insertion_id serial not null primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    boost_id uuid not null references boost_data.boost(boost_id),
    account_id uuid not null references account_data.core_account_ledger(account_id),
    boost_status varchar (100) check (boost_status in ('CREATED', 'OFFERED', 'PENDING', 'REDEEMED', 'REVOKED', 'EXPIRED')),
    updated_time timestamp with time zone not null default current_timestamp,
    unique (boost_id, account_id)
);

create index if not exists idx_boost_account_id on boost_data.boost_account_status (account_id);
create index if not exists idx_boost_account_status on boost_data.boost_account_status (boost_status);

drop trigger if exists update_boost_status_modtime on boost_data.boost_account_status;
create trigger update_boost_status_modtime before update on boost_data.boost_account_status 
    for each row execute procedure trigger_set_updated_timestamp();

create table if not exists boost_data.boost_log (
    log_id serial not null primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    boost_id uuid not null references boost_data.boost(boost_id),
    account_id uuid references account_data.core_account_ledger(account_id),
    log_type varchar (100) not null,
    log_context jsonb
);

-- todo: indices, as usual

revoke all on schema boost_data from public cascade;

grant usage on schema boost_data to boost_worker;

grant select, update, insert on boost_data.boost to boost_worker;
grant select, update, insert on boost_data.boost_account_status to boost_worker;
grant select, insert on boost_data.boost_log to boost_worker;

grant usage, select on boost_data.boost_account_status_insertion_id_seq to boost_worker;
grant usage, select on boost_data.boost_log_log_id_seq to boost_worker;

-- for message picking & sending
grant usage on schema boost_data to message_api_worker;
grant select on boost_data.boost_account_status to message_api_worker;
