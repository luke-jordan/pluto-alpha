# Float API

## Functions

<a name="balanceCheck"></a>

## balanceCheck()
Temporary convenience to check some things in connection etc

**Kind**: global function  
<a name="accrue"></a>

## accrue(event)
The core function. Receives an instruction that interest (or other return) has been accrued, increases the balance recorded,
and then allocates the amounts to the client's bonus and company shares, and thereafter allocates to all accounts with 
contributions to the float in the past. Expects the following parameters in the lambda invocation or body of the post

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing request body. The request body's properties are described below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| clientId | <code>string</code> | The system wide ID of the client that handles the float that is receiving the accrual |
| floatId | <code>string</code> | The system wide ID of the float that has received an accrual |
| accrualAmount | <code>number</code> | The amount of the accrual, in the currency and units passed in the other parameters |
| currency | <code>string</code> | The currency of the accrual. If not provided, defaults to the currency of the float. |
| unit | <code>string</code> | The units in which the amount is expressed. If not provided, defaults to float default. |
| backingEntityIdentifier | <code>string</code> | An identifier for the backing transaction (e.g., the accrual tx ID in the wholesale institution) |

<a name="allocate"></a>

## allocate(event)
Divides up all the allocations, records them, and does a massive batch insert as a single TX
If one allocation does not succeed, all need to be redone, otherwise the calculations will go (way) off
Note: this is generally the heart of the engine, and will require constant and continuous optimization, it will be 
triggered whenever another job detects unallocated amounts in the float.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing request body. The request body's properties are listed below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| clientId | <code>string</code> | The client co that this allocation event relates to |
| floatId | <code>string</code> | The float that is being allocated |
| currency | <code>string</code> | The currency of the allocation |
| unit | <code>string</code> | The units of the amount |
| totalAmount | <code>number</code> | The total amount being allocated |
| backingEntityIdentifier | <code>string</code> | (Optional) If this allocation relates to some other entity, what is its identifier |
| backingEntityType | <code>string</code> | (Optional) If there is a backing / related entity, what is it (e.g., accrual transaction) |

<a name="calculateShare"></a>

## calculateShare(totalPool, shareInPercent, roundEvenUp)
Utility method to reliably calculate a share, using BigNumber and a lot of tests to enforce robustness and avoid 
possible floating point issues. It is exported as (1) it might graduate to its own lambda, and (2) although small
it is the kind of thing that can crash spaceships into planets so it needs to be tested very very thoroughly on its own

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| totalPool | <code>number</code> | What is the total pool that we are dividing |
| shareInPercent | <code>number</code> | What is the share we are calculating. NOTE: Given in standard percent form, i.e., between 0 and 1 |
| roundEvenUp | <code>boolean</code> | Whether to round 0.5 to 1 or to 0 |

<a name="sumUpBalances"></a>

## sumUpBalances(accountBalances)
A utility method to sum up all the account balances

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| accountBalances | <code>Map</code> | A map of account balances, with account ids as keys and balances as values |

<a name="apportion"></a>

## apportion(amountToDivide, accountTotals, appendExcess)
Core calculation method. Apportions an amount (i.e., the unallocated amount of a float) among an arbitrary length list of accounts
in proportion to each of those account's balances. Note that the share of the total allocated to a specific account is not that account's
balance divided by the total to be allocated, but that account's balance divided by the total balance of all the passed accounts.
Returns a new map with (again) the account ids as keys, but the values being the amount apportioned to the account from the total

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| amountToDivide | <code>number</code> | The total amount to split among the accounts |
| accountTotals | <code>Map</code> | A map of all accounts, with their IDs as keys and current balances as values |
| appendExcess | <code>boolean</code> | If true (default), then if there is an 'excess', i.e., a remainder due to rounding in the allocations, that amount (positive if there are cents left over or negative if the reverse) is appended to the result map with the key 'excess' |

<a name="floatTransfer"></a>

## floatTransfer(instructions)
This function handles float transfer instructions. Event properties are described below.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| instructions | <code>array</code> | An array containing transfer instruction objects. |

