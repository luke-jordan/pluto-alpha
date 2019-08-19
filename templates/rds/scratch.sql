insert into boost_data.boost 
    (boost_id, 
    creating_user_id,
    start_time,
    end_time,
    boost_type,
    boost_category,
    boost_amount,
    boost_unit,
    boost_currency, 
    from_bonus_pool_id, 
    from_float_id, 
    for_client_id,
    boost_audience, 
    audience_selection, 
    status_conditions, 
    redemption_messages) 
values (
    '68097d84-b3e1-4fe8-807e-9dff24d4fb6b', 
    '5ef8310d-4c06-49e4-b7bc-df8a880895f0', 
    '2019-08-19T15:22:11+02:00', 
    '2019-11-19T14:52:07+02:00', 
    'REFERRAL', 
    'USER_CODE_USED', 
    '100000', 
    'HUNDREDTH_CENT', 
    'USD', 
    'primary_bonus_pool', 
    'primary_cash', 
    'some_client_co', 
    'INDIVIDUAL', 
    'whole_universe from #{{"specific_accounts": ["96faba31-09fe-4e2f-9cd2-1d23213c5f78","0e78aab2-4197-42bd-8d06-42678b5f519e"]}}', 
    '{"REDEEMED":["save_completed_by #{0e78aab2-4197-42bd-8d06-42678b5f519e}","first_save_by #{0e78aab2-4197-42bd-8d06-42678b5f519e}"]}'::jsonb, 
    '{"accountId":"96faba31-09fe-4e2f-9cd2-1d23213c5f78","msgInstructionId":"ffbe52e0-0614-40d0-8c74-af64603397c1"}'::jsonb,
    '{"accountId":"0e78aab2-4197-42bd-8d06-42678b5f519e","msgInstructionId":"1ec54a50-5cfd-4e92-858a-9121b4280966"}'::jsonb) 
returning boost_id, creation_time