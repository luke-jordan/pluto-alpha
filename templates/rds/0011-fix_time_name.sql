-- Fixing a wrongly named column, and adding the trigger

alter table account_data.core_account_ledger rename column update_time to updated_time;
create trigger update_account_time before update on account_data.core_account_ledger for each row execute procedure trigger_set_updated_timestamp();
