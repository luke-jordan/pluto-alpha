# User Existence API

## Functions

<a name="createAccount"></a>

## createAccount(creationRequest)
Creates an account within the core ledgers for a user. Returns the persistence result of the transaction.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| creationRequest | <code>object</code> | An object containing the properties described below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| clientId | <code>string</code> | The id of the client company responsible for this user and account |
| defaultFloatId | <code>string</code> | The id for the _default_ float that the user will save to (can be overriden on specific transactions) |
| ownerUserId | <code>string</code> | The system wide ID of the user opening the account |

<a name="create"></a>

## create(event)
This function serves as a wrapper around the createAccount handler, processing events from API Gateway.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. The request body properties are decribed below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| clientId | <code>string</code> | The id of the client company responsible for this user and account. |
| defaultFloatId | <code>string</code> | The id for the _default_ float that the user will save to (can be overriden on specific transactions). |
| ownerUserId | <code>string</code> | The system wide ID of the user opening the account. |

