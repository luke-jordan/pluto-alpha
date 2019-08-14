# JUPITER ENTITIES, LANGUAGE, ETC

## EXPLANATION OF ENTITY TYPES

Some of the terms used for core pieces of the entity structure could be confusing (e.g., what is a client and what is a user).
This file is therefore the canonical source of truth for what these terms mean, and what the entities represent.

### User

An individual person who is saving money. That is, the ultimate end user, who sees the mobile app, and who adds funds to their
account, which is tied to a float, which is managed by a Pluto client.

### Account

A means of grouping transactions made by a user. In general, users will have only one account, but the architecture does not hard-wire
that choice, so in the future users might be able to possess multiple accounts. Also, an account may not necessarily be opened by the
user that owns it (e.g., since accounts can be gifted to someone)

### Client

A company in a specific jurisdiction that is the legal entity which provides financial services to users, and which utilizes Pluto's 
technology to do so. How exactly a client company manages the settlement etc process (ie., if deposits pass through its own account)
is defined by their processes, regulatory requirements in their jurisdiction, etc. The Pluto platform helps them manage those processes
with an extremely high degree of robustness and automation

### Float

A pool of user funds that a client is responsible for intermediating. In the simplest case, this will be a set of time deposits or funds
in money market funds that a user adds money to and a client is managing / intermediating. So each float 'belongs' to a client. Each time
a client saves money that is deposited in a float and a corresponding allocation of the float to the user is made. Each time a float 
accrues interest or any other form of return that is allocated among the users who have deposited into that float.

### Bonus pool

A portion of the float which is reserved for offering rewards to the users who are part of that float, for them to increase their 
contribution. Each float has its own bonus pool (though in time we might migrate this to be client-level), and an amount of the 
float's realized returns that should accumulate to the bonus pool

### Client share

A portion of the float's realized returns that are reserved for the clients, as their revenue. This share is configured per client
and per float.

## AUDIENCE SELECTION CLAUSES

Various core operations require that a group of users is selected from among the user base. The syntax for such audience selection must be persisted with the relevant instruction (e.g., a message send or boost offer). The syntax is as follows:

```method_of_selection #{optional_parameters_for_method} from #{universe_for_selection}```

The current options for ```method_of_selection`` are:

* `whole_universe`: selects all users in the universe (note: a universe can be a single user) 
* `random_sample` : takes a random sample. Optional parameter: proportion of universe to sample, from 0 to 1.
* `match_other`: selects the exact same users as some other audience-selecting entity (e.g., a message instruction matching a boost)

The universe for selection must be a stringified JSON dict, with the following possible keys:

* `client_id`: all users for a specific client (can be an array)
* `float_id`: all users for a specific float (can also be an array)
* `matching_entity`: a sub-object, of the form: { entityType, entityId }
* `specific_users`: a specific set of user IDs, as an array. *Variant*: `specific_accounts` where accounts are provided instead of users directly.
* `@cumulative`: a true/false flag (default is false) that switches between conditions being "and" vs "or", i.e., if users are selected at the intersection of the conditions or if they meet just one

Notes on requirements for some of these selections:

* `all_users` requires one of client_id, float_id or specific users
* `random_sample` requires the same as `all_users`
* `match_other` requires matching_entity

**NB**: In general, the use of this language biases to containing mistakes, i.e., if things are left out or left vague the minimal possible interpretation will be taken. For example, setting client_id and specific_users without specifying @cumulative as true will message one user, not all users for a client.

