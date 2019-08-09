'use strict';

const logger = require('debug')('jupiter:save:main');
const config = require('config');
const moment = require('moment-timezone');
const status = require('statuses');

const persistence = require('./persistence/rds');

const warmupCheck = (event) => !event || typeof event !== 'object' || Object.keys(event).length === 0;
const warmupResponse = { statusCode: 400, body: 'Empty invocation' };

const invalidRequestResponse = (messageForBody) => ({ statusCode: 400, body: messageForBody });

const handleError = (err) => { 
  logger('FATAL_ERROR: ', err);
  return { statusCode: 500, body: JSON.stringify(err.message) };
};

const save = async (eventBody) => {
    const saveInformation = eventBody;
    logger('Have a saving request inbound: ', saveInformation);

    if (!eventBody.floatId && !eventBody.clientId) {
      const floatAndClient = await persistence.findClientAndFloatForAccount(saveInformation.accountId);
      saveInformation.floatId = eventBody.floatId || floatAndClient.floatId;
      saveInformation.clientId = eventBody.clientId || floatAndClient.clientId;
    }

    saveInformation.initiationTime = moment(saveInformation.initiationTimeEpochMillis);
    Reflect.deleteProperty(saveInformation, 'initiationTimeEpochMillis');

    if (Reflect.has(saveInformation, 'settlementTimeEpochMillis')) {
      saveInformation.settlementTime = moment(saveInformation.settlementTimeEpochMillis);
      Reflect.deleteProperty(saveInformation, 'settlementTimeEpochMillis');
    }
    
    logger('Sending to persistence: ', saveInformation);
    const savingResult = await persistence.addSavingToTransactions(saveInformation);

    logger('Completed the save, result: ', savingResult);

    return savingResult;
};

module.exports.settle = async (event) => {
  try {

    const settleInfo = event['body'] ? JSON.parse(event['body']) : event;
    logger('Settling payment, event: ', settleInfo);

    if (!settleInfo.transactionId) {
      return invalidRequestResponse('Error! No transaction ID provided');
    } else if (!settleInfo.paymentRef || !settleInfo.paymentProvider) {
      return invalidRequestResponse('Error! No payment reference or provider');
    }

    if (Reflect.has(settleInfo, 'settlementTimeEpochMillis')) {
      settleInfo.settlementTime = moment(settleInfo.settlementTimeEpochMillis);
      Reflect.deleteProperty(settleInfo, 'settlementTimeEpochMillis');
    } else {
      settleInfo.settlementTime = moment();
    }
    
    const paymentDetails = { 
      paymentProvider: settleInfo.paymentProvider,
      paymentRef: settleInfo.paymentRef
    };

    const resultOfUpdate = await persistence.updateSaveTxToSettled(settleInfo.transactionId, paymentDetails, settleInfo.settlementTime);
    logger('Completed the update: ', resultOfUpdate);

    return { statusCode: 200, body: JSON.stringify(resultOfUpdate) };

  } catch (err) {
    return handleError(err);
  }
};
  
/* Wrapper method, calls the above, after verifying the user owns the account, event params are:
 * @param {string} accountId The account where the save is happening
 * @param {number} savedAmount The amount to be saved
 * @param {string} savedCurrency The account where the save is happening
 * @param {string} savedUnit The unit for the save, preferably default (HUNDREDTH_CENT), but will transform
 * @param {string} floatId optional: the user's float (will revert to default if not provided)
 * @param {string} clientId optional: the user's responsible client (will use default as with float)
 * @return {object} transactionDetails and paymentRedirectDetails for the initiated payment
 */
module.exports.initiatePendingSave = async (event) => {
  try {
    if (warmupCheck(event)) {
      return warmupResponse;
    }

    const authParams = event.requestContext ? event.requestContext.authorizer : null;
    if (!authParams || !authParams.systemWideUserId) {
      return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
    }

    const saveInformation = JSON.parse(event.body);
    if (!saveInformation.accountId) {
      return invalidRequestResponse('Error! No account ID provided for the save');
    } else if (!saveInformation.savedAmount) {
      return invalidRequestResponse('Error! No amount provided for the save');
    } else if (!saveInformation.savedCurrency) {
      return invalidRequestResponse('Error! No currency specified for the saving event');
    } else if (!saveInformation.savedUnit) {
      return invalidRequestResponse('Error! No unit specified for the saving event');
    }
    
    // todo : make this check more robust 
    if (saveInformation.settlementTimeEpochMillis) { 
      saveInformation.settlementStatus = 'SETTLED';
    } else {
      saveInformation.settlementStatus = 'INITIATED';
    }

    if (!saveInformation.initiationTimeEpochMillis) {
      saveInformation.initiationTimeEpochMillis = moment().valueOf();
      logger('Initiation time: ', saveInformation.initiationTimeEpochMillis);
    }

    const initiationResult = await save(saveInformation);
    
    initiationResult.paymentRedirectDetails = {
      urlToCompletePayment: 'https://pay.here/1234'
    };

    return { statusCode: 200, body: JSON.stringify(initiationResult) };

  } catch (e) {
    logger('FATAL_ERROR: ', e);
    return { statusCode: status(500), body: JSON.stringify(e.message) };
  }
};

/* Method to change a pending save to complete. Wrapper. Once integration is done, will query payment provider first.
 */
module.exports.settleInitiatedSave = async (event) => {
  try {

    if (warmupCheck(event)) {
      return warmupResponse;
    }

    const authParams = event.requestContext.authorizer;
    if (!authParams || !authParams.systemWideUserId) {
      return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
    }

    // todo : check transaction ID, accountId and user Id match
    // todo : get default payment provider from client
    const settleInfo = JSON.parse(event.body);
    if (!settleInfo.paymentProvider) {
      settleInfo.paymentProvider = config.get('payment.default.name');
    }

    logger('Settling, with info: ', settleInfo);
    return exports.settle(settleInfo);
  } catch (err) {
    return handleError(err);
  }
};

/**
 * Checks on the backend whether this payment is done
 * @param {string} transactionId The transaction ID of the pending payment
 */
module.exports.checkPendingPayment = async (event) => {
  try {
    logger('Checking for payment with inbound event: ', event);
    const params = event.queryStringParameters ? event : event.queryStringParameters;
    const transactionId = params.transactionId;
    logger('Transaction ID: ', transactionId);

    let resultBody = { };
    if (params.failureType) {
      if (params.failureType === 'FAILED') {
        resultBody = { 
          result: 'PAYMENT_FAILED', 
          messageToUser: 'Sorry the payment failed for some reason, which we will explain, later. Please contact your bank' 
        };
      } else {
        resultBody = { result: 'PAYMENT_PENDING' };
      }
    } else {
      resultBody = { result: 'PAYMENT_SUCCEEDED' };
    }

    return { statusCode: 200, body: JSON.stringify(resultBody)};
  } catch (err) {
    return handleError(err);
  }
};
