'use strict';

const logger = require('debug')('pluto:save:main');
const persistence = require('./persistence/rds');
const dynamodb = require('./persistence/dynamodb');

module.exports.save = async (event) => {
  try {
    logger('Initiating transaction record to save, environment: ', process.env.NODE_ENV);

    logger('Here is our event: ', event);
    const settlementInformation = event['body'] ? JSON.parse(event['body']) : event;
    logger('Have a saving request inbound: ', settlementInformation);

    // todo : check validity

    const savingResult = await exports.storeSettledSaving(settlementInformation);
    logger('Completed the save, result: ', savingResult);

    return {
      statusCode: 200,
      body: JSON.stringify(savingResult)
    };
  } catch (e) {
    logger('FATAL_ERROR: ', e);
    return {
      statusCode: 500
    };
  }
};

module.exports.storeSettledSaving = async (settlementInformation = {
  'accountId': '0c3caa51-ce5f-467c-9470-3fc34f93b5cc',
  'initiationTime': Date.now(),
  'settlementTime': Date.now(),
  'savedAmount': 50000, // five rand (figures always in hundredths of a cent)
  'savedCurrency': 'ZAR',
  'prizePoints': 100,
  'offerId': 'id-of-preceding-offer',
  'tags': ['TIME_BASED'],
  'flags': ['RESTRICTED']
}) => {
  
  logger('Initiating settlement record');

  const resultOfSave = await persistence.addSavingToTransactions(settlementInformation);
  logger('Result of save: ', resultOfSave);

  return resultOfSave;
  
};

module.exports.balance = async (event, context) => {
  if (context) {
    logger('Context object: ', context); // todo : check user role etc
  }

  // todo : look up property
  const params = event.queryParams || event;
  const accountId = params.accountId;
};
