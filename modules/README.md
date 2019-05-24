# PERSISTENCE WRAPPER MODULES

This folder contains two modules that wrap around and simplify common persistence tasks, namely interfacing with 
DynamoDB tables and RDS instances. In time others for common tasks will likely be added. For simplicity, both are documented here.

**Note 1**: These are included in the Lambdas that use them as packages, so they will be zipped up in the deployment package
in the version at the time of deployment, the same as any other dependencies of that Lambda. Thus a change in the code
of these wrappers will only affect Lambdas that use them if/when those Lambdas are redeployed.

**Note 2**: These have been written to be as little opinionated as possible and leave primary flexibility in the hands of the
calling functions. As a result at times they may require arguments that appear redundant (e.g., in the RDS insertion methods).
Calling lambdas can easily write their own opinionated mini-wrappers around these common modules.

## RDS-COMMON

### Initiation

The RdsConnection class requires a config object that tells it: the host, port, user, password and database for the connection.
If the port and host are ommitted then the global defaults for this environment are used. The class will make calls through to
the pooling and connection handling layer. **Note**: Keep an eye on behaviour as Lambdas scale to avoid connection-proliferation.

### Simple queries

For simple select and single-row updates (we have no use case for multi-row updates), the wrappers are self-explanatory. Note
that passing in an argument list is enforced as required, to ensure that SQL queries are never directly composed. That is, only
ever use queries of the `select column_name1, column_name2 from table_name where column_name3 = $1`, with `$1` passed in as the
first argument in the parameter list.

### Insertions, large and small

The Node Postgres library is low level, and we are avoiding ORM or other such frameworks for reasons of simplicity and 
robustness. That does however require somewhat extensive wrapping to handle large-scale insertion.

The basic structure of calls to the two functions is to pass in: 

1.  The query structure ('template'), including the column clause as you wish it, and a placeholder `%L` (list) for where you want the list of 
concatenated values to be inserted. For example, for a user table which auto-inserts user id and creation time given personal info,
the query template might look as follows: ``insert into users (personal_name, family_name, email_address) values %L returning user_id, creation_time``

2.  An instruction for how to take an object and map it to the set of values representing a single row that the final query will need, the 
'column template'. The template consists of a column separated, ordered set of key names, surrounded by `${}` and in order. Continuing the example above, and for the object described below, the column template might look like: ``${firstName}, ${surName}, ${emailAddress}``

3.  An array of objects to translate into the rows of the insertion query. For example: ``[ { firstName: 'Luke', surName: 'Jordan', 'emailAddress': 'luke@plutosaving.com'}]``.

*Note*: As shown here, the key names in the column template must correspond to the **object** keys, not the column names. It is up to the calling function whether to make the labels the same, see note on flexibility above.

*Note*: The wrapper has been designed and tested to accommodate and execute very large insertions (10k+ records) efficiently. All calls are wrapped in a transaction and rolled back as one on failure (this applies as well to the multi-table insert, i.e., all inserts will be rolled 
back if one fails).

### Errors

*  The methods will throw a `NoValuesError` if they are not passed an array of parameter values (see note above under 'simple queries').
*  The methods will throw a `QueryError` if an error is thrown either in the formatting of the query, by the Node Postgres library, or as a 
query syntax error by Postgres itself.
*  The methods will throw a `CommitError` if something goes wrong during the transaction and does not fall under the above headings, e.g., 
if there is a unique value or key error.

## Dynamo-Common

### Initiation

The module has a much simpler initiation. However, note that the assumption is that the lambda using it has whatever permissions are 
required to operate on the tables in question.

### Retrieving an item

The method will automatically convert from camel case (our convention for code) to underscores (our convention for persistence).

Other methods will be added as and when they are needed.