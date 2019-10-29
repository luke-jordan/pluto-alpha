# Third Party Integrations

# Bank Account Verification

## Functions

<a name="initialize"></a>

## initialize(event)
This function enables verifications on consumer bank account details to determine the state and 
validity of a South African bank account. The Following banks are supported ABSA; FNB; STANDARD, NEDBANK, CAPITEC. 
Processing Times – Although the service is available 24 x 7 x 365, records received after 17:00 on 
weekdays, will only be submitted on the next available working day. Records are only submitted for 
verification after 03:00 AM on normal weekdays. Responses may be available within 30 minutes, but it 
could take up to 3+ hours to receive responses from participating banks.
This function returns a job status and job id in its response.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request body. The event body's properties are described below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| bankName | <code>string</code> | Name of bank can be any of the following - (ABSA, FNB, STANDARDBANK, NEDBANK, CAPITEC). |
| accountNumber | <code>string</code> | Bank account number of account holder. |
| accountType | <code>string</code> | Bank account type of account holder (CURRENTCHEQUEACCOUNT,SAVINGSACCOUNT,TRANSMISSION,BOND). |
| reference | <code>string</code> | Your Search Reference - Internal use. |
| initials | <code>string</code> | if Verification Type is Individual, this will be the initials of person. |
| surname | <code>string</code> | if Verification Type is Individual, this will be the persons Surname. |
| nationalId | <code>string</code> | if Verification Type is Individual, this will be the persons ID Number. |

<a name="checkStatus"></a>

## checkStatus(event)
This function is used with the response from initialize(), you will receive a JobID in the result of
the verification which will be used to check on the status of the bank account verification.

**Kind**: global function  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request context and request body. The event body's properties are described below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| jobId | <code>string</code> | JobId returned from the bank account verification API |

# Payment Url And Transaction Status Check

<a name="paymentUrlRequest"></a>

## paymentUrlRequest(event) ⇒ <code>object</code>
This function gets a payment url from a third-party. Property descriptions for the event object accepted by this function are provided below. Further information may be found here https://ozow.com/integrations/ .

**Kind**: global function  
**Returns**: <code>object</code> - The payment url and request id.  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request body. The body's properties are described below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| countryCode | <code>string</code> | Required. The ISO 3166-1 alpha-2 code for the user's country. The country code will determine which banks will be displayed to the customer. |
| currencyCode | <code>string</code> | Required. The ISO 4217 3 letter code for the transaction currency. |
| amount | <code>number</code> | Required. The transaction amount. The amount is in the currency specified by the currency code posted. |
| transactionId | <code>string</code> | Required. The merchant's reference for the transaction. |
| bankReference | <code>string</code> | Required. The reference that will be prepopulated in the "their reference" field in the customers online banking site. |
| cancelUrl | <code>string</code> | Optional. The Url that the third party should post the redirect result to if the customer cancels the payment, this will also be the page the customer gets redirected back to. |
| errorUrl | <code>string</code> | Optional. The Url that the third party should post the redirect result to if an error occurred while trying to process the payment, this will also be the page the customer gets redirect back to. |
| successUrl | <code>string</code> | Optional. The Url that the third party should post the redirect result to if the payment was successful, this will also be the page the customer gets redirect back to. |
| isTest | <code>boolean</code> | Required. Send true to test your request posting and response handling. If set to true you will be redirected to a page where you can select whether you would like a successful or unsuccessful redirect response sent back. |

<a name="statusCheck"></a>

## statusCheck(event) ⇒ <code>object</code>
This method gets the tranaction status of a specified payment.

**Kind**: global function  
**Returns**: <code>object</code> - A subset of the returned status object containing the transaction status (result), createdDate, and paymentDate.
All properties (including those not returned to the caller) are listed below.  
**See**: [https://ozow.com/integrations/](https://ozow.com/integrations/) for further information.  

| Param | Type | Description |
| --- | --- | --- |
| event | <code>object</code> | An event object containing the request body. Accepted body properties are defined below. |

**Properties**

| Name | Type | Description |
| --- | --- | --- |
| transactionId | <code>string</code> | The merchant's reference for the transaction. |
| isTest | <code>boolean</code> | Defaults to true. All calls in production must include this property set to false. |
| transactionId | <code>string</code> | The third parties unique reference for the transaction. |
| merchantCode | <code>string</code> | Unique code assigned to each merchant. |
| siteCode | <code>string</code> | Unique code assigned to each merchant site. |
| transactionReference | <code>string</code> | The merchants transaction reference (The transaction id passed during payment initialisation). |
| currencyCode | <code>string</code> | The transaction currency code. |
| amount | <code>number</code> | The transaction amount. |
| status | <code>string</code> | The transaction status. Possible values are 'Complete', 'Cancelled', and 'Error'. |
| statusMessage | <code>string</code> | Message regarding the status of the transaction. This field will not always have a value. |
| createdDate | <code>datetime</code> | Transaction created date and time. |
| paymentDate | <code>datetime</code> | Transaction payment date and time. |

