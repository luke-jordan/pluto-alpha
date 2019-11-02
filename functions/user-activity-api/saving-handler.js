'use strict';

const logger = require('debug')('jupiter:save:main');
const config = require('config');
const moment = require('moment-timezone');
const status = require('statuses');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

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
      const floatAndClient = await persistence.getOwnerInfoForAccount(saveInformation.accountId);
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
    const savingResult = await persistence.addTransactionToAccount(saveInformation);

    logger('Completed the save, result: ', savingResult);

    return savingResult;
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
    currency: saveInformation.currency
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
      logger('Warming up; tell payment link to stay warm, else fine');
      await payment.warmUpPayment();
      logger('Warmed payment, return');
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

    // todo : print a 'contact support?' in the URL if there is an error?
    const transactionId = initiationResult.transactionDetails[0].accountTransactionId;
    logger('Extracted transaction ID: ', transactionId);
    const paymentInfo = await assemblePaymentInfo(saveInformation, transactionId);
    const paymentLinkResult = await payment.getPaymentLink(paymentInfo);
    logger('Got payment link result: ', paymentLinkResult); // todo : stash the bank ref & payment provider ref
    const urlToCompletePayment = paymentLinkResult.paymentUrl;

    logger('Returning with url to complete payment: ', urlToCompletePayment);
    initiationResult.paymentRedirectDetails = { urlToCompletePayment };

    const paymentStash = await persistence.addPaymentInfoToTx({ transactionId, ...paymentLinkResult });
    logger('Result of stashing payment details: ', paymentStash);

    return { statusCode: 200, body: JSON.stringify(initiationResult) };

  } catch (e) {
    logger('FATAL_ERROR: ', e);
    return { statusCode: status(500), body: JSON.stringify(e.message) };
  }
};

// ///////////////////////////////// WHERE USER RETURNS AFTER PAYMENT FLOW //////////////////////////////////

/* 
 * Method to display a page to user on their copmletion of payment flow (e.g., in OZOW)
 */
module.exports.completeSavingPaymentFlow = async (event) => {
  try {
    if (warmupCheck(event)) {
      await Promise.all([publisher.obtainTemplate(`payment/${config.get('templates.payment.success')}`), payment.warmUpPayment()]);
      return warmupResponse;
    }

    const pathParams = event.pathParameters ? event.pathParameters.proxy : '';
    const splitParams = pathParams.split('/'); // not the best thing 
    logger('Split path params: ', splitParams);

    const paymentProvider = splitParams[0];
    const transactionId = splitParams[1];
    const resultType = splitParams[splitParams.length - 1];

    logger(`Handling process, from ${paymentProvider}, with result ${resultType}, for ID: ${transactionId}`);

    if (!resultType || ['SUCCESS', 'ERROR', 'CANCELLED'].indexOf(resultType) < 0) {
      throw new Error('Error! Bad URL structure');
    }

    const matchingTx = await persistence.fetchTransaction(transactionId);
    if (!matchingTx) {
      throw new Error('No transaction with that ID exists, malicious actor likely');
    }

    const htmlFile = config.get(`templates.payment.${resultType.toLowerCase()}`);
    const htmlPage = await publisher.obtainTemplate(`payment/${htmlFile}`);

    // for security reasons, we obviously don't trust the incoming path variables for payment status, but trigger a background check
    // to payment provider to make sure of it -- that then stores the result for when the user resumes
    if (resultType === 'SUCCESS') {
      logger('Payment result is a success, fire off lambda invocation in the background');
      await payment.triggerTxStatusCheck({ transactionId, paymentProvider });
    }

    const response = {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html'
      },
      body: htmlPage
    };
    
    logger('Responding with: ', response);
    return response;
  } catch (err) {
    // return the error page
    logger('FATAL_ERROR: ', err);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'text/html'
      },
      body: `<html><title>Internal Error</title><body>` +
            `<p>Please return to the app and contact support. If you made payment, don't worry, we will reflect it on yoru account.` + 
            `<p>Server error details: ${JSON.stringify(err)}</p>`
    };
  }
};

// /////////////////// FOR CHECKING THAT PAYMENT WENT THROUGH ///////////////////////////////////////////////////////////////////

const handlePaymentFailure = (failureType) => {
  logger('Payment failed, consider how and return which way');
  if (failureType === 'PAYMENT_FAILED') {
    return { 
      result: 'PAYMENT_FAILED', 
      messageToUser: 'Sorry the payment failed. Please contact your bank or contact support and quote reference ABC123' 
    };
  } 
  return { result: 'PAYMENT_PENDING' };
};

// slightly redundant to fetch tx again, but doing so on a primary key is very fast, very efficient, and ensure we 
// return everything (although could also be done via better use of updating clause in TX - in future)
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

const assembleResponseAlreadySettled = async (transactionRecord) => {
  const balanceSum = await persistence.sumAccountBalance(transactionRecord['accountId'], transactionRecord['currency'], moment());
  logger('Retrieved balance sum: ', balanceSum);
  return { 
    result: 'PAYMENT_SUCCEEDED',
    newBalance: { amount: balanceSum.amount, unit: balanceSum.unit }
  };
};

const settle = async (settleInfo) => {
  if (!settleInfo.transactionId) {
    return invalidRequestResponse('Error! No transaction ID provided');
  }

  if (Reflect.has(settleInfo, 'settlementTimeEpochMillis')) {
    settleInfo.settlementTime = moment(settleInfo.settlementTimeEpochMillis);
    Reflect.deleteProperty(settleInfo, 'settlementTimeEpochMillis');
  } else {
    settleInfo.settlementTime = moment();
  }
  
  const resultOfUpdate = await persistence.updateTxToSettled(settleInfo);
  logger('Completed the update: ', resultOfUpdate);

  return resultOfUpdate;
};

// used quite a lot in testing
const dummyPaymentResult = async (systemWideUserId, params) => {
  const paymentSuccessful = !params.failureType; // for now
  
  if (paymentSuccessful) {
    const dummyPaymentRef = `some-payment-reference-${(new Date().getTime())}`;
    const transactionId = params.transactionId;
    const resultOfSave = await settle({ transactionId, paymentProvider: 'OZOW', paymentRef: dummyPaymentRef });
    logger('Result of save: ', resultOfSave);
    await publishSaveSucceeded(systemWideUserId, transactionId);
    return { result: 'PAYMENT_SUCCEEDED', ...resultOfSave };
  } 

  return handlePaymentFailure(params.failureType);
};

/**
 * Checks on the backend whether this payment is done
 * @param {string} transactionId The transaction ID of the pending payment
 */
module.exports.checkPendingPayment = async (event) => {
  try {
    if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
      return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
    }
    
    logger('Checking for payment with inbound event: ', event);
    const params = event.queryStringParameters || event;
    const transactionId = params.transactionId;
    
    const transactionRecord = await persistence.fetchTransaction(transactionId);
    logger('Transaction record: ', transactionRecord);

    if (transactionRecord.settlementStatus === 'SETTLED') {
      const responseBody = await assembleResponseAlreadySettled(transactionRecord);
      return { statusCode: 200, body: JSON.stringify(responseBody)};
    }

    let systemWideUserId = '';
    if (event.requestContext && event.requestContext.authorizer) {
      systemWideUserId = event.requestContext.authorizer.systemWideUserId;
    } else {
      const accountId = transactionRecord.accountId;
      const accountInfo = await persistence.getOwnerInfoForAccount(accountId);
      systemWideUserId = accountInfo.systemWideUserId;
    }

    await publisher.publishUserEvent(systemWideUserId, 'SAVING_EVENT_PAYMENT_CHECK', { context: { transactionId }});

    const dummySuccess = config.has('dummy') && config.get('dummy') === 'ON';
    if (dummySuccess) {
      const dummyResult = await dummyPaymentResult(systemWideUserId, params);
      return { statusCode: 200, body: JSON.stringify(dummyResult) };
    }

    const statusCheckResult = await payment.checkPayment({ transactionId });
    logger('Result of check: ', statusCheckResult);
    
    let responseBody = { };

    if (statusCheckResult.result === 'SETTLED') {
      const settlementInstruction = { 
        transactionId
      };

      // do these one after the other instead of parallel because don't want to fire if something goes wrong
      const resultOfSave = await settle(settlementInstruction);
      await publishSaveSucceeded(systemWideUserId, transactionId);
      
      responseBody = { result: 'PAYMENT_SUCCEEDED', ...resultOfSave };
    } else if (statusCheckResult.result === 'ERROR') {
      responseBody = handlePaymentFailure('PAYMENT_FAILED');
    } else {
      responseBody = handlePaymentFailure('Payment failed');
    }
    

    return { statusCode: 200, body: JSON.stringify(responseBody) };

  } catch (err) {
    return handleError(err);
  }
};
