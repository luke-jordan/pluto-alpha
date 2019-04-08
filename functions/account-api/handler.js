'use strict';

const logger = require('debug')('u:account:open:handler')

const uuid = require('uuid/v4');
const persistence = require('./persistence/rds');

module.exports.create = async (event, context) => {
  const request = exports.transformEvent(event);
  logger('Transform inbound event completed, request: ', JSON.stringify(request));

  const requestValid = exports.validateRequest(request);
  logger('Validity check completed, result: ', requestValid);

  if (!requestValid) {
    return {
      statusCode: 400
    }
  };

  const persistenceResult = await exports.createAccount(request);
  logger('Persistence completed, returning success');
  
  return {
    statusCode: 200,
    body: JSON.stringify(persistenceResult)
  };
};


// point of this is to choose whether to use API calls or Lambda invocations
module.exports.transformEvent = (event) => {
  const body = event['body'];
  return body ? JSON.parse(body) : event;
}

// this validates we have the info we need
module.exports.validateRequest = (creationRequest) => {
  if (!creationRequest['ownerUserId']) {
    logger('System wide ID for account owner missing, invalid request');
    return false;
  }

  // also check for properly formed names, and for a signed 'okay' by onboarding thing

  return true;
}

module.exports.createAccount = async (creationRequest = { 
  'ownerUserId': '2c957aca-47f9-4b4d-857f-a3205bfc6a78',
  'userFirstName': 'Luke',
  'userFamilyName': 'Jordan'}) => {
  
  const accountId = uuid();
  logger('Creating an account with ID: ', accountId);
  
  const persistenceResult = await persistence.insertAccountRecord({ 
    'accountId': accountId, 
    'ownerUserId': creationRequest['ownerUserId'], 
    'userFirstName': creationRequest['userFirstName'],
    'userFamilyName': creationRequest['userFamilyName']}
  );
  
  return persistenceResult;
}

module.exports.listAccounts = async () => {
  const params = { TableName: 'CoreAccountLedger' };

  const result = await docClient.scan(params).promise();
  console.log('Result: ', result);

  return { 'statusCode': 200 }
}

// exports.listAccounts();
// exports.createAccount();