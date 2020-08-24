'use strict';

const logger = require('debug')('jupiter:save:main');
const config = require('config');
const moment = require('moment-timezone');
const status = require('statuses');

const publisher = require('publish-common');
const opsUtil = require('ops-util-common');

const persistence = require('./persistence/rds');
const dynamo = require('./persistence/dynamodb');
const payment = require('./payment-link');

const warmupCheck = (event) => !event || typeof event !== 'object' || Object.keys(event).length === 0;
const warmupResponse = { statusCode: 400, body: 'Empty invocation' };

const invalidRequestResponse = (messageForBody) => ({ statusCode: 400, body: messageForBody });

const handleError = (err) => { 
  logger('FATAL_ERROR: ', err);
  return { statusCode: 500, body: JSON.stringify(err.message) };
};

const extractTxTagIfExists = (txDetails, desiredTag) => {
  if (Array.isArray(txDetails.tags) && txDetails.tags.some((tag) => tag.startsWith(desiredTag))) {
    const foundTag = txDetails.tags.find((tag) => tag.startsWith(desiredTag));
    return foundTag.substring(foundTag.indexOf('::') + '::'.length); 
  }
  return '';
};

const save = async (eventBody) => {
  const saveInformation = eventBody;
  logger('Have a saving request inbound: ', saveInformation);

  saveInformation.initiationTime = saveInformation.initiationTimeEpochMillis ? moment(saveInformation.initiationTimeEpochMillis) : moment();
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
const assemblePaymentInfo = async (saveInformation, transactionId) => {
  const accountStemAndCount = await persistence.fetchInfoForBankRef(saveInformation.accountId);
  const accountInfo = {
    bankRefStem: accountStemAndCount.humanRef,
    priorSaveCount: accountStemAndCount.count,
    ownerUserId: accountStemAndCount.ownerUserId
  };

  const amountDict = {
    amount: saveInformation.amount,
    unit: saveInformation.unit,
    currency: saveInformation.currency
  };

  return { transactionId, accountInfo, amountDict };
};

const handleManualEft = async (transactionId, saveInformation, paymentInfo, resultSoFar) => {
  const clientFloatVars = await dynamo.fetchFloatVarsForBalanceCalc(saveInformation.clientId, saveInformation.floatId);
  const humanReference = payment.generateBankRef(paymentInfo.accountInfo);
  const bankDetails = { ...clientFloatVars.bankDetails, useReference: humanReference };
  const detailsStash = await persistence.addPaymentInfoToTx({ transactionId, bankRef: humanReference, paymentProvider: 'MANUAL_EFT' });
  logger('Result of stashing details: ', detailsStash);
  return { ...resultSoFar, humanReference, bankDetails };
};

const handleInstantEft = async (transactionId, saveInformation, paymentInfo, resultSoFar) => {
  const paymentLinkResult = await payment.getPaymentLink(paymentInfo);
  logger('Got payment link result: ', paymentLinkResult);
  const urlToCompletePayment = paymentLinkResult.paymentUrl;
  if (!urlToCompletePayment) {
    logger('FATAL_ERROR: No URL from payment provider'); // so the right alarms go off
    return handleManualEft(transactionId, saveInformation, paymentInfo, resultSoFar); // so we don't halt the save
  }

  logger('Returning with url to complete payment: ', urlToCompletePayment);
  const paymentRedirectDetails = { urlToCompletePayment };
  const humanReference = paymentLinkResult.bankRef;

  const paymentStash = await persistence.addPaymentInfoToTx({ transactionId, ...paymentLinkResult });
  logger('Result of stashing payment details: ', paymentStash);  
  return { ...resultSoFar, paymentRedirectDetails, humanReference };
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
      await payment.warmUpPayment({ type: 'INITIATE' });
      return warmupResponse;
    }

    const authParams = event.requestContext ? event.requestContext.authorizer : null;
    if (!authParams || !authParams.systemWideUserId) {
      return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
    }
    
    const saveInformation = JSON.parse(event.body);

    if (!saveInformation.accountId) {
      return invalidRequestResponse('Error! No account ID provided for the save');
    } else if (!saveInformation.amount) {
      return invalidRequestResponse('Error! No amount provided for the save');
    } else if (!saveInformation.currency) {
      return invalidRequestResponse('Error! No currency specified for the saving event');
    } else if (!saveInformation.unit) {
      return invalidRequestResponse('Error! No unit specified for the saving event');
    }

    // todo : also use cache for these checks
    const [duplicateSave, ownerInfo] = await Promise.all([
      persistence.checkForDuplicateSave(saveInformation),
      persistence.getOwnerInfoForAccount(saveInformation.accountId)
    ]);

    logger('Initiating save, account owner info: ', ownerInfo);
    if (ownerInfo.frozen) {
      // this only happens in extreme cases (fraud/AML/etc), so we _want_ the "user" not logged out, and not seeing why
      return { statusCode: 403 };
    }

    if (duplicateSave) {
      logger('Duplicate transaction found, was created at: ', duplicateSave.creationTime, 'full details: ', duplicateSave);
      const returnResult = {
        transactionDetails: [{
          accountTransactionId: duplicateSave.transactionId,
          persistedTimeEpochMillis: moment(duplicateSave.creationTime).valueOf()
        }],
        humanReference: duplicateSave.humanReference,
        paymentRedirectDetails: { urlToCompletePayment: extractTxTagIfExists(duplicateSave, 'PAYMENT_URL') }
      };
      return { statusCode: 200, body: JSON.stringify(returnResult) };
    }
    
    saveInformation.settlementStatus = 'PENDING'; // we go straight to pending here, as next step is completed when payment received

    if (!saveInformation.floatId && !saveInformation.clientId) {
      saveInformation.floatId = saveInformation.floatId || ownerInfo.floatId;
      saveInformation.clientId = saveInformation.clientId || ownerInfo.clientId;
    }

    // todo : verify user account ownership
    let initiationResult = await save(saveInformation);

    logger('sending saveInfo:', initiationResult);
    
    const transactionId = initiationResult.transactionDetails[0].accountTransactionId;
    logger('Extracted transaction ID: ', transactionId);
    
    // we default to Ozow, for now
    const paymentProvider = saveInformation.paymentProvider || 'OZOW';
    logger('Payment provider: ', paymentProvider);

    const paymentInfo = await assemblePaymentInfo(saveInformation, transactionId); // we need this anyway

    if (paymentProvider === 'OZOW') {
      initiationResult = await handleInstantEft(transactionId, saveInformation, paymentInfo, initiationResult);
    } else {
      initiationResult = await handleManualEft(transactionId, saveInformation, paymentInfo, initiationResult);
    }

    logger('Validated request, publishing user event');
    const eventParams = { transactionId, initiationResult, saveInformation };
    // to make sure the published event is matched to the right user
    const systemWideUserId = paymentInfo.accountInfo.ownerUserId;
    await publisher.publishUserEvent(systemWideUserId, 'SAVING_EVENT_INITIATED', { context: eventParams });

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
      await publisher.obtainTemplate(`payment/${config.get('templates.payment.success')}`);
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
    
    // if this fails it will just fail; if it succeeds, it will allow checking to be quicker later
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
    savedAmount: `${txDetails.amount}::${txDetails.unit}::${txDetails.currency}`,
    bankReference: txDetails.humanReference,
    transactionTags: txDetails.tags
  };

  logger('Triggering publish, with context: ', context);
  await publisher.publishUserEvent(systemWideUserId, 'SAVING_PAYMENT_SUCCESSFUL', { context });
};

const assembleResponseAlreadySettled = async (transactionRecord) => {
  const balanceSum = await persistence.sumAccountBalance(transactionRecord.accountId, transactionRecord.currency, moment());
  logger('Retrieved balance sum: ', balanceSum);
  return { 
    result: 'PAYMENT_SUCCEEDED',
    newBalance: { amount: balanceSum.amount, unit: balanceSum.unit }
  };
};

module.exports.settle = async (settleInfo) => {
  if (!settleInfo.transactionId) {
    return invalidRequestResponse('Error! No transaction ID provided');
  }

  if (!settleInfo.settlingUserId) {
    return invalidRequestResponse('Error! No settling user ID provided');
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

const handlePaymentPendingOrFailed = async (statusType, transactionDetails) => {
  logger('Payment failed, consider how and return which way, tx details: ', transactionDetails);
  
  const { clientId, floatId } = transactionDetails;
  const clientFloatVars = await dynamo.fetchFloatVarsForBalanceCalc(clientId, floatId);
  const humanRef = transactionDetails.humanReference;

  const bankDetails = { ...clientFloatVars.bankDetails, useReference: humanRef };

  if (statusType === 'PAYMENT_FAILED') {
    return { 
      result: 'PAYMENT_FAILED', 
      messageToUser: `Sorry the payment failed. Please contact your bank or contact support and quote reference ${humanRef}`,
      bankDetails
    };
  }

  return { result: 'PAYMENT_PENDING', bankDetails };
};

/**
 * Checks on the backend whether this payment is done
 * @param {string} transactionId The transaction ID of the pending payment
 */
module.exports.checkPendingPayment = async (event) => {
  if (warmupCheck(event)) {
    await payment.warmUpPayment({ type: 'CHECK' });
    return warmupResponse;
  }
  
  try {

    if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
      return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
    }
    
    const params = event.queryStringParameters || event;
    logger('Checking for payment with inbound paramaters: ', params);
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

    if (transactionRecord.paymentProvider === 'MANUAL_EFT') {
      // by definition, has not been marked as received, so must be pending
      const pendingResponse = await handlePaymentPendingOrFailed('PAYMENT_PENDING', transactionRecord);
      return { statusCode: 200, body: JSON.stringify(pendingResponse) };
    }

    const statusCheckResult = await payment.checkPayment({ transactionId });
    logger('Result of check with payment provider: ', statusCheckResult);
    
    let responseBody = { };

    if (statusCheckResult.paymentStatus === 'SETTLED') {
      // do these one after the other instead of parallel because don't want to fire if something goes wrong
      const resultOfSave = await exports.settle({ transactionId, settlingUserId: systemWideUserId });
      await publishSaveSucceeded(systemWideUserId, transactionId);
      responseBody = { result: 'PAYMENT_SUCCEEDED', ...resultOfSave, tags: transactionRecord.tags };
    } else if (statusCheckResult.result === 'PENDING') {
      responseBody = await handlePaymentPendingOrFailed('PAYMENT_PENDING', transactionRecord);
    } else if (statusCheckResult.result === 'ERROR') {
      responseBody = await handlePaymentPendingOrFailed('PAYMENT_FAILED', transactionRecord);
    } else {
      responseBody = await handlePaymentPendingOrFailed('Payment failed', transactionRecord);
    }
    
    return { statusCode: 200, body: JSON.stringify(responseBody) };

  } catch (err) {
    return handleError(err);
  }
};
