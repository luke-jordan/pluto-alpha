'use strict';

const logger = require('debug')('jupiter:float:accrual');
const config = require('config');

const opsUtil = require('ops-util-common');
const DecimalLight = require('decimal.js-light');

const dynamo = require('./persistence/dynamodb');
const rds = require('./persistence/rds');
const csvFile = require('./persistence/csvfile');
const constants = require('./constants');

const allocationHelper = require('./allocation-helper');

const Redis = require('ioredis');
const redis = new Redis({
    host: config.get('cache.host'),
    port: config.get('cache.port'),
    retryStrategy: () => `dont retry`,
    keyPrefix: `${config.get('cache.keyPrefixes.float')}::`
});

const calculatePercent = (total, account) => (new DecimalLight(account)).dividedBy(total);

const consolidateCsvRows = (priorBalanceMap, priorEntityBalances, rowsFromRds) => rowsFromRds.map((row) => {
  const allocType = row['allocated_to_type'];
  if (allocType === 'END_USER_ACCOUNT') {
    row['prior_balance'] = priorBalanceMap.get(row['allocated_to_id']);
  } else if (allocType === 'COMPANY_SHARE' || allocType === 'BONUS_POOL') {
    row['prior_balance'] = priorEntityBalances.get(row['allocated_to_id']);
  } else {
    row['prior_balance'] = priorEntityBalances.get('FLOAT_ITSELF');
  }
  return row;
});

const assembleCacheKey = ({ clientId, floatId, backingEntityIdentifier }) => `${clientId}::${floatId}::${backingEntityIdentifier}`;

const checkStateLocked = async (event) => {
  const cacheEntry = await redis.get(assembleCacheKey(event));
  return cacheEntry && cacheEntry.length > 0;
};

const setStateLock = async (event) => {
  await redis.set(assembleCacheKey(event), JSON.stringify(event), 'EX', config.get('cache.ttls.float'));
};

// if error is inside cache then don't want loop
const safeClearState = async (event) => {
  try {
    await redis.del(assembleCacheKey(event));
  } catch (err) {
    logger('FATAL_ERROR', err);
  }
};

/**
 * The core function. Receives an instruction that interest (or other return) has been accrued, increases the balance recorded,
 * and then allocates the amounts to the client's bonus and company shares, and thereafter allocates to all accounts with 
 * contributions to the float in the past. Expects the following parameters in the lambda invocation or body of the post
 * @param {object} event An event object containing request body. The request body's properties are described below.
 * @property {string} clientId The system wide ID of the client that handles the float that is receiving the accrual
 * @property {string} floatId The system wide ID of the float that has received an accrual
 * @property {number} accrualAmount The amount of the accrual, in the currency and units passed in the other parameters
 * @property {string} currency The currency of the accrual. If not provided, defaults to the currency of the float.
 * @property {string} unit The units in which the amount is expressed. If not provided, defaults to float default.
 * @property {number} referenceTimeMillis For recording the accrual log. If not provided, defaults to when the calculation is performed 
 * @property {string} backingEntityIdentifier An identifier for the backing transaction (e.g., the accrual tx ID in the wholesale institution)
 */
module.exports.accrue = async (event) => {
  try { 
    const isStateLocked = await checkStateLocked(event);
    if (isStateLocked) {
      return { statusCode: 200, body: 'STATE_LOCKED' };
    }

    await setStateLock(event);

    const accrualParameters = event;
    const { clientId, floatId } = accrualParameters;
    
    const floatConfig = await dynamo.fetchConfigVarsForFloat(clientId, floatId);
    logger('Fetched float config: ', floatConfig);

    const accrualAmount = parseInt(accrualParameters.accrualAmount, 10); // just in case it is formatted as string
    const accrualCurrency = accrualParameters.currency || floatConfig.currency;
    const accrualUnit = accrualParameters.unit || floatConfig.unit;

    // so we start by working out how much of the interest is for the bonus pool & company share, and deducting it
    const initialBalance = await rds.calculateFloatBalance(floatId, accrualCurrency);

    const newFloatBalance = await rds.addOrSubtractFloat({ 
      clientId, 
      floatId, 
      amount: accrualAmount, 
      currency: accrualCurrency,
      transactionType: constants.floatTransTypes.ACCRUAL, 
      unit: accrualUnit, 
      backingEntityIdentifier: accrualParameters.backingEntityIdentifier,
      backingEntityType: constants.entityTypes.ACCRUAL_EVENT,
      logType: 'WHOLE_FLOAT_ACCRUAL',
      referenceTimeMillis: accrualParameters.referenceTimeMillis 
    });
    
    logger('New float balance: ', newFloatBalance);
    const { logId } = newFloatBalance;
    
    const allocationCommon = {
      currency: accrualCurrency,
      unit: accrualUnit,
      transactionType: constants.floatTransTypes.ACCRUAL,
      transactionState: constants.floatTxStates.SETTLED,
      relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,
      relatedEntityId: accrualParameters.backingEntityIdentifier,
      logId 
    };

    // to maintain transparency, we distinguish between the allocation to bonus and company that is "fee" and the 
    // share that is "momentum" or their "share", given their weight in the whole. the share amount is calculated 
    // with reference to total float balance, prior to accrual addition, and of the amount net of bonus/client share
    const entityAllocations = [];
    const { bonusPoolTracker, clientCoShareTracker } = floatConfig;

    const bonusFeeAllocation = { ...allocationCommon };
    bonusFeeAllocation.label = 'BONUS_FEE';
    bonusFeeAllocation.amount = exports.calculateShare(accrualAmount, floatConfig.bonusPoolShare);
    bonusFeeAllocation.allocatedToType = constants.entityTypes.BONUS_POOL;
    bonusFeeAllocation.allocatedToId = bonusPoolTracker;
    entityAllocations.push(bonusFeeAllocation);

    const clientFeeAllocation = { ...allocationCommon };
    clientFeeAllocation.label = 'CLIENT_FEE';
    clientFeeAllocation.amount = exports.calculateShare(accrualAmount, floatConfig.clientCoShare);
    clientFeeAllocation.allocatedToType = constants.entityTypes.COMPANY_SHARE;
    clientFeeAllocation.allocatedToId = clientCoShareTracker;
    entityAllocations.push(clientFeeAllocation);

    const grossAccrual = accrualAmount - bonusFeeAllocation.amount - clientFeeAllocation.amount;
    
    const priorBalanceInUnit = opsUtil.convertToUnit(initialBalance.balance, initialBalance.unit, accrualUnit);
    const priorEntityParams = { clientId, floatId, currency: accrualCurrency, unit: accrualUnit, allocationIds: [bonusPoolTracker, clientCoShareTracker] };
    const priorEntityBalances = await rds.obtainPriorAllocationBalances(priorEntityParams);
    logger('Obtained prior entity balances: ', priorEntityBalances);

    const bonusShareAllocation = { ...bonusFeeAllocation };
    bonusShareAllocation.label = 'BONUS_SHARE';
    logger(`Calculating percent from prior total: ${priorBalanceInUnit}, and bonus balance: ${priorEntityBalances.get(bonusPoolTracker)}`);
    const priorBonusPercent = calculatePercent(priorBalanceInUnit, priorEntityBalances.get(bonusPoolTracker));
    bonusShareAllocation.amount = exports.calculateShare(grossAccrual, priorBonusPercent.toNumber());
    logger(`From gross accrual of ${grossAccrual}, bonus share of ${priorBonusPercent}, hence bonus accrual of ${bonusShareAllocation.amount}`);
    entityAllocations.push(bonusShareAllocation);
    
    const clientShareAllocation = { ...clientFeeAllocation };
    clientShareAllocation.label = 'CLIENT_SHARE';
    const priorClientPercent = calculatePercent(priorBalanceInUnit, priorEntityBalances.get(clientCoShareTracker));
    clientShareAllocation.amount = exports.calculateShare(grossAccrual, priorClientPercent.toNumber());
    logger(`From gross accrual of ${grossAccrual}, client share of ${priorClientPercent}, hence bonus accrual of ${bonusShareAllocation.amount}`);
    entityAllocations.push(clientShareAllocation);

    logger('Company fee allocation: ', clientFeeAllocation);
    logger('Bonus fee allocation: ', bonusFeeAllocation);
      
    const entityAllocationIds = await rds.allocateFloat(clientId, floatId, entityAllocations);
    logger('Allocation IDs: ', entityAllocationIds);

    const findTxId = (label) => entityAllocationIds.find((row) => Object.keys(row).includes(label))[label];

    const entityAllocationResults = entityAllocations.reduce((obj, alloc) => ({
      ...obj, [alloc.label]: { amount: alloc.amount, transactionId: findTxId(alloc.label) }
    }), {});
    
    const remainingAmount = accrualAmount - entityAllocations.reduce((sum, val) => sum + val.amount, 0);
    const userAllocationParams = { clientId, floatId, 
      totalAmount: remainingAmount, 
      currency: accrualCurrency,
      unit: accrualUnit,
      transactionType: constants.floatTransTypes.ACCRUAL,
      transactionState: constants.floatTxStates.SETTLED,
      backingEntityType: constants.entityTypes.ACCRUAL_EVENT, 
      backingEntityIdentifier: accrualParameters.backingEntityIdentifier,
      bonusPoolIdForExcess: floatConfig.bonusPoolTracker,
      logId
    };
    
    const userAllocations = await allocationHelper.allocate(userAllocationParams, rds);

    // finally, we read back all the transactions with this log ID, stick them in a CSV, and stash them in S3
    const resultOfTxs = await rds.fetchRecordsRelatedToLog(logId);
    priorEntityBalances.set('FLOAT_ITSELF', priorBalanceInUnit);
    const recordsForCsv = consolidateCsvRows(userAllocations.priorAllocationMap, priorEntityBalances, resultOfTxs);
    const resultOfStash = await csvFile.writeAndUploadCsv({ filePrefix: 'accrual', logId, rowsFromRds: recordsForCsv });
    logger('And result of stashing: ', resultOfStash);
    
    // sending the prior balance map will be heavy, so remove it
    Reflect.deleteProperty(userAllocations, 'priorAllocationMap');

    const returnBody = {
      newBalance: newFloatBalance.updatedBalance,
      entityAllocations: entityAllocationResults,
      userAllocationTransactions: userAllocations
    };

    logger('Returning: ', returnBody);

    return { statusCode: 200, body: JSON.stringify(returnBody) };
  } catch (e) {
    logger('FATAL_ERROR: ', e);
    await safeClearState(event);
    return { statusCode: 500, body: JSON.stringify(e.message) };
  }
};

/**
 * Utility method to reliably calculate a share, using DecimalLight and a lot of tests to enforce robustness and avoid 
 * possible floating point issues. It is exported as (1) it might graduate to its own lambda, and (2) although small
 * it is the kind of thing that can crash spaceships into planets so it needs to be tested very very thoroughly on its own
 * @param {number} totalPool What is the total pool that we are dividing
 * @param {number} shareInPercent What is the share we are calculating. NOTE: Given in standard percent form, i.e., between 0 and 1
 * @param {boolean} roundEvenUp Whether to round 0.5 to 1 or to 0
 */
module.exports.calculateShare = (totalPool = 100, shareInPercent = 0.1, roundEvenUp = true) => {
  // logger(`Calculating an apportionment, total pool : ${totalPool}, and share: ${shareInPercent}`);
  // we do not want to introduce floating points, because that is bad, so first we check to make sure total pool is effectively an int
  // note: basic logic is that total pool should be expressed in hundredths of a cent, if it is not, this is an error
  // note: bignumber can handle non-integer of course, but that would allow greater laxity than we want in something this important
  // logger('Total pool: ', totalPool);
  if (!Number.isInteger(totalPool)) {
    throw new TypeError('Error! Passed a non-integer pool');
  } else if (typeof shareInPercent !== 'number') {
    throw new TypeError('Error! Passed a non-number share in percent');
  } else if (shareInPercent > 1 || shareInPercent < 0) {
    throw new RangeError('Error! Percentage is not in the right range');
  }

  // now we convert both of these to big numbers, so we can do the multiplication properly
  const pool = new DecimalLight(totalPool);
  const share = new DecimalLight(shareInPercent);

  const result = pool.times(share);
  const roundingMode = roundEvenUp ? DecimalLight.ROUND_HALF_UP : DecimalLight.ROUND_FLOOR; // for users, we round even up, for us, floow
  DecimalLight.config({ rounding: roundingMode });
  const resultAsNumber = result.toInteger().toNumber();

  logger(`Result of calculation: ${resultAsNumber}`);
  return resultAsNumber;
};
