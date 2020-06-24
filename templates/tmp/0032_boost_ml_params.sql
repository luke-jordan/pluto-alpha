-- this will store boost configuration for regular calls to ML for auto offers
alter table boost_data.boost add column ml_pull_parameters jsonb;
