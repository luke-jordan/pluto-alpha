alter table float_data.float_log drop constraint if exists float_log_client_id_float_id_key;

create index if not exists idx_float_log_type_id on float_data.float_log (float_id, log_type);
