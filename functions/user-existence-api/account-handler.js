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

// helper, just given elevated problems if failures in here
const isNonEmptyString = (param) => typeof param === 'string' && param.length > 0;
const stripAccents = (name) => name.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace('\'', '').replace(' ', '');

// note : possible race conditions means that the ref is composed of three parts:
// a stem : upper case initial & surname, or JSAVE if none provided
// a count : how many others have that stem, plus one
// a switch : the unit of the current milliseconds, so we only get a conflict if we have two at
// the same millisecond or somehow within a multiple of 10 of each other, which will be vanishingly small and can retry
const generateHumanRef = async (creationRequest) => {
  let humanRefStem = '';
  if (creationRequest && isNonEmptyString(creationRequest.personalName) && isNonEmptyString(creationRequest.familyName)) {
    const noAccentPersonalName = stripAccents(creationRequest.personalName);
    const noAccentFamilyName = stripAccents(creationRequest.familyName);
    humanRefStem = `${noAccentPersonalName.substring(0, 1)}${noAccentFamilyName}`.toUpperCase();
  } else {
    humanRefStem = 'JUPSAVE';
  }
  const priorCount = await persistence.countHumanRef(humanRefStem);
  logger('Result of prior count: ', priorCount);
  const timeString = String(moment().valueOf());
  const assembledRef = `${humanRefStem}${priorCount + 1}${timeString.substr(-1)}`;
  logger('And assembled: ', assembledRef);
  return assembledRef;
};

/**
 * Creates an account within the core ledgers for a user. Returns the persistence result of the transaction.
 * @param {object} creationRequest An object containing the properties described below.
 * @property {string} clientId The id of the client company responsible for this user and account
 * @property {string} defaultFloatId The id for the _default_ float that the user will save to (can be overriden on specific transactions)
 * @property {string} ownerUserId The system wide ID of the user opening the account
 * @property {string} firstName The user's first name, used for generating the human-readable account reference (for bank deposits etc)
 * @property {string} familyName As above. Note if either is not provided the default is JSAVEX.
 */
module.exports.createAccount = async (creationRequest = {
  'clientId': 'zar_savings_co', 
  'defaultFloatId': 'zar_cash_float',
  'ownerUserId': '2c957aca-47f9-4b4d-857f-a3205bfc6a78'}) => {
  
  const { ownerUserId } = creationRequest;

  const existingAccountId = await persistence.getAccountIdForUser(ownerUserId);
  if (existingAccountId && typeof existingAccountId === 'string' && existingAccountId.length > 0) {
    return { accountId: existingAccountId };
  }

  const accountId = uuid();
  logger('Creating an account with ID: ', accountId);

  const humanRef = await generateHumanRef(creationRequest);
  
  const persistenceResult = await persistence.insertAccountRecord({ 
    ownerUserId,
    accountId,
    humanRef,
    clientId: creationRequest.clientId,
    defaultFloatId: creationRequest.defaultFloatId
  });
  
  logger('Received from persistence: ', persistenceResult);

  const persistenceMoment = moment(persistenceResult.persistedTime);
  
  return { accountId: persistenceResult.accountId, persistedTimeMillis: persistenceMoment.valueOf() };
};

/**
 * This function serves as a wrapper around the createAccount handler, processing events from API Gateway.
 * @param {object} event An event object containing the request context and request body. The request body properties are decribed below.
 * @property {string} clientId The id of the client company responsible for this user and account.
 * @property {string} defaultFloatId The id for the _default_ float that the user will save to (can be overriden on specific transactions).
 * @property {string} ownerUserId The system wide ID of the user opening the account.
 */
module.exports.create = async (event) => {
  try {
    if (!event || typeof event !== 'object' || Object.keys(event).length === 0 || event.warmupCall) {
      logger('Warmup, just keep alive for now, with a lambda gateway open');
      await lambda.invoke({ FunctionName: config.get('lambda.createBoost'), InvocationType: 'Event', Payload: JSON.stringify({}) }).promise();
      logger('Done keeping gateway open, exiting');
      return { statusCode: 400, body: 'Empty invocation' };
    }

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
