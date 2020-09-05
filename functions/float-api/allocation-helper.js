'use strict';

const logger = require('debug')('jupiter:float:accrual');
const opsUtil = require('ops-util-common');
const constants = require('./constants');

const DecimalLight = require('decimal.js-light');

const calculatePercent = (total, account) => (new DecimalLight(account)).dividedBy(total);

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
module.exports.allocate = async (event, rds) => {

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
        priorAllocationMap: currentAllocatedBalanceMap,
        bonusAllocation: bonusAllocationResult || { }
    };
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
    const totalToShare = new DecimalLight(amountToDivide);

    // NOTE: the percentage is of the account relative to all other accounts, not relative to the float at present, hence calculate percent
    // is called with the total of the prior existing balances, and then multiples the amount to apportion
    for (const accountId of accountTotals.keys()) {
        // logger(`For account ${accountId}, balance is ${accountTotals.get(accountId)}`);
        shareMap.set(accountId, calculatePercent(accountTotal, accountTotals.get(accountId)).times(totalToShare).toInteger().toNumber());
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
