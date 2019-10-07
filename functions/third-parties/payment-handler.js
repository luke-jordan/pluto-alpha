'use strict';

const logger = require('debug')('jupiter:third-parties:payment-handler');
const config = require('config');
const uuid = require('uuid/v4');
const request = require('request-promise');
const crypto = require('crypto');

const POST_KEY_ORDER = config.get('ozow.postKeyOrder');
const RESPONSE_KEY_ORDER = config.get('ozow.responseKeyOrder');
const pvtkey = config.get('ozow.privateKey');


const warmupCheck = (event) => !event || typeof event !== 'object' || Object.keys(event).length === 0;

const generateHashCheck = (params) => {
    const hashFeed = (POST_KEY_ORDER.map((key) => '' + params[key]).join('') + pvtkey).toLowerCase();
    logger('Created hash feed:', hashFeed);
    return crypto.createHash('sha512').update(hashFeed).digest('hex');
};

// const isValidHash = (response) => {
//     const hashCheck = response.Hash;
//     const hashFeed = (RESPONSE_KEY_ORDER.map((key) => '' + response[key]).join('') + pvtkey).toLowerCase();
//     const derivedHash = crypto.createHash('sha512').update(hashFeed).digest('hex');
//     return (hashCheck === derivedHash);
// };

const assembleBody = (params) => {
    const requiredProperties = config.get('ozow.requiredProperties');
    requiredProperties.forEach((key) => {
        if (!Object.keys(params).includes(key)) {
            throw new Error(`Missing required property: ${key}`); // return statusCode 400
        }
    });

    const body = {
        TransactionReference: params.transactionId,
        BankReference: params.bankReference,
        CancelUrl: params.cancelUrl ? params.cancelUrl : config.get('ozow.endpoints.cancelUrl'),
        ErrorUrl: params.errorUrl ? params.errorUrl : config.get('ozow.endpoints.errorUrl'),
        SuccessUrl: params.successUrl ? params.successUrl : config.get('ozow.endpoints.successUrl'),
        IsTest: params.isTest,
        SiteCode: config.get('ozow.siteCode'),
        CountryCode: params.countryCode,
        CurrencyCode: params.currencyCode,
        Amount: params.amount
    };

    const hashCheck = generateHashCheck(body);
    logger('Generated hashCheck:', hashCheck);
    body.HashCheck = hashCheck;
    return body;
};

const assembleRequest = (method, endpoint, body) => ({
    method: method,
    uri: endpoint,
    body: body,
    headers: {
        'Accept': 'application/json',
        'ApiKey': config.get('ozow.apiKey')
    },
    json: true
});


/**
 * This function gets a payment url from a third-party. Property descriptions for the event object accepted by this function are provided below. Further information may be found here https://ozow.com/integrations/ .
 * @param {string} countryCode  Required. The ISO 3166-1 alpha-2 code for the user's country. The country code will determine which banks will be displayed to the customer.
 * @param {string} currencyCode Required. The ISO 4217 3 letter code for the transaction currency.
 * @param {number} amount Required. The transaction amount. The amount is in the currency specified by the currency code posted.
 * @param {string} transactionId Required. The merchant's reference for the transaction.
 * @param {string} bankReference Required. The reference that will be prepopulated in the "their reference" field in the customers online banking site.
 * @param {string} cancelUrl Optional. The Url that the third party should post the redirect result to if the customer cancels the payment, this will also be the page the customer gets redirected back to.
 * @param {string} errorUrl Optional. The Url that the third party should post the redirect result to if an error occurred while trying to process the payment, this will also be the page the customer gets redirect back to.
 * @param {string} successUrl Optional. The Url that the third party should post the redirect result to if the payment was successful, this will also be the page the customer gets redirect back to.
 * @param {boolean} isTest Required. Send true to test your request posting and response handling. If set to true you will be redirected to a page where you can select whether you would like a successful or unsuccessful redirect response sent back. 
 * 
 * @returns {object} The payment url and request id.
 */
module.exports.payment = async (event) => {
    try {
        if (warmupCheck(event)) {
            const options = assembleRequest('POST', config.get('ozow.endpoints.warmup'), {});
            const warmupResult = await request(options);
            logger('Warm up result:', warmupResult); 
            return { result: 'WARMUP_COMPLETE' };
        }

        if (event.dryRunFakeSuccess) {
            return { result: 'PAYMENT_INITIATED', paymentUrl: config.get('ozow.endpoints.dryRun'), requestId: uuid() };
        }

        const body = assembleBody(event);
        const options = assembleRequest('POST', config.get('ozow.endpoints.payment'), body);
        logger('Created request options:', options);
        const paymentResponse = await request(options); // throws a redirection error on success
        logger('Payment url ?', paymentResponse);

        if (!paymentResponse || typeof paymentResponse !== 'object') {
            throw new Error(`Unexpected response from third party: ${paymentResponse}`);
        }

        if (paymentResponse.errorMessage) {
            throw new Error(paymentResponse.errorMessage);
        };

        return {
            result: 'PAYMENT_INITIATED',
            paymentUrl: paymentResponse.url,
            requestId: paymentResponse.paymentRequestId
        };
    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            result: 'PAYMENT_FAILED',
            details: err.message
        };
    }
};


/**
 * This method gets the tranaction status of a specified payment. Accepted event properties are defined below.
 * @param {string} transactionId The merchant's reference for the transaction.
 * @param {boolean} IsTest Defaults to true. All calls in production must include this property set to false.
 * 
 * @returns {object} A subset of the returned status object containing the transaction status (result), createdDate, and paymentDate.
 * All properties (including those not returned to the caller) are listed below.
 * @property {string} transactionId The third parties unique reference for the transaction.
 * @property {string} merchantCode Unique code assigned to each merchant.
 * @property {string} siteCode Unique code assigned to each merchant site.
 * @property {string} transactionReference The merchants transaction reference (The transaction id passed during payment initialisation).
 * @property {string} currencyCode The transaction currency code.
 * @property {number} amount The transaction amount.
 * @property {string} status The transaction status. Possible values are 'Complete', 'Cancelled', and 'Error'.
 * @property {string} statusMessage Message regarding the status of the transaction. This field will not always have a value.
 * @property {datetime} createdDate Transaction created date and time.
 * @property {datetime} paymentDate Transaction payment date and time.
 * @see {@link https://ozow.com/integrations/} for further information.
 */

module.exports.status = async (event) => {
    try {
        const params = {
            SiteCode: config.get('ozow.siteCode'),
            TransactionReference: event.transactionId,
            IsTest: event.isTest ? event.isTest : true
        };
        const options = assembleRequest('GET', config.get('ozow.endpoints.transactionStatus'), params);
        logger('Created status options:', options);
        const paymentStatus = await request(options);
        logger('Recieved payment status:', paymentStatus);

        const formattedResponse = {
            result: paymentStatus[0].status.toUpperCase(),
            createdDate: paymentStatus[0].createdDate,
            paymentDate: paymentStatus[0].paymentDate
        };

        return formattedResponse;

    } catch (err) {
        logger('FATAL_ERROR:', err);
        return {
            result: 'ERROR',
            details: err.message
        };
    }
};