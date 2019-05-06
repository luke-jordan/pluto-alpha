'use strict';

const logger = require('debug')('pluto:float:handler');

const dynamo = require('./persistence/dynamodb');
const rds = require('./persistence/rds');

const BigNumber = require('bignumber.js');
// make this guy safe for the world
BigNumber.prototype.valueOf = function () {
  throw Error('valueOf called!');
}

module.exports.accrue = async (event, context) => {

  event = { client_id: 'something', float_id: 'something_else' };

  return {
    statusCode: 400,
    body: JSON.stringify({
      message: 'Not built yet!',
      input: event,
    }),
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
}

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
module.exports.apportion = (amountToDivide = 1.345e4, accountTotals = { 'account-id-1': 563e4 }, appendExcess = true) => {
  const accountBalances = Object.values(accountTotals);
  if (accountBalances.some(balance => !Number.isInteger(balance))) {
    throw new TypeError('Error! One of the balances is not an integer');
  }

  // unless our total float itself approaches R100bn, this will not break integer values
  const accountTotal = accountBalances.reduce((a, b) => a + b, 0);
  
  let shareDict = { }; 
  const totalToShare = BigNumber(amountToDivide);
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