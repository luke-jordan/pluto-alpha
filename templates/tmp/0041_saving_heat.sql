-- New model of saving heat, using persisted point levels

-- we use this to determine how many points, at a given time, to offer for an event
-- note : on prior pattern, this would go into dynamo db, but that is getting crowded,
-- and this allows us to keep the saving heat calculator (small after all) to the persistence+cache complex only
create table transaction_data.event_point_list (
    event_point_match_id uuid primary key,
    client_id varchar (255) not null,
    float_id varchar (255) not null,
    event_type varchar (255) not null,
    creating_user_id uuid not null,
    active boolean default true,
    number_points int not null,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    parameters jsonb default '{}',
    unique (client_id, float_id, event_type)
);

create trigger update_event_point_modtime before update on transaction_data.event_point_list 
    for each row execute procedure trigger_set_updated_timestamp();

create table transaction_data.point_heat_level (
    level_id uuid primary key,
    client_id varchar (255) not null,
    float_id varchar (255) not null,
    creating_user_id uuid not null,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    level_name varchar (255) not null,
    level_color varchar (20),
    level_color_code varchar (20),
    minimum_points int not null,
    unique (client_id, float_id, minimum_points)
);

create trigger update_heat_level_modtime before update on transaction_data.point_heat_level
    for each row execute procedure trigger_set_updated_timestamp();

-- using serial primary key because if we need to partition this etc we can do so fairly easily, and no other joins anywhere
create table transaction_data.point_log (
    insertion_id serial primary key,
    creation_time timestamp with time zone not null default current_timestamp,
    owner_user_id uuid not null,
    event_point_match_id uuid not null references transaction_data.event_point_list (event_point_match_id), 
    number_points int not null,
    transaction_id uuid references transaction_data.core_transaction_ledger (transaction_id), -- can be null, because eg friend activity can adjust
    contextual_record jsonb
);

create index if not exists idx_user_point_id on transaction_data.point_log(owner_user_id);

grant select, insert on transaction_data.point_log to save_tx_api_worker;
grant select on transaction_data.event_point_list to save_tx_api_worker;
grant select on transaction_data.point_heat_level to save_tx_api_worker;

grant select, insert, update on transaction_data.event_point_list to admin_api_worker;
grant select, insert, update, delete on transaction_data.point_heat_level to admin_api_worker;

grant usage, select on transaction_data.point_log_insertion_id_seq to save_tx_api_worker;
grant usage, select on transaction_data.point_log_insertion_id_seq to admin_api_worker;
