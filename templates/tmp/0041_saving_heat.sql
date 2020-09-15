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
    number_points int not null,
    creation_time timestamp with time zone not null default current_timestamp,
    updated_time timestamp with time zone not null default current_timestamp,
    parameters jsonb default '{}',
    unique (client_id, float_id, event_type)
);

create trigger update_event_point_modtime before update on transaction_data.event_point_list 
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
