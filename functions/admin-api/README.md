# Admin API

## Functions

<dl>
<dt><a href="#assembleClientFloatData">assembleClientFloatData(countriesAndClients, clientFloatItems)</a></dt>
<dd><p>Knits together a variety of data to assemble the float totals, names, etc., for the current clients &amp; floats</p>
</dd>
<dt><a href="#listClientsAndFloats">listClientsAndFloats(event)</a></dt>
<dd><p>The function fetches client float variables.</p>
</dd>
<dt><a href="#fetchClientFloatDetails">fetchClientFloatDetails()</a></dt>
<dd><p>Fetches the details on a client float, including, e.g., accrual rates, referral codes, also soon competitor rates
as well as float logs, which it scans for &#39;alerts&#39; (i.e., certain types of logs)</p>
</dd>
<dt><a href="#adjustClientFloat">adjustClientFloat()</a></dt>
<dd><p>Handles a variety of client-float edits, such as: (a) editing accrual rates and the like, (b) dealing with logs
Note: will be called from different endpoints but consolidating as single lambda</p>
</dd>
<dt><a href="#manageReferralCodes">manageReferralCodes()</a></dt>
<dd><p>Operations: CREATE, MODIFY, DEACTIVATE, LIST</p>
</dd>
<dt><a href="#writeLog">writeLog(event)</a></dt>
<dd><p>This function write a user log. If a binary file is included the file is uploaded to s3 and the path to
the file is stored in the user logs event context.</p>
</dd>
<dt><a href="#fetchLog">fetchLog(event)</a></dt>
<dd><p>This file fetches a user log. If the s3 file path of a binary file is found the file is retrieved and
return with the function ooutput.</p>
</dd>
<dt><a href="#uploadLogBinary">uploadLogBinary(event)</a></dt>
<dd><p>Uploads a log associated attachment. Returns the uploaded attachment&#39;s s3 key.</p>
</dd>
<dt><a href="#manageUser">manageUser()</a></dt>
<dd></dd>
<dt><a href="#fetchUserCounts">fetchUserCounts(event)</a></dt>
<dd><p>Gets the user counts for the front page, usign a mix of parameters. Leaving out a parameter will invoke a default</p>
</dd>
<dt><a href="#findUsers">findUsers(event)</a></dt>
<dd><p>Function for looking up a user and returning basic data about them</p>
</dd>
<dt><a href="#runRegularJobs">runRegularJobs()</a></dt>
<dd><p>Runs daily. Does several things:
(1) checks for accruals on each float &amp; then triggers the relevant job
(2) sends an email to the designated list with key stats for the day
(3) cleans up transaction ledger by setting old pending transactions to expired</p>
</dd>
</dl>

<a name="assembleClientFloatData"></a>

## assembleClientFloatData(countriesAndClients, clientFloatItems)
Knits together a variety of data to assemble the float totals, names, etc., for the current clients & floats

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| countriesAndClients | <code>array</code> | List of countries and the clients that operate in them |
| clientFloatItems | <code>array</code> | The floats, from the flat table |

<a name="listClientsAndFloats"></a>

## listClientsAndFloats(event)
The function fetches client float variables.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context, which has information about the caller. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers id, role, and permissions. The event will not be processed without a valid request context. |

<a name="fetchClientFloatDetails"></a>

## fetchClientFloatDetails()
Fetches the details on a client float, including, e.g., accrual rates, referral codes, also soon competitor rates
as well as float logs, which it scans for 'alerts' (i.e., certain types of logs)

**Kind**: global function  
<a name="adjustClientFloat"></a>

## adjustClientFloat()
Handles a variety of client-float edits, such as: (a) editing accrual rates and the like, (b) dealing with logs
Note: will be called from different endpoints but consolidating as single lambda

**Kind**: global function  
<a name="manageReferralCodes"></a>

## manageReferralCodes()
Operations: CREATE, MODIFY, DEACTIVATE, LIST

**Kind**: global function  
<a name="writeLog"></a>

## writeLog(event)
This function write a user log. If a binary file is included the file is uploaded to s3 and the path to
the file is stored in the user logs event context.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An admin event. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| systemWideUserId | <code>string</code> | The user id whom the log pertains to. |
| eventType | <code>string</code> | The type of event to be logged. |
| note | <code>string</code> | An optional note describing details relevant to the log. |
| file | <code>string</code> | An optional object containing the file path to an attachment file to be associated with the log being written. |

<a name="fetchLog"></a>

## fetchLog(event)
This file fetches a user log. If the s3 file path of a binary file is found the file is retrieved and
return with the function ooutput.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An admin event. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| systemWideUserId | <code>string</code> | The user whose logs we seek. |
| eventType | <code>string</code> | The log event type to be retrieved. |
| timestamp | <code>string</code> | The target event timestamp. |

<a name="uploadLogBinary"></a>

## uploadLogBinary(event)
Uploads a log associated attachment. Returns the uploaded attachment's s3 key.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An admin event. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| systemWideUserId | <code>string</code> | The system id of the user associated with the file attachment. |
| file | <code>object</code> | An object containing attachment information. The properties required by this function are { fileame, fileContent, mimeType }. |

<a name="manageUser"></a>

## manageUser()
**Kind**: global function  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| systemWideUserId | <code>string</code> | The ID of the user to adjust |
| fieldToUpdate | <code>string</code> | One of: KYC, STATUS, TRANSACTION |

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

<a name="findUsers"></a>

## findUsers(event)
Function for looking up a user and returning basic data about them

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and query paramaters specifying the search to make |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | As in method above (contains context, from auth, etc) |
| queryStringParamaters | <code>object</code> | Contains one of nationalId & country code, phone number, and email address |

<a name="runRegularJobs"></a>

## runRegularJobs()
Runs daily. Does several things:
(1) checks for accruals on each float & then triggers the relevant job
(2) sends an email to the designated list with key stats for the day
(3) cleans up transaction ledger by setting old pending transactions to expired

**Kind**: global function  
