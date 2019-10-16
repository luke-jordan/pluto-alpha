## Functions

<dl>
<dt><a href="#payment">payment(event)</a> ⇒ <code>object</code></dt>
<dd><p>This function gets a payment url from a third-party. Property descriptions for the event object accepted by this function are provided below. Further information may be found here <a href="https://ozow.com/integrations/">https://ozow.com/integrations/</a> .</p>
</dd>
<dt><a href="#status">status(event)</a> ⇒ <code>object</code></dt>
<dd><p>This method gets the tranaction status of a specified payment.</p>
</dd>
</dl>

<a name="payment"></a>

## payment(event) ⇒ <code>object</code>
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

<a name="status"></a>

## status(event) ⇒ <code>object</code>
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
| IsTest | <code>boolean</code> | Defaults to true. All calls in production must include this property set to false. |
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

