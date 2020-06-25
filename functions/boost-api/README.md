## BOOST TYPES AND CATEGORIES

Top level is type. Second level is category. Pass to function using string in format, `type::category`, e.g., `SIMPLE::SIMPLE_SAVE`.

*  **Simple** : just offering a user a boost for some basic response, e.g., adding cash. Categories: SIMPLE_SAVE, ROUND_UP
*  **Referral** : a boost for using a referral code. Categories : USER_CODE_USED (referral is a user's), CHANNEL_CODE_USED, BETA_CODE_USED
*  **Game**: a boost that is tied to a game. Categories are implemented games, started with TAP_SCREEN and CATCH_ARROW.

## BOOST STATUS

As a user responds to a boost the status changes until it becomes REDEEMED, DISMISSED or EXPIRED. The status types are strictly ordered but it is not required that any particular user/account pass through all of them. The statuses are, in a happy path:

*  **CREATED**: Initial state for most boosts, meaning it has been created
*  **OFFERED**: The message that the boost is available has been sent, one way or another, to the user
*  **UNLOCKED**: Used primarily in game boosts. The user has performed the first action that allows them to partake in the boost, if that is necessary
*  **PENDING**: The user has done all necessary to redeem the boost, and some other condition must be settled, e.g., the referred user must complete an add cash, the game responses across all users must be collated
*  **REDEEMED**: The boost has been redeemed and the amount has been transferred to the user's account

There are two kinds of status related to whether a user actively dismissed a boost or just didn't respond:

*  **DISMISSED**: The user dismissed the message informing them of the boost (possibly multiple times)
*  **EXPIRED**: The user simply did not respond to the boost in time

## BOOST STATUS CONDITIONS

The progression of a user through the states of a boost is governed by the `statusConditions` dict, which, for each relevant state, provides the conditions for a user to reach that state. This uses another mini-DSL to operate, in which conditions have the form:

```<instruction> #{<<parameter(s)>>}```

Examples are found throughout the boost unit tests, but the simplest would be, `save_event_greater_than #{<<amount>>}`. All amounts are to be specified in our standard format, i.e., `AMOUNT::UNIT::CURRENCY`. The currently implemented status conditions are:

* `save_event_greater_than`: The user saves an amount more than the parameter. Expected paramater: amount to be cleared.
* `save_completed_by`: A save is completed by a user-account. Expected parameter: account ID.
* `first_save_by`: The save completed is the first one by the user-account. Expected parameter: account ID.

Game related conditions:

* `taps_submitted`: The user has submitted a number of taps (note: condition is just the event itself, e.g., for change to pending)
* `number_taps_greater_than`: The user made a number of taps greater than the parameter, within a certain time. The paramater is to be specified in the format, `NUMBER_TAPS::TIME_ALLOWED`. Time allowed must be in milliseconds.
* `number_taps_in_first_N`: The user made a number of taps in the first N of a certain number. The paramater is to be specified in the format, `POSITION_CUTOFF::TIME_ALLOWED`. The second part is as above.

