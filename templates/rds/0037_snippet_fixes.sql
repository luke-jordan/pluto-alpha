-- Had wrong primary key on join table
alter table snippet_data.snippet_user_join_table drop constraint if exists snippet_user_join_table_pkey;
alter table snippet_data.snippet_user_join_table add constraint snippet_user_join_table_pkey primary key (user_id, snippet_id);
