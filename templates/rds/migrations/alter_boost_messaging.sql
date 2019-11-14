alter table boost_data.boost drop column audience_selection;
alter table boost_data.boost add column audience_id uuid references audience_data.audience (audience_id);

alter table boost_data.boost rename column boost_audience to boost_audience_type;

alter table message_data.message_instruction drop column selection_instruction;
alter table message_data.message_instruction add column audience_id uuid references audience_data.audience (audience_id);
