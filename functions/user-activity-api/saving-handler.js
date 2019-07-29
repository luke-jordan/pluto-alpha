'use strict';

const logger = require('debug')('jupiter:save:main');
const moment = require('moment-timezone');
const persistence = require('./persistence/rds');

const invalidRequestResponse = (messageForBody) => ({ statusCode: 400, body: messageForBody });

module.exports.save = async (event) => {
    try {
      if (!event) {
        logger('No event! Must be warmup lambda');
        return { statusCode: 400, body: 'Empty invocation' };
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
    
    logger('Initiating settlement record, passed parameters: ', settlementInformation);
  
    const resultOfSave = await persistence.addSavingToTransactions(settlementInformation);
    logger('Result of save: ', resultOfSave);
  
    return resultOfSave;
    
  };
  