# User Messaging API

## Functions

<a name="placeParamsInTemplate"></a>

## placeParamsInTemplate(template, passedParameters)
NOTE: This is only for custom params supplied with the message-creation event. System defined params should be left alone.
This function assembles the selected template and inserts relevent data where required.
todo : make sure this handles subparams on standard params (e.g., total_interest::since etc)

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| template | <code>\*</code> | The selected template. |
| passedParameters | <code>\*</code> | Extra parameters sent with the callers request. If parameters contain known proporties such as parameters.boostAmount then the associated actions are executed. With regards to boost amount it is extracted from request parameters and inserted into the boost template. |

<a name="processNonRecurringInstruction"></a>

## processNonRecurringInstruction(instructionDetail)
This function accepts an instruction detail object containing an instruction id, the destination user id, and extra parameters.
It uses these details to retrieve the associated instruction from persistence, assemble the user message(s), and finally persists the assembled user message(s) to RDS.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| instructionDetail | <code>object</code> | An object containing the following properties: instructionId, destinationUserId, and parameters. These are elaborated below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| instructionId | <code>string</code> | The instruction id assigned during instruction creation. |
| destinationUserId | <code>string</code> | Optional. This overrides the user ids indicated in the persisted message instruction's selectionInstruction property. |
| parameters | <code>object</code> | Required when assembling boost message. Contains details such as boostAmount, which is inserted into the boost template. |

<a name="createUserMessages"></a>

## createUserMessages(event)
A wrapper for simple instruction processing, although can handle multiple at once
note: this is only called for once off or event driven messages )i.e., invokes the above)

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An object containing an array of instruction detail objects. Each instruction detail object contains an instruction id, the instructions destination user id, and an object of extra parameters. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| instructions | <code>array</code> | An array of instruction identifier objects. Each instruction in the array may have the following properties: |
| instructionId | <code>string</code> | The instruction id assigned during instruction creation. |
| destinationUserId | <code>string</code> | Optional. This overrides the user ids indicated in the persisted message instruction's selectionInstruction property. |
| parameters | <code>object</code> | Required when assembling boost message. Contains details such as boostAmount, which is inserted into the boost template.tr |

<a name="createFromRecurringInstructions"></a>

## createFromRecurringInstructions()
This runs on a scheduled job. It processes any once off and recurring instructions that have not been processed yet.

**Kind**: global function  
<a name="assembleMessage"></a>

## assembleMessage(messageDetails)
This function assembles user messages into a persistable object. It accepts a messageDetails object as its only argument.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| messageDetails | <code>Object</code> | An object containing the message details. This object contains the following properties: |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| messageId | <code>String</code> | The message's id. |
| messageTitle | <code>String</code> | The message's title. |
| messagePriority | <code>Number</code> | The message's priority (ranging from 0 to 10, with 0 being the lowest and q0 being the highest priority) |
| display | <code>Object</code> | An object conataining additional icons to display within the message, e.g. { type: 'MODAL', iconType: 'SMILEY_FACE' } |
| creationTime | <code>String</code> | The message's creation time. |
| hasFollowingMessage | <code>Boolean</code> | a boolean value indicating whether the current message other message following it. |
| followsPriorMessage | <code>Boolean</code> | A boolean value indicating whether the current message follows other messages. |
| actionContext | <code>Object</code> | An object containing optional actions to be run during message assembly. For example { triggerBalanceFetch: true, boostId: '61af5b66-ad7a...' } |
| messageSequence | <code>Object</code> | An object containing details such as messages to display on the success of the current message. An example object: { msgOnSuccess: '61af5b66-ad7a...' } |

<a name="fetchAndFillInNextMessage"></a>

## fetchAndFillInNextMessage(destinationUserId, withinFlowFromMsgId)
This function fetches and fills in the next message in a sequence of messages.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| destinationUserId | <code>string</code> | The messages destination user id. |
| withinFlowFromMsgId | <code>string</code> | The messageId of the last message in the sequence to be processed prior to the current one. |

<a name="getNextMessageForUser"></a>

## getNextMessageForUser(event)
Wrapper for the above, based on token, i.e., direct fetch

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An object containing the request context, with request body being passed as query string parameters. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers id, roles, and permissions. The event will not be processed without a valid request context. |
| queryStringParameters | <code>object</code> | This functions accepts an lambda event passed via query string parameters. The queryStringParameters object may have the following properties: |
| queryStringParameters.gameDryRun | <code>boolean</code> | Set to true to run a dry run operation, else omit or set to false to run full function operations. |
| queryStringParameters.anchorMessageId | <code>string</code> | If message is part of a sequence, this property contains the messageId of the last processed message in the sequence before the current one. |

<a name="updateUserMessage"></a>

## updateUserMessage(event)
Simple (ish) method for updating a message once it has been delivered, etc.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An object containing the request context and request body. The body has message id and user action properties, detailed below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers system wide user id, role, and permissions. The event will not be processed without a valid request context. |
| body.messageId | <code>string</code> | The messageId of the message to me updated. |
| body.userAction | <code>string</code> | The value to update the message option with. Valid values in this context are FETCHED and DISMISSED. |

<a name="insertPushToken"></a>

## insertPushToken(event)
This function inserts a push token object into RDS. It requires that the user calling this function also owns the token.
An evaluation of the requestContext is run prior to token manipulation. If request context evaluation fails access is forbidden.
Non standared propertied are ignored during the assembly of the persistable token object.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An object containing the users id, push token provider, and the push token. Details below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| userId | <code>string</code> | The push tokens owner. |
| provider | <code>string</code> | The push tokens provider. |
| token | <code>string</code> | The push token. |

<a name="deletePushToken"></a>

## deletePushToken(event)
This function accepts a token provider and its owners user id. It then searches for the associated persisted token object and deletes it from the 
database. As during insertion, only the tokens owner can execute this action. This is implemented through request context evaluation, where the userId
found within the requestContext object must much the value of the tokens owner user id.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An object containing the request context object and a body object. The body contains the users system wide id and the push tokens provider. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| userId | <code>string</code> | The tokens owner user id. |
| provider | <code>string</code> | The tokens provider. |

<a name="sendPushNotifications"></a>

## sendPushNotifications(params)
This function is responsible for sending push notifications.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| params | <code>object</code> | An optional object containing an array of system wide user ids. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| systemWideUserIds | <code>Array</code> | An optional array of system wide user ids who will serve as reciepients of the push notifications. |

<a name="validateMessageInstruction"></a>

## validateMessageInstruction(instruction)
Enforces instruction rules and ensures the message instruction is valid before it is persisted.
First it asserts whether all required properties are present in the instruction object. If so, then
condtional required properties are asserted. These are properties that are only required under certain condtions.
For example, if the message instruction has a recurring presentation then a recurrance instruction is required to
describe how frequently the notification should recur. The object properties received by this function are described below:

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| instruction | <code>object</code> | An instruction object. This objects properties are described below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| instructionId | <code>string</code> | The instruction unique id, useful in persistence operations. |
| presentationType | <code>string</code> | Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN. |
| active | <code>boolean</code> | Indicates whether the message is active or not. |
| audienceType | <code>string</code> | Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS. |
| templates | <code>object</code> | Required. Message instruction must include at least one template, ie, the notification message to be displayed |
| selectionInstruction | <code>object</code> | Required when audience type is either INDIVIDUAL or GROUP. |
| recurrenceParameters | <code>object</code> | Required when presentation type is RECURRING. Describes details like recurrence frequency, etc. |
| responseAction | <code>string</code> | Valid values include VIEW_HISTORY and INITIATE_GAME. |
| responseContext | <code>object</code> | An object that includes details such as the boost ID. |
| startTime | <code>string</code> | A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now. |
| endTime | <code>string</code> | A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time. |
| messagePriority | <code>number</code> | An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller). |

<a name="createPersistableObject"></a>

## createPersistableObject(instruction, creatingUserId)
todo : validate templates
This function takes the instruction passed by the caller, assigns it an instruction id, activates it,
and assigns default values where none are provided by the input object.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| instruction | <code>object</code> | An instruction object. Its properties are detailed below. |
| creatingUserId | <code>string</code> | The system wide id of the user creating the instruction. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| instruction.presentationType | <code>string</code> | Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN. |
| instruction.audienceType | <code>string</code> | Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS. |
| instruction.defaultTemplate | <code>string</code> | Required when otherTemplates is null. Templates describe the message to be shown in the notification. |
| instruction.otherTemplates | <code>string</code> | Required when defaultTemplate is null. |
| instruction.selectionInstruction | <code>object</code> | Required when audience type is either INDIVIDUAL or GROUP. |
| instruction.recurrenceParameters | <code>object</code> | Required when presentation type is RECURRING. Describes details like recurrence frequency, etc. |
| instruction.eventTypeCategory | <code>string</code> | The event type and category for this instruction, controlled by caller's logic (e.g., REFERRAL::REDEEMED::REFERRER); |

<a name="insertMessageInstruction"></a>

## insertMessageInstruction(event)
This function accepts a new instruction, validates the instruction, then persists it. Depending on the instruction, either
the whole or a subset of properties described below may provided as input. 

Note on templates: They can construct linked series of messages for users, depending on the top-level key, which can be either
"template", or "sequence". If it template, then only one message is generated, if it is sequence, then multiple are, and are linked.
Template contains the following: at least one top-level key, DEFAULT. Other variants (e.g., for A/B testing), can be defined as 
other top-level keys (e.g., VARIANT_A or TREATMENT). Underneath that key comes the message definition proper, as follows:
{ title: 'title of the message', body: 'body of the message', display: { displayDict }, responseAction: { }, responseContext: { dict }} 

If the top-level key is sequence, then an array should follow. The first message in the array must be the opening message, and will be 
marked as hasFollowingMessage. All the others will be marked as followsPriorMessage. Each element of the array will be identical to 
that for a single template, as above, but will also include the key, "identifier". This will be used to construct the messageIdsDict
that will be sent with each of the messages, so that the app or any other consumers can follow the sequences. Note that it is important
to keep the two identifiers distinct here: one, embedded within the template, is an identifier within the sequence of messages, the other,
at top level, identifies across variants.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An object containing the request context and a body containing the instruction to be persisted. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers id, role, and permissions. The event will not be processed without a valid request context. The properties listed below belong to the events body. |
| instructionId | <code>string</code> | The instructions unique id, useful in persistence operations. |
| presentationType | <code>string</code> | Required. How the message should be presented. Valid values are RECURRING, ONCE_OFF and EVENT_DRIVEN. |
| active | <code>boolean</code> | Indicates whether the message is active or not. |
| audienceType | <code>string</code> | Required. Defines the target audience. Valid values are INDIVIDUAL, GROUP, and ALL_USERS. |
| template | <code>string</code> | Provides message templates, as described above |
| selectionInstruction | <code>object</code> | Required when audience type is either INDIVIDUAL or GROUP. |
| recurrenceParameters | <code>object</code> | Required when presentation type is RECURRING. Describes details like recurrence frequency, etc. |
| responseAction | <code>string</code> | Valid values include VIEW_HISTORY and INITIATE_GAME. |
| responseContext | <code>object</code> | An object that includes details such as the boost ID. |
| startTime | <code>string</code> | A Postgresql compatible date string. This describes when this notification message should start being displayed. Default is right now. |
| endTime | <code>string</code> | A Postgresql compatible date string. This describes when this notification message should stop being displayed. Default is the end of time. |
| lastProcessedTime | <code>string</code> | This property is updated eah time the message instruction is processed. |
| messagePriority | <code>number</code> | An integer describing the notifications priority level. O is the lowest priority (and the default where not provided by caller). |

<a name="updateInstruction"></a>

## updateInstruction(event)
This function can be used to update various aspects of a message. Note that if it 
deactivates the message instruction, that will stop all future notifications from message instruction,
and removes existing ones from the fetch queue.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An object containing the request context, and an instruction id and update object in the body. Properties of the event body are described below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| instructionId | <code>string</code> | The message instruction ID assigned during instruction creation. |
| updateValues | <code>object</code> | Key-values of properties to update (e.g., { active: false }) |

<a name="getMessageInstruction"></a>

## getMessageInstruction(event)
This function accepts an instruction id and returns the associated message instruction from the database.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An object containing the id of the instruction to be retrieved. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| instructionId | <code>string</code> | The message instruction ID assigned during instruction creation. |

<a name="listActiveMessages"></a>

## listActiveMessages(event)
This function (which will only be available to users with the right roles/permissions) will list currently active messages,
i.e., those that are marked as active, and, optionally, those that still have messages unread by users

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>string</code> | An object containing the request context and a body object containing a boolean property which indicates whether to include pending instructions in the resulting listing. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>Object</code> | An object containing the callers id, role, and permissions. The event will not be processed without a valid request context. |
| includeStillDelivering | <code>boolean</code> | A boolean value indicating whether to include messages that are still deliverig in the list of active messages. |

