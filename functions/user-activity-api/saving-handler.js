'use strict';

const logger = require('debug')('jupiter:save:main');
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

module.exports.save = async (event) => {
    try {
      if (warmupCheck(event)) {
        return warmupResponse;
      }
      
      const settlementInformation = event['body'] ? JSON.parse(event['body']) : event;
      logger('Have a saving request inbound: ', settlementInformation);
  
      if (!settlementInformation.accountId) {
        return invalidRequestResponse('Error! No account ID provided for the save');
      } else if (!settlementInformation.savedAmount) {
        return invalidRequestResponse('Error! No amount provided for the save');
      } else if (!settlementInformation.savedCurrency) {
        return invalidRequestResponse('Error! No currency specified for the saving event');
      } else if (!settlementInformation.savedUnit) {
        return invalidRequestResponse('Error! No unit specified for the saving event');
      } else if (!settlementInformation.settlementStatus) {
        return invalidRequestResponse('Error! No settlement status passed');
      }
  
      if (!settlementInformation.floatId && !settlementInformation.clientId) {
        const floatAndClient = await persistence.findClientAndFloatForAccount(settlementInformation.accountId);
        settlementInformation.floatId = settlementInformation.floatId || floatAndClient.floatId;
        settlementInformation.clientId = settlementInformation.clientId || floatAndClient.clientId;
      }
  
      settlementInformation.initiationTime = moment(settlementInformation.initiationTimeEpochMillis);
      Reflect.deleteProperty(settlementInformation, 'initiationTimeEpochMillis');
  
      if (Reflect.has(settlementInformation, 'settlementTimeEpochMillis')) {
        settlementInformation.settlementTime = moment(settlementInformation.settlementTimeEpochMillis);
        Reflect.deleteProperty(settlementInformation, 'settlementTimeEpochMillis');
      }
      
      const savingResult = await persistence.addSavingToTransactions(settlementInformation);

      logger('Completed the save, result: ', savingResult);
  
      return {
        statusCode: 200,
        body: JSON.stringify(savingResult)
      };
    } catch (err) {
      return handleError(err);
    }
};

module.exports.settle = async (event) => {
  try {
    if (warmupCheck(event)) {
      return warmupResponse;
    }

    const settlementInformation = event['body'] ? JSON.parse(event['body']) : event;
    logger('Settling payment, event: ', settlementInformation);

    if (!settlementInformation.transactionId) {
      return invalidRequestResponse('Error! No transaction ID provided');
    } else if (!settlementInformation.paymentRef || !settlementInformation.paymentProvider) {
      return invalidRequestResponse('Error! No payment reference or provider');
    }

    if (Reflect.has(settlementInformation, 'settlementTimeEpochMillis')) {
      settlementInformation.settlementTime = moment(settlementInformation.settlementTimeEpochMillis);
      Reflect.deleteProperty(settlementInformation, 'settlementTimeEpochMillis');
    } else {
      settlementInformation.settlementTime = moment();
    }



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
module.exports.initatePendingSave = async (event) => {
  try {
    const authParams = event.requestContext.authorizer;
    if (!authParams || !authParams.systemWideUserId) {
      return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
    }

    const saveInformation = JSON.parse(event.body);
    saveInformation.settlementStatus = 'INITIATED';
    
    if (!saveInformation.initiationTimeEpochMillis) {
      saveInformation.initiationTimeEpochMillis = moment().valueOf();
      logger('Initiation time: ', saveInformation.initiationTimeEpochMillis);
    }

    return exports.save(saveInformation);

  } catch (e) {
    logger('FATAL_ERROR: ', e);
    return { statusCode: status(500), body: JSON.stringify(e.message) };
  }
};

/* Method to change a pending save to complete. Wrapper. Will be used by payment method eventually.
 */
module.exports.updateIncompleteSave = async (event) => {

}
