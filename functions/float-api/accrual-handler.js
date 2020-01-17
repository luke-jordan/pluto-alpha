'use strict';

const logger = require('debug')('jupiter:float:accrual');
const opsUtil = require('ops-util-common');

const dynamo = require('./persistence/dynamodb');
const rds = require('./persistence/rds');
const csvFile = require('./persistence/csvfile');

const constants = require('./constants');

const BigNumber = require('bignumber.js');
// make this guy safe for the world
BigNumber.prototype.valueOf = () => {
  throw Error('valueOf called!');
};

const calculatePercent = (total, account) => (new BigNumber(account)).dividedBy(total);

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
    const accrualParameters = event['body'] || event;
    const clientId = accrualParameters.clientId;
    const floatId = accrualParameters.floatId;
    
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
    
    const userAllocations = await exports.allocate(userAllocationParams);

    // finally, we read back all the transactions with this log ID, stick them in a CSV, and stash them in S3
    const resultOfTxs = await rds.fetchRecordsRelatedToLog(logId);
    const resultOfStash = await csvFile.writeAndUploadCsv({ filePrefix: 'accrual', logId, rowsFromRds: resultOfTxs });
    logger('And result of stashing: ', resultOfStash);

    const returnBody = {
      newBalance: newFloatBalance.updatedBalance,
      entityAllocations: entityAllocationResults,
      userAllocationTransactions: userAllocations
    };

    logger('Returning: ', returnBody);

    return {
      statusCode: 200,
      body: JSON.stringify(returnBody)
    };
  } catch (e) {
    logger('FATAL_ERROR: ', e);
    return {
      statusCode: 500,
      body: JSON.stringify(e.message)
    };
  }
};

/**
 * Divides up all the allocations, records them, and does a massive batch insert as a single TX
 * If one allocation does not succeed, all need to be redone, otherwise the calculations will go (way) off
 * Note: this is generally the heart of the engine, and will require constant and continuous optimization, it will be 
 * triggered whenever another job detects unallocated amounts in the float.
 * @param {object} event An event object containing request body. The request body's properties are listed below.
 * @property {string} clientId The client co that this allocation event relates to
 * @property {string} floatId The float that is being allocated
 * @property {string} currency The currency of the allocation
 * @property {string} unit The units of the amount
 * @property {number} totalAmount The total amount being allocated
 * @property {string} transactionType The type of transaction (in here, almost always ACCRUAL, which is also default)
 * @property {string} transactionState The state of the transaction, defaults to SETTLED
 * @property {string} backingEntityIdentifier (Optional) If this allocation relates to some other entity, what is its identifier
 * @property {string} backingEntityType (Optional) If there is a backing / related entity, what is it (e.g., accrual transaction)
 * @property {string} bonusPoolIdForExcess (Optional) Where to put any fractional leftovers (or from where to take deficits)
 * @property {string} logId The log backing up this allocation
 */
module.exports.allocate = async (event) => {
  
  const params = event.body || event;
  const currentAllocatedBalanceMap = await rds.obtainAllAccountsWithPriorAllocations(
    params.floatId, params.currency, constants.entityTypes.END_USER_ACCOUNT
  );

  const unitsToAllocate = constants.floatUnits.DEFAULT;
  const amountToAllocate = opsUtil.convertToUnit(params.totalAmount, params.unit, constants.floatUnits.DEFAULT);
  
  const shareMap = exports.apportion(amountToAllocate, currentAllocatedBalanceMap, true);
  // logger('Allocated shares, map = ', shareMap);

  let bonusAllocationResult = { };
  const allocateRemainsToBonus = shareMap.has(constants.EXCESSS_KEY) && event.bonusPoolIdForExcess;

  if (allocateRemainsToBonus) {
    const excessAmount = shareMap.get(constants.EXCESSS_KEY);
    // store the allocation, store in bonus allocation Tx id
    const bonusAllocation = { 
      label: 'BONUS', 
      amount: excessAmount, 
      currency: params.currency,
      unit: unitsToAllocate,
      transactionType: params.transactionType || 'ACCRUAL',
      transactionState: params.transactionState || 'SETTLED',
      allocatedToType: constants.entityTypes.BONUS_POOL, 
      allocatedToId: event.bonusPoolIdForExcess,
      logId: params.logId
    };

    if (params.backingEntityIdentifier && params.backingEntityType) {
      bonusAllocation.relatedEntityType = params.backingEntityType;
      bonusAllocation.relatedEntityId = params.backingEntityIdentifier;
    }

    bonusAllocationResult = await rds.allocateFloat(params.clientId, params.floatId, [bonusAllocation]);
    bonusAllocationResult.amount = excessAmount;
  }

  shareMap.delete(constants.EXCESSS_KEY);

  const userAllocationInstructions = [];
  // todo : add in the backing entity for audits
  for (const accountId of shareMap.keys()) {
    userAllocationInstructions.push({
      accountId,
      amount: shareMap.get(accountId),
      currency: params.currency,
      unit: unitsToAllocate,
      allocType: params.transactionType || 'ACCRUAL',
      allocState: params.transactionState || 'SETTLED',
      relatedEntityType: params.backingEntityType,
      relatedEntityId: params.backingEntityIdentifier,
      logId: params.logId
    });
  }

  logger('Running user allocations of accrual, number instructions: ', userAllocationInstructions.length, 'first one: ', userAllocationInstructions[0]);
  const resultOfAllocations = await rds.allocateToUsers(params.clientId, params.floatId, userAllocationInstructions);
  logger('Result of allocations, first one: ', resultOfAllocations.result);
  
  return {
      allocationRecords: resultOfAllocations,
      bonusAllocation: bonusAllocationResult || { }
  };
};

// todo: add in capitalization at month end (think through how to do that)

/**
 * Utility method to reliably calculate a share, using BigNumber and a lot of tests to enforce robustness and avoid 
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
  const pool = new BigNumber(totalPool);
  const share = new BigNumber(shareInPercent);

  const result = pool.times(share);
  const roundingMode = roundEvenUp ? BigNumber.ROUND_HALF_UP : BigNumber.ROUND_FLOOR; // for users, we round even up, for us, floow
  const resultAsNumber = result.integerValue(roundingMode).toNumber();

  // logger(`Result of calculation: ${resultAsNumber}`);
  return resultAsNumber;
};

const checkBalancesIntegers = (accountBalances = new Map()) => {
  for (const balance of accountBalances.values()) {
    if (!Number.isInteger(balance)) {
      throw new TypeError('Error! One of the balances is not an integer: ', balance);
    }
  }
};

/**
 * A utility method to sum up all the account balances
 * @param {Map} accountBalances A map of account balances, with account ids as keys and balances as values
 */
const sumUpBalances = (accountBalances) => Array.from(accountBalances.values()).reduce((sum, value) => sum + value, 0);

/**
 * Core calculation method. Apportions an amount (i.e., the unallocated amount of a float) among an arbitrary length list of accounts
 * in proportion to each of those account's balances. Note that the share of the total allocated to a specific account is not that account's
 * balance divided by the total to be allocated, but that account's balance divided by the total balance of all the passed accounts.
 * Returns a new map with (again) the account ids as keys, but the values being the amount apportioned to the account from the total
 * @param {number} amountToDivide The total amount to split among the accounts
 * @param {Map} accountTotals A map of all accounts, with their IDs as keys and current balances as values
 * @param {boolean} appendExcess If true (default), then if there is an 'excess', i.e., a remainder due to rounding in the allocations,
 * that amount (positive if there are cents left over or negative if the reverse) is appended to the result map with the key 'excess'
 */
module.exports.apportion = (amountToDivide = 100, accountTotals = new Map(), appendExcess = true) => {
  // same reasoning as above for exposing this. note: account totals need to be all ints, else something is wrong upstream
  checkBalancesIntegers(accountTotals);

  // unless our total float itself approaches R100bn, this will not break integer values
  const shareMap = new Map(); 

  const accountTotal = sumUpBalances(accountTotals);
  const totalToShare = new BigNumber(amountToDivide);
  
  // NOTE: the percentage is of the account relative to all other accounts, not relative to the float at present, hence calculate percent
  // is called with the total of the prior existing balances, and then multiples the amount to apportion
  for (const accountId of accountTotals.keys()) {
    // logger(`For account ${accountId}, balance is ${accountTotals.get(accountId)}`);
    shareMap.set(accountId, calculatePercent(accountTotal, accountTotals.get(accountId)).times(totalToShare).integerValue().toNumber());
  }

  const apportionedAmount = sumUpBalances(shareMap);
  const excess = amountToDivide - apportionedAmount;
  
  logger(`Finished apportioning balances, handed ${amountToDivide} to divide, divied up ${apportionedAmount}, left with ${excess} excess`);

  if (appendExcess && excess !== 0) {
    shareMap.set('excess', excess);
  } else if (excess !== 0) {
    // this doesn't make sense, revisit it once all in place
    exports.apportion(excess, accountTotals, false);
  }
  
  return shareMap;
};

// leaving here as later documentation of why we are using bignumber instead of integers

// const bigPool = 100 * 1e9 * 100 * 100; // one hundred billion rand in hundredths of cents
// const takeShare = 0.2 * 100 * 100; // in basis points, 20%

// const result = bigPool * takeShare;
// console.log('result : ', result);
// console.log('Is it a safe int? : ', Number.isSafeInteger(result));
