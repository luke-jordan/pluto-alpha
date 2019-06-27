'use strict';

const logger = require('debug')('pluto:account:handler');

const uuid = require('uuid/v4');
const validator = require('validator');
const persistence = require('./persistence/rds');

module.exports.create = async (event) => {
  const request = exports.transformEvent(event);
  logger('Transform inbound event completed, request: ', JSON.stringify(request));

  const requestValid = exports.validateRequest(request);
  logger('Validity check completed, result: ', requestValid);

  if (!requestValid) {
    return {
      statusCode: 400
    };
  }

  const persistenceResult = await exports.createAccount(request);
  logger('Persistence completed, returning success, result: ', persistenceResult);
  
  return {
    statusCode: 200,
    body: JSON.stringify(persistenceResult)
  };
};


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
  } else if (!creationRequest['floatId']) {
    logger('Missing ID for default float for this account');
  } else if (!creationRequest['ownerUserId']) {
    logger('System wide ID for account owner missing, invalid request');
    return false;
  } else if (!validator.isUUID(creationRequest['ownerUserId'])) {
    logger('Creation request contains an invalid system user id');
    return false;
  } else if (!creationRequest['userFirstName'] || !creationRequest['userFamilyName']) {
    logger('Account creation request is missting user first name or family name');
    return false;
  } else {
    return true;
  }
};

/**
 * Creates an account within the core ledgers for a user. Returns the persistence result of the transaction.
 * @param {string} clientId The id of the client company responsible for this user and account
 * @param {string} floatId The id for the _default_ float that the user will save to (can be overriden on specific transactions)
 * @param {string} ownerUserId The system wide ID of the user opening the account
 * @param {string} userFirstName The first name of the user
 * @param {string} userFamilyName The family name of the user
 */
module.exports.createAccount = async (creationRequest = {
  'clientId': 'zar_savings_co', 
  'floatId': 'zar_cash_float',
  'ownerUserId': '2c957aca-47f9-4b4d-857f-a3205bfc6a78',
  'userFirstName': 'Luke',
  'userFamilyName': 'Jordan'}) => {
  
  const accountId = uuid();
  logger('Creating an account with ID: ', accountId);
  
  const persistenceResult = await persistence.insertAccountRecord({ 
    'accountId': accountId, 
    'clientId': creationRequest.clientId,
    'floatId': creationRequest.floatId,
    'ownerUserId': creationRequest.ownerUserId, 
    'userFirstName': creationRequest.userFirstName,
    'userFamilyName': creationRequest.userFamilyName
  });
  
  logger('Received from persistence: ', persistenceResult);
  return persistenceResult;
};

module.exports.listAccounts = async () => {
  // const params = { TableName: 'CoreAccountLedger' };

  // const result = await docClient.scan(params).promise();
  const result = { };
  logger('Result: ', result);

  return { 'statusCode': 200 };
};
