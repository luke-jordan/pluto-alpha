# Admin API

## Functions

<a name="fetchUserCounts"></a>

## fetchUserCounts(event)
Gets the user counts for the front page, usign a mix of parameters. Leaving out a parameter will invoke a default

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event containing the request context and the request body. The body's properties a decribed below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| startTimeMillis | <code>string</code> | If left out, default is set by config but will generally be six months ago |
| endTimeMillis | <code>string</code> | If left out, default is set to now |
| includeNewButNoSave | <code>boolean</code> | determines whether to include in the count accounts that were created in the time window but have not yet had a settled save transaction. This can be useful for diagnosing drop outs |

<a name="assembleClientFloatData"></a>

## assembleClientFloatData(countriesAndClients, clientFloatItems)
Knits together a variety of data to assemble the float totals, names, etc., for the current clients & floats

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| countriesAndClients | <code>array</code> | List of countries and the clients that operate in them |
| clientFloatItems | <code>array</code> | The floats, from the flat table |

<a name="fetchClientFloatVars"></a>

## fetchClientFloatVars(event)
The function fetches client float variables.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context, which has information about the caller. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers id, role, and permissions. The event will not be processed without a valid request context. |

