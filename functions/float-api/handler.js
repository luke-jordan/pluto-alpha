'use strict';

const logger = require('debug')('pluto:float:handler');

const dynamo = require('./persistence/dynamodb');
const rds = require('./persistence/rds');

const constants = require('./constants');

const BigNumber = require('bignumber.js');
// make this guy safe for the world
BigNumber.prototype.valueOf = function () {
  throw Error('valueOf called!');
}

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
module.exports.accrue = async (event, context) => {
  const accrualParameters = event['body'] || event;
  const clientId = accrualParameters.clientId;
  const floatId = accrualParameters.floatId;

  const floatConfig = await dynamo.fetchConfigVarsForFlat(clientId, floatId);
  
  const accrualAmount = accrualParameters.accrualAmount;
  const accrualCurrency = accrualParameters.currency || floatConfig.currency;
  const accrualUnit = accrualParameters.unit || floatConfig.unit;
  
  const allocationBase = {
    currency: accrualCurrency,
    unit: accrualUnit,
    relatedEntityType: constants.entityTypes.ACCRUAL_EVENT,
    relatedEntityId: accrualParameters.backingEntityIdentifier
  };

  const bonusAllocation = JSON.parse(JSON.stringify(allocationBase));
  bonusAllocation.amount = exports.calculateShare(accrualAmount, floatConfig.bonusPoolShare);
  bonusAllocation.allocatedToType = constants.entityTypes.BONUS_POOL;
  bonusAllocation.allocatedToId = floatConfig.bonusPoolTracker;

  const companyAllocation = JSON.parse(JSON.stringify(allocationBase));
  companyAllocation.amount = exports.calculateShare(accrualAmount, floatConfig.companyShare);
  companyAllocation.allocatedToType = constants.entityTypes.COMPANY_SHARE;
  companyAllocation.allocatedToId = floatConfig.companyShareTracker;

  const newFloatBalance = await rds.addOrSubtractFloat({ clientId, floatId, amount: accrualAmount, currency: accrualCurrency, unit: accrualUnit });
  const entityAllocations = await rds.allocateFloat(clientId, floatId, [bonusAllocation, companyAllocation]);

  const remainingAmount = accrualAmount - bonusAllocation.amount - companyAllocation.amount;
  const userAllocEvent = { clientId, floatId, totalAmount: amount, currency: accrualCurrency, 
    backingEntityType: constants.entityTypes.ACCRUAL_EVENT, backingEntityIdentifier: backingEntityIdentifier };
  
  const userAllocations = await exports.allocate(userAllocEvent);

  const returnBody = {
    newBalance: newFloatBalance,
    entityAllocations: entityAllocations,
    userAllocationTransactions: userAllocations
  };

  return {
    statusCode: 200,
    body: JSON.stringify(returnBody),
  };
};

// handled separately, divides up all the allocations, records them, and does a massive batch insert as a single TX
// if one allocation does not succeed, all need to be redone, otherwise the calculations will go (way) off
// note: this is generally the heart of things, and will require constant and continuous optimization, it will be 
// triggered whenever another job detects unallocated amounts in the float, and gets passed: (i) the account totals, and (ii) amount to divide
module.exports.allocate = async (event, context) => {
  return {
    statusCode: 400,
    body: JSON.stringify({
      message: 'Not built yet!',
      input: event,
    }),
  };
};

// todo: add in capitalization at month end (think through how to do that)

// this doesn't necessarily need to be public but (1) we might in a future refactor use it as its own lambda, 
// and (2) it is easily important enough that we need to have it thoroughly covered on its own, even if it is small,
// and that isn't a good enough reason to break the basic point that we shouldn't test private methods on its own and use rewire
// NB: this assumes share in percent is in the strict sense of the word, i.e., 0 <= percent <= 1
module.exports.calculateShare = (totalPool = 1.23457e8, shareInPercent = 0.0165, roundEvenUp = true) => {
  logger(`Calculating an apportionment, total pool : ${totalPool}, and share: ${shareInPercent}`);
  // we do not want to introduce floating points, because that is bad, so first we check to make sure total pool is effectively an int
  // note: basic logic is that total pool should be expressed in hundredths of a cent, if it is not, this is an error
  // note: bignumber can handle non-integer of course, but that would allow greater laxity than we want in something this important
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
}

const calculatePercent = (total, account) => {
  return BigNumber(account).dividedBy(total);
}

// same reasoning as above for exposing this. note: account totals need to be all ints, else something is wrong upstream
module.exports.apportion = (amountToDivide = 1.345e4, accountTotals = new Map(), appendExcess = true) => {
  const accountBalances = Object.values(accountTotals);
  if (accountBalances.some(balance => !Number.isInteger(balance))) {
    throw new TypeError('Error! One of the balances is not an integer');
  }

  // unless our total float itself approaches R100bn, this will not break integer values
  const accountTotal = accountBalances.reduce((a, b) => a + b, 0);
  
  let shareDict = { }; 
  const totalToShare = BigNumber(amountToDivide);
  
  // NOTE: the percentage is of the account relative to all other accounts, not relative to the float at present, hence calculate percent
  // is called with the total of the prior existing balances, and then multiples the amount to apportion
  Object.keys(accountTotals).forEach((accountId) => {
    shareDict[accountId] = calculatePercent(accountTotal, accountTotals[accountId]).times(totalToShare).integerValue().toNumber();
  });

  const apportionedAmount = Object.values(shareDict).reduce((a, b) => a + b, 0);
  const excess = amountToDivide - apportionedAmount;
  
  logger(`Finished apportioning balances, handed ${amountToDivide} to divide, divied up ${apportionedAmount}, left with ${excess} excess`);

  if (appendExcess && excess !== 0) {
    shareDict['excess'] = excess;
  } else if (excess !== 0) {
   exports.apportion(excess, accountTotals, false);
  }
  
  return shareDict;
};

// leaving here as later documentation of why we are using bignumber instead of integers

// const bigPool = 100 * 1e9 * 100 * 100; // one hundred billion rand in hundredths of cents
// const takeShare = 0.2 * 100 * 100; // in basis points, 20%

// const result = bigPool * takeShare;
// console.log('result : ', result);
// console.log('Is it a safe int? : ', Number.isSafeInteger(result));