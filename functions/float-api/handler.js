'use strict';

const logger = require('debug')('pluto:float:handler');

const dynamo = require('./persistence/dynamodb');
const rds = require('./persistence/rds');

const constants = require('./constants');

const BigNumber = require('bignumber.js');
// make this guy safe for the world
BigNumber.prototype.valueOf = () => {
  throw Error('valueOf called!');
};

/**
 * The core function. Receives an instruction that interest (or other return) has been accrued, increases the balance recorded,
 * and then allocates the amounts to the client's bonus and company shares, and thereafter allocates to all accounts with 
 * contributions to the float in the past. Expects the following parameters in the lambda invocation or body of the post
 * @param {string} clientId The system wide ID of the client that handles the float that is receiving the accrual
 * @param {string} floatId The system wide ID of the float that has received an accrual
 * @param {number} accrualAmount The amount of the accrual, in the currency and units passed in the other parameters
 * @param {string} currency The currency of the accrual. If not provided, defaults to the currency of the float.
 * @param {string} unit The units in which the amount is expressed. If not provided, defaults to float default.
 * @param {string} backingEntityIdentifier An identifier for the backing transaction (e.g., the accrual tx ID in the wholesale institution)
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
    
    const allocationCommon = {
      currency: accrualCurrency,
      unit: accrualUnit,
      relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,
      relatedEntityId: accrualParameters.backingEntityIdentifier
    };

    const bonusAllocation = JSON.parse(JSON.stringify(allocationCommon));
    bonusAllocation.label = 'BONUS';
    bonusAllocation.amount = exports.calculateShare(accrualAmount, floatConfig.bonusPoolShare);
    bonusAllocation.allocatedToType = constants.entityTypes.BONUS_POOL;
    bonusAllocation.allocatedToId = floatConfig.bonusPoolTracker;
    
    const clientAllocation = JSON.parse(JSON.stringify(allocationCommon));
    clientAllocation.label = 'CLIENT';
    clientAllocation.amount = exports.calculateShare(accrualAmount, floatConfig.clientCoShare);
    clientAllocation.allocatedToType = constants.entityTypes.COMPANY_SHARE;
    clientAllocation.allocatedToId = floatConfig.clientCoShareTracker;

    logger('Company allocation: ', clientAllocation);

    const newFloatBalance = await rds.addOrSubtractFloat({ clientId, floatId, amount: accrualAmount, currency: accrualCurrency,
      transactionType: constants.floatTransTypes.ACCRUAL, unit: accrualUnit, backingEntityIdentifier: accrualParameters.backingEntityIdentifier });
    logger('New float balance: ', newFloatBalance);
      
    const entityAllocationIds = await rds.allocateFloat(clientId, floatId, [bonusAllocation, clientAllocation]);
    logger('Allocation IDs: ', entityAllocationIds);

    const entityAllocations = {
      bonusShare: bonusAllocation.amount,
      bonusTxId: entityAllocationIds.find((row) => Object.keys(row).includes('BONUS')).BONUS,
      clientShare: clientAllocation.amount,
      clientTxId: entityAllocationIds.find((row) => Object.keys(row).includes('CLIENT')).CLIENT
    };

    const remainingAmount = accrualAmount - bonusAllocation.amount - clientAllocation.amount;
    const userAllocEvent = { clientId, floatId, 
      totalAmount: remainingAmount, 
      currency: accrualCurrency, 
      backingEntityType: constants.entityTypes.ACCRUAL_EVENT, 
      backingEntityIdentifier: accrualParameters.backingEntityIdentifier 
    };
    
    const userAllocations = await exports.allocate(userAllocEvent);

    const returnBody = {
      newBalance: newFloatBalance.currentBalance,
      entityAllocations: entityAllocations,
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
      body: ''
    };
  }
};

/**
 * Divides up all the allocations, records them, and does a massive batch insert as a single TX
 * If one allocation does not succeed, all need to be redone, otherwise the calculations will go (way) off
 * Note: this is generally the heart of the engine, and will require constant and continuous optimization, it will be 
 * triggered whenever another job detects unallocated amounts in the float.
 * @param {string} clientId The client co that this allocation event relates to
 * @param {string} floatId The float that is being allocated
 * @param {string} currency The currency of the allocation
 * @param {string} unit The units of the amount
 * @param {number} totalAmount The total amount being allocated
 * @param {string} backingEntityIdentifier (Optional) If this allocation relates to some other entity, what is its identifier
 * @param {string} backingEntityType (Optional) If there is a backing / related entity, what is it (e.g., accrual transaction)
 */
module.exports.allocate = async (event) => {
  
  const params = event.body || event;
  const currentAllocatedBalanceMap = await rds.obtainAllAccountsWithPriorAllocations(
    params.floatId, params.currency, constants.entityTypes.END_USER_ACCOUNT, false
  );

  const amountToAllocate = params.totalAmount; // || fetch unallocated amount
  const unitsToAllocate = params.unit || constants.floatUnits.DEFAULT;

  const shareMap = await exports.apportion(amountToAllocate, currentAllocatedBalanceMap, true);
  // logger('Allocated shares, map = ', shareMap);

  let bonusAllocationResult = { };
  if (shareMap.has(constants.EXCESSS_KEY)) {
    const excessAmount = shareMap.get(constants.EXCESSS_KEY);
    // store the allocation, store in bonus allocation Tx id
    const bonusPool = await dynamo.fetchConfigVarsForFloat(params.clientId, params.floatId);
    const bonusAlloc = { label: 'BONUS', amount: excessAmount, currency: params.currency, unit: unitsToAllocate, 
      allocatedToType: constants.entityTypes.BONUS_POOL, allocatedToId: bonusPool.bonusPoolTracker };
    if (params.backingEntityIdentifier && params.backingEntityType) {
      bonusAlloc.relatedEntityType = params.backingEntityType;
      bonusAlloc.relatedEntityId = params.backingEntityIdentifier;
    }
    bonusAllocationResult = await rds.allocateFloat(params.clientId, params.floatId, [bonusAlloc]);
    shareMap.delete(constants.EXCESSS_KEY);
  }

  const allocRequests = [];
  // todo : add in the backing entity for audits
  for (const accountId of shareMap.keys()) {
    allocRequests.push({
      accountId: accountId,
      amount: shareMap.get(accountId),
      currency: params.currency,
      unit: unitsToAllocate
    });
  }

  const resultOfAllocations = await rds.allocateToUsers(params.clientId, params.floatId, allocRequests);
  // logger('Result of allocations: ', resultOfAllocations);
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      allocationRecords: resultOfAllocations,
      bonusAllocation: bonusAllocationResult || { }
    })
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
  logger(`Calculating an apportionment, total pool : ${totalPool}, and share: ${shareInPercent}`);
  // we do not want to introduce floating points, because that is bad, so first we check to make sure total pool is effectively an int
  // note: basic logic is that total pool should be expressed in hundredths of a cent, if it is not, this is an error
  // note: bignumber can handle non-integer of course, but that would allow greater laxity than we want in something this important
  logger('Total pool: ', totalPool);
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

  logger(`Result of calculation: ${resultAsNumber}`);
  return resultAsNumber;
};

const calculatePercent = (total, account) => (new BigNumber(account)).dividedBy(total);

const checkBalancesIntegers = (accountBalances = new Map()) => {
  for (const balance of accountBalances.values()) {
    if (!Number.isInteger(balance)) {
      throw new TypeError('Error! One of the balances is not an integer');
    }
  }
};

/**
 * A utility method to sum up all the account balances
 * @param {Map} accountBalances A map of account balances, with account ids as keys and balances as values
 */
const sumUpBalances = (accountBalances = new Map()) => {
  let amount = 0;
  for (const balance of accountBalances.values()) {
    amount += balance;
  }
  return amount;
};

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
