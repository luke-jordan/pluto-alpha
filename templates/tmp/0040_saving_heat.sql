-- New model of saving heat, using persisted point levels

create table transaction_data.transaction_point_ledger (
    account_id,
    number_points,
);

create table transaction_data.event_point_list (
    client_id,
    float_id,
    event_type,
    number_points
);

create table transaction_data.point_log (
    transaction_id,
    number_points
);
