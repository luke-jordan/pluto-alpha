-- Adding these and then some complex stuff for legacy
alter table message_data.message_instruction add column trigger_parameters jsonb;

update message_data.message_instruction 
    set trigger_parameters = json_build_object('triggerEvent', json_build_array(substring(flags[1], 13)))
    where array_to_string(flags, '||') like 'EVENT_TYPE::%';

-- Note, not wiping the prior flags, because not much point
