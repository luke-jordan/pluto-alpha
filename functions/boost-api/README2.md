# Boost API

## Functions

<a name="listBoosts"></a>

## listBoosts(event)
Lists boosts, with optional param to restrict to currently running ones.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers id, role, and permissions. The event will not be processed without a valid request context. |
| includeReferrals | <code>boolean</code> | Includes referrals when set to true. |
| includeUserCounts | <code>boolean</code> | Includes a includeUserCounts property with each returned object. |
| includeExpired | <code>boolran</code> | When set to true the resulting listing includes boosts that have expired. |

<a name="updateInstruction"></a>

## updateInstruction(event)
Flexible method/endpoint to update a boost, more or less any parameter

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers id, role, and permissions. The event will not be processed without a valid request context. |
| body | <code>object</code> | An object containing the properties to be updated and their values. |

<a name="createMsgInstructionFromDefinition"></a>

## createMsgInstructionFromDefinition(boostParams, messageDefinition, gameParams)
Assembles instruction payloads from messages created by admin user while they create the boost.
This depends on a message definition of the form:
{ presentationType, isMessageSequence, msgTemplates }
msgTemplates must be a dict with keys as boost statuses and objects a standard message template (see messages docs for format)

**Kind**: global function  

| Param | Type |
| --- | --- |
| boostParams | <code>\*</code> | 
| messageDefinition | <code>\*</code> | 
| gameParams | <code>\*</code> | 

<a name="createBoost"></a>

## createBoost(event)
The primary method here. Creates a boost and sets various other methods into action
Note, there are three ways boosts can have their messages assigned:
(1) Include an explicit set of redemption message instructions ('redemptionMsgInstructions')
(2) Include a set of message instruction flags (i.e., ways to find defaults), as a dict with top-level key being the status ('messageInstructionFlags')
(3) Include the message definitions in messages to create ('messagesToCreate')

Note (1): There is a distinction between (i) a message that is presented in a linked sequence, as in a game, and (ii) multiple messages
that are independent of each other, e.g., a push notification and an in-app card. The first case comes in a single message definition
because the messages must be sent to the app together; the second comes in multiple definitions.

Note (2): If multiple of the types above are passed, (3) will override the others (as it is called last)
Also note that if none are provided the boost will have no message and just hang in the ether

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| creatingUserId | <code>string</code> | The system wide user id of the user who is creating the boost. |
| boostTypeCategory | <code>string</code> | A composite string containing the boost type and the boost category, seperated by '::'. For example, 'SIMPLE::TIME_LIMITED'. |
| boostBudget | <code>string/number</code> | This may either be a number or a composite key containing the amount, the unit, and the currency, seperated by '::', e.g '10000000::HUNDREDTH_CENT::USD'. |
| startTimeMillis | <code>string</code> | A moment formatted date string indicating when the boost should become active. Defaults to now if not passed in by caller. |
| endTime | <code>string</code> | A moment formatted date string indicating when the boost should be deactivated. Defaults to 50 from now (true at time of writing, configuration may change). |
| boostSource | <code>object</code> | An object containing the bonusPoolId, clientId, and floatId associated with the boost being created. |
| statusConditions | <code>object</code> | An object containing an string array of DSL instructions containing details like how the boost should be saved. |
| boostAudience | <code>sting</code> | A string denoting the boost audience. Valid values include GENERAL and INDIVIDUAL. |
| boostAudienceSelection | <code>string</code> | A DSL string containing instructions as to which users to send the boost to. |
| redemptionMsgInstructions | <code>array</code> | An optional array containing message instruction objects. Each instruction object typically contains the accountId and the msgInstructionId. |
| messageInstructionFlags | <code>object</code> | An optional object with details on how to extract default message instructions for the boost being created. |

<a name="createBoostWrapper"></a>

## createBoostWrapper(event)
Wrapper method for API gateway, handling authorization via the header, extracting body, etc.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers id, role, and permissions. The event will not be processed without a valid request context. |
| creatingUserId | <code>string</code> | The system wide user id of the user who is creating the boost. |
| boostTypeCategory | <code>string</code> | A composite string containing the boost type and the boost category, seperated by '::'. For example, 'SIMPLE::TIME_LIMITED'. |
| boostBudget | <code>string/number</code> | This may either be a number or a composite key containing the amount, the unit, and the currency, seperated by '::', e.g '10000000::HUNDREDTH_CENT::USD'. |
| startTimeMillis | <code>string</code> | A moment formatted date string indicating when the boost should become active. Defaults to now if not passed in by caller. |
| endTime | <code>string</code> | A moment formatted date string indicating when the boost should be deactivated. Defaults to 50 from now (true at time of writing, configuration may change). |
| boostSource | <code>object</code> | An object containing the bonusPoolId, clientId, and floatId associated with the boost being created. |
| statusConditions | <code>object</code> | An object containing an string array of DSL instructions containing details like how the boost should be saved. |
| boostAudience | <code>sting</code> | A string denoting the boost audience. Valid values include GENERAL and INDIVIDUAL. |
| boostAudienceSelection | <code>string</code> | A DSL string containing instructions as to which users to send the boost to. |
| redemptionMsgInstructions | <code>array</code> | An optional array containing message instruction objects. Each instruction object typically contains the accountId and the msgInstructionId. |
| messageInstructionFlags | <code>object</code> | An optional object with details on how to extract default message instructions for the boost being created. |

<a name="processEvent"></a>

## processEvent(event)
note: possibly in time we can put this on an SQS queue, for now using a somewhat
generic handler for any boost relevant response (add cash, solve game, etc)

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| userId | <code>string</code> | The users id. |
| accountId | <code>string</code> | The account id. Either the user id or the account id must be provided. |

<a name="processUserBoostResponse"></a>

## processUserBoostResponse(event)
Note: Not fully implemented yet.
This function will process user boost resoponses.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers id, role, and permissions. The event will not be processed without a valid request context. |

