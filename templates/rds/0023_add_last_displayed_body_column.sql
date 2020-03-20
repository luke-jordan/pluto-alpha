--> Adding last_displayed_body column to user_messages table

alter table message_data.user_message add column last_displayed_body text not null;
