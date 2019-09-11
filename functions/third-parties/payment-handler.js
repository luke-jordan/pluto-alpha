'use strict';

const logger = require('debug')('jupiter:third-parties:payment-handler');
const config = require('config');
const request = require('request-promise');
const crypto = require('crypto');

const POST_KEY_ORDER = config.get('ozow.postKeyOrder');


const warmupCheck = (event) => !event || typeof event !== 'object' || Object.keys(event).length === 0;

const generateHashCheck = (params) => {
    const pvtKey = config.get('ozow.privateKey');
    const hashFeed = (POST_KEY_ORDER.map((key) => '' + params[key]).join('') + pvtKey).toLowerCase();
    logger('Generated concat string:', hashFeed);
    return crypto.createHash('sha512').update(hashFeed).digest('hex');
};

const assembleBody = (params) => {
    const requiredProperties = config.get('ozow.requiredProperties');
    requiredProperties.forEach((key) => {
        if (!Object.keys(params).includes(key)) {
            throw new Error(`Missing required property: ${key}`); // return statusCode 400
        }
    });

    const body = {
        TransactionReference: params.transactionReference,
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
    qs: body,
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.get('ozow.apiKey')}` // base64 encode?
    },
    json: true
});


/**
 * This function gets a payment url from a third-party. All possible properties are included in the request
 * object but many are optional. Property descriptions for the event object accepted by this function are provided below.
 * @param {string} siteCode A unique code for the site currently in use.
 * @param {string} countryCode  The ISO 3166-1 alpha-2 code for the user's country. The country code will determine which banks will be displayed to the customer.
 * @param {string} currencyCode The ISO 4217 3 letter code for the transaction currency.
 * @param {number} amount The transaction amount. The amount is in the currency specified by the currency code posted.
 * @param {string} transactionReference The merchant's reference for the transaction.
 * @param {string} bankReference The reference that will be prepopulated in the "their reference" field in the customers online banking site.
 * @param {string} cancelUrl The Url that the third party should post the redirect result to if the customer cancels the payment, this will also be the page the customer gets redirected back to.
 * @param {string} errorUrl The Url that the third party should post the redirect result to if an error occurred while trying to process the payment, this will also be the page the customer gets redirect back to.
 * @param {string} successUrl The Url that we should post the redirect result to if the payment was successful, this will also be the page the customer gets redirect back to.
 * @param {boolean} isTest Send true to test your request posting and response handling. If set to true you will be redirected to a page where you can select whether you would like a successful or unsuccessful redirect response sent back. 
 * 
 * @returns {object} The payment url and request id.
 */
module.exports.getPaymentUrl = async (event) => {
    try {
        if (warmupCheck(event)) {
            logger('Recieved warm up event');
            const options = assembleRequest('POST', config.get('ozow.endpoints.warmup'), {});
            logger('Created warm up options:', options);
            const warmupResult = await request(options);
            return { statusCode: 200, body: JSON.stringify(warmupResult) };
        }

        if (event.dryRunFakeSuccess) {
            return {
                statusCode: 200,
                body: JSON.stringify({ paymentUrl: config.get('ozow.endpoints.dryRun') })
            };
        }

        const body = assembleBody(event);
        logger('Created body:', body);
        const options = assembleRequest('POST', config.get('ozow.endpoints.payment'), body);
        logger('Created request options:', options);
        try {
            const paymentUrlResponse = await request(options); // throws a redirection error on success
            throw new Error(paymentUrlResponse);
        } catch (err) {
            if (typeof err === 'object' && 'statusCode' in err) {
                if (err.statusCode === 302) {
                    const paymentEndpoint = err.response.headers.location; // how to get request id
                    return { statusCode: 200, body: JSON.stringify({ paymentUrl: `${config.get('ozow.endpoints.payment')}${paymentEndpoint}` }) };
                } else {
                    throw err;
                }
            } else {
                throw err;
            }
        }
    } catch (err) {
        logger('FATAL_ERROR:', JSON.stringify(err));
        return {
            statusCode: 500,
            body: JSON.stringify(err.message)
        };
    }
};
