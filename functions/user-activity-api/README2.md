# User Activity API

## Functions

## balance(event)
This function fetches account balances and projections.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. Body properties are described below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| accountId | <code>string</code> | The account id to obtain balance from. |
| clientId | <code>string</code> | The client id. |
| floatId | <code>string</code> | The float id. |
| currency | <code>string</code> | A three digit currency code. |
| atEpochMillis | <code>string</code> | The time the call to this function was made. |
| timezone | <code>string</code> | The callers timezone. |

<a name="balanceWrapper"></a>

## balanceWrapper(event)
This is a convenience method exposed to allow for simple JWT based get balance based on defaults
Here only the account holders system wide id is required as a parameter (which is passed in the events requestContext.authorizer object).

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| requestContext | <code>object</code> | An object containing the callers system wide id, role, and permissions. The event will not be processed without a valid request context. |

<a name="handleUserEvent"></a>

## handleUserEvent(snsEvent)
This function handles successful account opening, saving, and withdrawal events. It is typically called by SNS. The following properties are expected in the SNS message:

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| snsEvent | <code>object</code> | An SNS event object containing our parameter(s) of interest in its Message property. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| eventType | <code>string</code> | The type of event to be processed. Valid values are SAVING_PAYMENT_SUCCESSFUL, WITHDRAWAL_EVENT_CONFIRMED, and PASSWORD_SET (for opened accounts). |

<a name="initiatePendingSave"></a>

## initiatePendingSave(accountId, savedAmount, savedCurrency, savedUnit, floatId, clientId) ⇒ <code>object</code>
Wrapper method, calls the above, after verifying the user owns the account, event params are:

**Kind**: global function  
**Returns**: <code>object</code> - transactionDetails and paymentRedirectDetails for the initiated payment  

| Param | Type | Description |
| --- | --- | --- |
| accountId | <code>string</code> | The account where the save is happening |
| savedAmount | <code>number</code> | The amount to be saved |
| savedCurrency | <code>string</code> | The account where the save is happening |
| savedUnit | <code>string</code> | The unit for the save, preferably default (HUNDREDTH_CENT), but will transform |
| floatId | <code>string</code> | optional: the user's float (will revert to default if not provided) |
| clientId | <code>string</code> | optional: the user's responsible client (will use default as with float) |

<a name="checkPendingPayment"></a>

## checkPendingPayment(transactionId)
Checks on the backend whether this payment is done
todo: validation that the TX belongs to the user

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| transactionId | <code>string</code> | The transaction ID of the pending payment |

<a name="setWithdrawalBankAccount"></a>

## setWithdrawalBankAccount(event)
Initiates a withdrawal by setting the bank account for it, which gets verified, and then we go from there

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An evemt object containing the request context and request body. The request context contains details such as the callers system wide user id along with the callers roles and permissions. The request body contains the transaction information to be processed. Details on the request body's properties are provided below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| accountId | <code>string</code> | The account from which to withdraw. |
| bankDetails | <code>object</code> | An object containing bank details to be cached. |

<a name="setWithdrawalAmount"></a>

## setWithdrawalAmount(event)
Proceeds to next item, the withdrawal amount, where we create the pending transaction, and decide whether to make an offer

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| unit | <code>string</code> | The unit in which to carry out calculations. |
| currency | <code>string</code> | The transactions currency. |
| accountId | <code>string</code> | The accounts unique identifier. |

<a name="confirmWithdrawal"></a>

## confirmWithdrawal(event)
This function confirms a withdrawal.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. Body properties are described below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| transactionId | <code>string</code> | The transactions unique identifier. |
| userDecision | <code>string</code> | The users decision. Valid values are CANCEL AND WITHDRAW. |

