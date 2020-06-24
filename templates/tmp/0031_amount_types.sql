-- given units in basis points of hundredth cent, we need bigints

alter table transaction_data.core_transaction_ledger alter column amount type bigint;
alter table float_data.float_transaction_ledger alter column amount type bigint;
alter table friend_data.saving_pool alter column target_amount type bigint;
