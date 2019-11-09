# AUDIENCE SELECTION CLAUSES

The best way to explain how this works is to show examples. We would do this by showing the final sql query and the JSON that generates that.


### Example 1 - Columns and Table

Say we wanted to choose all `users`:

The JSON structure the backend is expecting would be:

```
{
    "columns": ["account_id"],
    "table": "transactions"
}

```

This is equivalent to the SQL query: 
```
select account_id from transactions
```

The `columns` key is used to specify columns to be selected and the `table` key stands for the table to be selected from.
If the `columns` key or the `table` key is left out, then the assumption is `"columns": ["account_id"]` or `"table": "transaction_data.core_transaction_ledger"`

### Example 2  - Two Plus Columns

Say we wanted to choose all `users` and view their `sign up times`:

The JSON structure the backend is expecting would be:

```
{
    "columns": ["account_id", "creation_time"],
    "table": "transactions"
}

```

This is equivalent to the SQL query: 

```
select account_id, creation_time from transactions
```

### Example 3 - General Where Conditions
Say we wanted to choose `users` that have carried out a `saving event`:

The JSON structure the backend is expecting would be:

```
{
    "columns": ["account_id"],
    "table": "transactions",
    "conditions": [
        { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" }
    ]
}

```

This is equivalent to the SQL query: 

```
select account_id from transactions where transaction_type='USER_SAVING_EVENT'
```

`where` clauses are introduced above using three properties in the `conditions` key:
`op` represents the operation being carried out.
`prop` represents the column in the condition
`value` represents the value of the column


### Example 4 - And Conditions
Say we wanted to choose `users` that have carried out a `saving event` `AND` the status of the saving event is `settled`:

The JSON structure the backend is expecting would be:

```
{
    "columns": ["account_id"],
    "table": "transactions",
    "conditions": [{
        "op": "and", "children": [
            { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
            { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
        ]
     }]
}

```

This is equivalent to the SQL query:

```
select account_id from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')
```

More complex `where` clauses can be represented with the `and` operator.


### Example 5 - Or Conditions
Say we wanted to choose `users` that have carried out a `saving event` `OR` the status of the saving event is `settled`:


The JSON structure the backend is expecting would be:

```
{
    "columns": ["account_id"],
    "table": "transactions",
    "conditions": [{
        "op": "or", "children": [
            { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
            { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
         ]
     }]
}

```

This is equivalent to the SQL query: 
```
select account_id from transactions where (transaction_type='USER_SAVING_EVENT' or settlement_status='SETTLED')
```

More complex `where` clauses can also be represented with the `or` operator.


### Example 6 - Simple `or`/`and` conditions
Say we wanted to choose `users` that have carried out a (`saving event` `AND` the status of the saving event is `settled`)
`OR` (users that signed up on `2019-01-27`)

The JSON structure the backend is expecting would be:

```
{
    "table": "transactions",
    "conditions": [{
        "op": "or", "children": [
            { "op": "and", "children": [
                { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
            ]},
            { "op": "is", "prop": "creation_time", "value": "2019-01-27" }
        ]
    }]
}

```

This is equivalent to the SQL query::

```
select account_id from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27')
```

More complex `where` clauses can also be represented with the `and`/`or` operator.

`N/B`: `account_id` stands for the default column when a "columns" key is not passed.


### Example 7 - `or` / `and` / `and` conditions
Say we wanted to choose `users` that have carried out a (`saving event` `AND` the status of the saving event is `settled`)
`OR` (users that signed up on `2019-01-27` and their responsible_client_id is `1`)

The JSON structure the backend is expecting would be:

```
{
    "table": "transactions",
    "conditions": [{
        "op": "or", "children": [
            { "op": "and", "children": [
                { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
                { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
            ]},
            { "op": "and", "children": [
                { "op": "is", "prop": "creation_time", "value": "2019-01-27" },
                { "op": "is", "prop": "responsible_client_id", "value": 1, "type": "int" }
            ]}
        ]
    }]
}
```

This is equivalent to the SQL query:

```
select account_id from transactions where ((transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') or creation_time='2019-01-27')
```

More complex `where` clauses can also be represented with the `or` / `and` / `and` operator.


Here we also introduce the `type: int` key which indicates that the value is an integer and thus is represented as an integer and not a string


### Example 8 - Random Samples

The JSON structure the backend is expecting would be:

```
{
    "table": "transactions",
    "sample": { random: 50 },
    "conditions": [{
        "op": "and", "children": [
            { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
            { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
        ]
    }]
}

```

This is equivalent to the SQL query:

```
select account_id from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') order by random() limit 50
```

This covers selecting random samples after selecting users based on conditions.

The key `sample` and subkey `random` is used to specify that a random percentage (in this case the percentage=50) of the users selected using the conditions should be returned. 
This means that if 200 users were initially returned from the query, half (50%) of them would be selected at random and returned to the client.


### Example 9 - Group By Filters


The JSON structure the backend is expecting would be:

```
{
    "table": "transactions",
    "columns": ["responsible_client_id", "creation_time"],
    "conditions": [{
        "op": "and", "children": [
            { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
            { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
        ]
    }],
    "groupBy": ["responsible_client_id"]
}

```

This is equivalent to the SQL query:

```
select responsible_client_id, creation_time from transactions where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED') group by responsible_client_id
```

The `groupBy` key covers selecting `group by` filters and can be expanded into multiple columns.

### Example 10 - Columns to Count

The JSON structure the backend is expecting would be:

```
{
    "table": "transactions",
    "columns": ["responsible_client_id"],
    "columnsToCount": ["account_id"],
    "groupBy": ["responsible_client_id"]
}

```

This is equivalent to the SQL query:

```
select responsible_client_id, count(account_id) from transactions group by responsible_client_id
```

The `columnsToCount` key covers selecting columns to count and can be expanded into multiple columns.

### Example 11 - Having Filters

The JSON structure the backend is expecting would be:

```
{
    "table": "transactions",
    "columns": ["responsible_client_id"],
    "columnsToCount": ["account_id"],
    "groupBy": ["responsible_client_id"],
    "postConditions": [{ "op": "is", "prop": "count(account_id)", "type": "int", "value": 20 }]
}
```

This is equivalent to the SQL query:

```
select responsible_client_id, count(account_id) from transactions group by responsible_client_id having count(account_id)=20
```

The `postConditions` key covers `having` filters.


## List of all operators supported
Operators are used in the `where` clauses and `having` clauses.
The operators supported by the backend and their representations include:

`is` => `=`

`greater_than` => `>`

`greater_than_or_equal_to` => `>=`

`less_than` => `<`

`less_than_or_equal_to` => `<=`

The filters supported include:
`where`

`group by`

`having`


The types of `value` default to `string` and could be specified as `int` when necessary


## Typical Real World Scenarios

### Example 12 - get user ids based on sign_up intervals
Say we wanted to choose `users` that `signed up` between `2018-07-01` and `2019-11-23`

The JSON structure the backend is expecting would be:

```
{    
    "table": "transactions",
    "conditions": [{
        "op": "and", "children": [
            { "op": "greater_than_or_equal_to", "prop": "creation_time", "value": "2018-07-01" },
            { "op": "less_than_or_equal_to", "prop": "creation_time", "value": "2019-11-23" }
        ]
    }]
}

```

This is equivalent to the SQL query:

```
select account_id from transactions where (creation_time>='2018-07-01' and creation_time<='2019-11-23')
```

`sign_up` intervals are represented with the `>=` and `<=` operators which replaces sql's `between` operator


### Example 13 - get user ids based on activity counts
Say we wanted to choose `users` with activity counts between `10` and `50`

The JSON structure the backend is expecting would be:
```
{
    "columns": ["account_id"],
    "columnsToCount": ["account_id"],
    "table": "transactions",
    "conditions": [{
        "op": "and", "children": [
            { "op": "is", "prop": "transaction_type", "value": "USER_SAVING_EVENT" },
            { "op": "is", "prop": "settlement_status", "value": "SETTLED" }
        ]
    }],
    "groupBy": ["account_id"],
    "postConditions": [{
        "op": "and", "children": [
            {"op": "greater_than_or_equal_to", "prop": "count(account_id)", "type": "int", "value": 10},
            {"op": "less_than_or_equal_to", "prop": "count(account_id)", "type": "int", "value": 50}
        ]
    }]
}
```

This is equivalent to the SQL query:

```
    select account_id, count(account_id) from transactions
    where (transaction_type='USER_SAVING_EVENT' and settlement_status='SETTLED')
    group by account_id having (count(account_id)>=10 and count(account_id)<=50)
```

## SENDING & RECURRENCE INSTRUCTIONS

Note: Messages are 'sent' when they are dispatched via PN or when they are fetched by a pull call from the app.

Messages and boosts can be programmed to "recur". That means they will be created again on a regular basis. This is used for generic placeholder type messages, such as descriptions of the user's prior saving history or reminders about the possibility of random boosts.
These instructions required parameters passed as a JSON in recurrenceInstructions:

* `minIntervalDays`: Minimum interval between messages being shown to user. Measured in days.
* `maxInQueue`: The maximum number of messages in the user's queue before this message is skipped. If it is 0, the message will only be assembled for the user if nothing else is in the queue.

In future we may also add a means to weight the recurrence. For now, setting priorities will achieve much the same. If two recurrent messages are due for presentation, and one is higher priority than the other, it will be processed first, after which max other messages may be triggered. So a recurrent message with a priority of 0 and a max other message setting of 0 will only ever be shown if there is nothing else.

Message instruction statusses:

* `CREATED`:
* `READY_FOR_GENERATING`:
* `MESSAGES_GENERATED`:


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