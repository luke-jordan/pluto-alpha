'use strict';

const logger = require('debug')('jupiter:save:main');
const moment = require('moment-timezone');
const status = require('statuses');

const publisher = require('publish-common');

const persistence = require('./persistence/rds');
const payment = require('./payment-link');

const warmupCheck = (event) => !event || typeof event !== 'object' || Object.keys(event).length === 0;
const warmupResponse = { statusCode: 400, body: 'Empty invocation' };

const invalidRequestResponse = (messageForBody) => ({ statusCode: 400, body: messageForBody });

const handleError = (err) => { 
  logger('FATAL_ERROR: ', err);
  return { statusCode: 500, body: JSON.stringify(err.message) };
};

// todo : remove need for this in app soon
const legacyKeyFix = (passedSaveDetails) => {
  const saveDetails = { ...passedSaveDetails };
  saveDetails.amount = saveDetails.amount || saveDetails.savedAmount;
  saveDetails.unit = saveDetails.unit || saveDetails.savedUnit;
  saveDetails.currency = saveDetails.currency || saveDetails.savedCurrency;
  ['savedAmount', 'savedUnit', 'savedCurrency'].forEach((key) => Reflect.deleteProperty(saveDetails, key));
  return saveDetails;
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

// can _definitely_parallelize this, also:
// todo : will need to stash the bank ref
const assemblePaymentInfo = async (saveInformation, transactionId) => {
  const accountStemAndCount = await persistence.fetchInfoForBankRef(saveInformation.accountId);
  const accountInfo = {
    bankRefStem: accountStemAndCount.humanRef,
    priorSaveCount: accountStemAndCount.count
  };

  const amountDict = {
    amount: saveInformation.amount,
    unit: saveInformation.unit,
    currency: saveInformation.unit
  };

  return { transactionId, accountInfo, amountDict };
};
  
/** Wrapper method, calls the above, after verifying the user owns the account, event params are:
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
    
    logger('Verified user system ID, publishing event');
    await publisher.publishUserEvent(authParams.systemWideUserId, 'SAVING_EVENT_INITIATED');
    logger('Finished publishing event');

    const saveInformation = legacyKeyFix(JSON.parse(event.body));

    if (!saveInformation.accountId) {
      return invalidRequestResponse('Error! No account ID provided for the save');
    } else if (!saveInformation.amount) {
      return invalidRequestResponse('Error! No amount provided for the save');
    } else if (!saveInformation.currency) {
      return invalidRequestResponse('Error! No currency specified for the saving event');
    } else if (!saveInformation.unit) {
      return invalidRequestResponse('Error! No unit specified for the saving event');
    }
    
    saveInformation.settlementStatus = 'INITIATED';

    if (!saveInformation.initiationTimeEpochMillis) {
      saveInformation.initiationTimeEpochMillis = moment().valueOf();
      logger('Initiation time: ', saveInformation.initiationTimeEpochMillis);
    }

    // todo : verify user account ownership
    const initiationResult = await save(saveInformation);
    
    // go and get a payment link
    let urlToCompletePayment = 'https://pay.here/1234';
    if (saveInformation.testProperLink) {
      const paymentInfo = await assemblePaymentInfo(saveInformation, initiationResult.transactionId);
      const paymentLinkResult = await payment.getPaymentLink(paymentInfo);
      logger('Got payment link result: ', paymentLinkResult); // todo : stash the bank ref & payment provider ref
      urlToCompletePayment = paymentLinkResult.paymentUrl;
    }

    initiationResult.paymentRedirectDetails = { urlToCompletePayment };

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
      settleInfo.paymentProvider = 'OZOW';
    }

    logger('Settling, with info: ', settleInfo);
    return exports.settle(settleInfo);
  } catch (err) {
    return handleError(err);
  }
};

const handlePaymentFailure = (failureType) => {
  logger('Payment failed, consider how and return which way');
  if (failureType === 'FAILED') {
    return { 
      result: 'PAYMENT_FAILED', 
      messageToUser: 'Sorry the payment failed for some reason, which we will explain, later. Please contact your bank' 
    };
  } 
  return { result: 'PAYMENT_PENDING' };
};

// note: we can definitely optimize this guy when combined with the others (e.g., stick the relevant details in return clause on update)
const publishSaveSucceeded = async (systemWideUserId, transactionId) => {
  const txDetails = await persistence.fetchTransaction(transactionId);
  const count = await persistence.countSettledSaves(txDetails.accountId);
  logger(`For account ${txDetails.accountId}, how many prior saves? : ${count}`);

  const context = {
    transactionId,
    accountId: txDetails.accountId,
    timeInMillis: txDetails.settlementTime,
    firstSave: count === 1,
    saveCount: count,
    savedAmount: `${txDetails.amount}::${txDetails.unit}::${txDetails.currency}`
  };

  logger('Triggering publish, with context: ', context);
  await publisher.publishUserEvent(systemWideUserId, 'SAVING_PAYMENT_SUCCESSFUL', { context });
};

/**
 * Checks on the backend whether this payment is done
 * todo: validation that the TX belongs to the user
 * @param {string} transactionId The transaction ID of the pending payment
 */
module.exports.checkPendingPayment = async (event) => {
  try {
    const authParams = event.requestContext ? event.requestContext.authorizer : null;
    if (!authParams || !authParams.systemWideUserId) {
      return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
    }
    
    logger('Checking for payment with inbound event: ', event);
    const params = event.queryStringParameters || event;
    logger('Extracted params: ', params);
    const transactionId = params.transactionId;
    logger('Transaction ID: ', transactionId);

    await publisher.publishUserEvent(authParams.systemWideUserId, 'SAVING_EVENT_PAYMENT_CHECK', { context: { transactionId }});

    let resultBody = { };
    const paymentSuccessful = !params.failureType; // for now
    if (paymentSuccessful) {
      const dummyPaymentRef = `some-payment-reference-${(new Date().getTime())}`;
      const resultOfSave = await exports.settle({ transactionId, paymentProvider: 'OZOW', paymentRef: dummyPaymentRef });
      
      logger('Result of save: ', resultOfSave);
      resultBody = JSON.parse(resultOfSave.body);
      resultBody.result = 'PAYMENT_SUCCEEDED';
      
      await publishSaveSucceeded(authParams.systemWideUserId, transactionId);
    } else {
      resultBody = handlePaymentFailure(params.failureType);
    }

    return { statusCode: 200, body: JSON.stringify(resultBody)};
  } catch (err) {
    return handleError(err);
  }
};
