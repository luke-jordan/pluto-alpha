'use strict';

const logger = require('debug')('jupiter:account:handler');
const config = require('config');

const uuid = require('uuid/v4');
const moment = require('moment');
const validator = require('validator');

const persistence = require('./persistence/rds');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

// point of this is to choose whether to use API calls or Lambda invocations
module.exports.transformEvent = (event) => {
  const body = event['body'];
  return body ? JSON.parse(body) : event;
};

// this validates we have the info we need
module.exports.validateRequest = (creationRequest) => {
  // note: also check for properly formed names, and for a signed 'okay' by onboarding process
  if (!creationRequest['clientId']) {
    logger('Missing ID for intermediary client that this account belongs to');
    return false;
  } else if (!creationRequest['defaultFloatId']) {
    logger('Missing ID for default float for this account');
    return false;
  } else if (!creationRequest['ownerUserId']) {
    logger('System wide ID for account owner missing, invalid request');
    return false;
  } else if (!validator.isUUID(creationRequest['ownerUserId'])) {
    logger('Creation request contains an invalid system user id');
    return false;
  }
    
  logger('Incoming event validated');
  return true;
};

// this handles redeeming a referral code, if it is present and includes an amount
// the method will create a boost in 'PENDING', triggered when the referred user saves
const handleReferral = async (newAccountId, ownerUserId, referralCodeDetails) => {
  if (typeof referralCodeDetails !== 'object' || Object.keys(referralCodeDetails).length === 0) {
    logger('No referral code details provided, exiting');
    return;
  }

  const referralContext = referralCodeDetails.context;

  const referralType = referralCodeDetails.codeType;
  const boostCategory = `${referralType}_CODE_USED`;
  
  const boostAccounts = [newAccountId];
  const redemptionMsgInstructions = [{ accountId: newAccountId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRED' }];

  if (referralType === 'USER') {
    const referringUserId = referralCodeDetails.creatingUserId;
    const referringAccountId = await persistence.getAccountIdForUser(referringUserId);
    if (!referringAccountId) {
      logger('INCONSISTENCY_ERROR: referring user has no account ID');
      return; 
    }

    redemptionMsgInstructions.push({ accountId: referringAccountId, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRER' });
    boostAccounts.push(referringAccountId);
  }

  const accountsToSelect = boostAccounts.map((accountId) => `"${accountId}"`).join(', ');
  const boostAudienceSelection = `whole_universe from #{{"specific_accounts": [${accountsToSelect}]}}`;
  const bonusExpiryTime = moment().add(config.get('referral.expiryTimeDays'), 'days');

  // note : we may at some point want a "system" flag on creating user ID instead of the account opener, but for
  // now this will allow sufficient tracking, and a simple migration will fix it in the future
  const boostPayload = {
    creatingUserId: ownerUserId,
    boostTypeCategory: `REFERRAL::${boostCategory}`,
    boostAmountOffered: referralContext.boostAmountOffered,
    boostSource: referralContext.boostSource,
    endTimeMillis: bonusExpiryTime.valueOf(),
    boostAudience: 'INDIVIDUAL',
    boostAudienceSelection,
    initialStatus: 'PENDING',
    statusConditions: {
      'REDEEMED': [`save_completed_by #{${newAccountId}}`, `first_save_by #{${newAccountId}}`]
    },
    messageInstructionFlags: {
      'REDEEMED': redemptionMsgInstructions
    }
  };

  const lambdaInvocation = {
    FunctionName: config.get('lambda.createBoost'),
    InvocationType: 'Event',
    Payload: JSON.stringify(boostPayload)
  };

  logger('Invoking lambda with payload: ', boostPayload);
  const resultOfTrigger = await lambda.invoke(lambdaInvocation).promise();
  logger('Result of firing off lambda invoke: ', resultOfTrigger);
};

/**
 * Creates an account within the core ledgers for a user. Returns the persistence result of the transaction.
 * @param {string} clientId The id of the client company responsible for this user and account
 * @param {string} defaultFloatId The id for the _default_ float that the user will save to (can be overriden on specific transactions)
 * @param {string} ownerUserId The system wide ID of the user opening the account
 */
module.exports.createAccount = async (creationRequest = {
  'clientId': 'zar_savings_co', 
  'defaultFloatId': 'zar_cash_float',
  'ownerUserId': '2c957aca-47f9-4b4d-857f-a3205bfc6a78'}) => {
  
  const accountId = uuid();
  logger('Creating an account with ID: ', accountId);
  
  const persistenceResult = await persistence.insertAccountRecord({ 
    'accountId': accountId, 
    'clientId': creationRequest.clientId,
    'defaultFloatId': creationRequest.defaultFloatId,
    'ownerUserId': creationRequest.ownerUserId
  });
  
  logger('Received from persistence: ', persistenceResult);

  const persistenceMoment = moment(persistenceResult.persistedTime);
  
  await handleReferral(persistenceResult.accountId, creationRequest.ownerUserId, creationRequest.referralCodeDetails);

  return { accountId: persistenceResult.accountId, persistedTimeMillis: persistenceMoment.valueOf() };
};


module.exports.create = async (event) => {
  try {
    const request = exports.transformEvent(event);
    logger('Transform inbound event completed, request: ', JSON.stringify(request));

    const requestValid = exports.validateRequest(request);
    logger('Validity check completed, result: ', requestValid);

    if (!requestValid) {
      return {
        statusCode: 400,
        body: `Error! Invalid request. All valid requests require a responsible client id, float id, and the owner's user id`
      };
    }

    const persistenceResult = await exports.createAccount(request);
    logger('Persistence completed, returning success, result: ', persistenceResult);
    
    return {
      statusCode: 200,
      body: JSON.stringify(persistenceResult)
    };
  } catch (e) {
    logger('FATAL_ERROR: ', e);
    return {
      statusCode: 500,
      body: e.message
    };
  }
};
