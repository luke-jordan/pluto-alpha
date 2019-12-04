# Referral Management Handler

## Functions

<a name="defineReferralContext"></a>

## defineReferralContext(params)
Sets the referral context, itself used for things like boosts based on the code
NOTE : on reflection, we are _not_ normalizing this so that client-float referral details are pulled from its tables on each
use, because that would impose a trade-off between updating referral-boost details for future users and having to communicate
it to existing users. As it is, future users can have boost from their referral code adjusted, while prior ones do not

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| params | <code>object</code> | The params passed into the parent function. Must have float ID and client ID. Can have boost details in requestContext, otherwise for user referral codes they will be drawn from the client-float defaults. If they are passed in, require: |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| boostAmountOffered | <code>string</code> | In our standard pattern of amount::unit::currency |
| boostSource | <code>string</code> | A client ID, a floatID, and a bonus pool Id |

<a name="create"></a>

## create(event)
**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event objet containing a referral code, code type, the system wide id of its creator, and its expiry time in millieseconds. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| referralCode | <code>string</code> | The referral code. |
| codeType | <code>string</code> | The code type. |
| creatingUserId | <code>string</code> | The system wide id of the referrals creator. |
| expiryTimeMillis | <code>string</code> | When the referral code should expire. |

<a name="verify"></a>

## verify(event)
This function verifies a referral code.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the referral code to be evaluated. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| referralCode | <code>string</code> | The referralCode to be verified. |

<a name="modify"></a>

## modify()
To be implemented: This function updates a referral code.

**Kind**: global function  
