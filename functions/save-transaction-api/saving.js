'use strict';

const logger = require('debug')('u:transaction:saving:main')

const persistence = require('./persistence/rds');

module.exports.save = async (event) => {
  logger('Initiating transaction record to save, environment: ', process.env.NODE_ENV);

  logger('Here is our event: ', event);
  const settlementInformation = !!event['body'] ? JSON.parse(event['body']) : event;
  logger('Have a saving request inbound: ', settlementInformation);

  // todo : check validity

  const savingResult = await exports.storeSettledSaving(settlementInformation);
  logger('Completed the save');

  return {
    statusCode: 200,
    body: JSON.stringify(savingResult)
  };

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

  const resultOfSave = persistence.addSavingToTransactions(settlementInformation);

  return resultOfSave;
  
}