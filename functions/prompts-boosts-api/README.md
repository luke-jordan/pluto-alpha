# PROMPTS, MESSAGES, BOOSTS

Collection of functions for generating, selecting, assembling messages

## Message syntax

Messages get assembled, currently from default templates, soon from A/B tests. They use a templating syntax to
pull certain user data. The syntax is as follows:

```
Since July 2019 you have earned R%{interest_earned[from:2019-06-01,to:current_timestamp]} in interest
```

That is, the template is `%{}` to demarcate, with the variable of interest and time parameters in []. These are:
These pieces of data are:

* interest_earned: total amount of interest earned
* amount_saved: total amount the user has saved

Messages also carry an instruction of the type of action the user can take. These are:

* save_now: initiate a saving event / sequence
* view_history: go to account history page

Etc.
