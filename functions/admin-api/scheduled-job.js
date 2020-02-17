'use strict';

const logger = require('debug')('jupiter:admin:scheduled');
const config = require('config');
const moment = require('moment');
const DecimalLight = require('decimal.js-light');
const rdsAccount = require('./persistence/rds.account');
const rdsFloat = require('./persistence/rds.float');
const dynamoFloat = require('./persistence/dynamo.float');
const floatConsistency = require('./admin-float-consistency');
const opsUtil = require('ops-util-common');
const publisher = require('publish-common');
const stringFormat = require('string-format');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });
const lambda = new AWS.Lambda();

const MILLIS_IN_DAY = 86400000;
const FORMAT_NUM_DIGITS = 4;

const expireHangingTransactions = async () => {
    const resultOfExpiration = await rdsAccount.expireHangingTransactions();
    return resultOfExpiration.length;
};

const expireBoosts = async () => {
    const expiredBoosts = await rdsAccount.expireBoosts();
    logger('Expired boosts for ', expiredBoosts.length, ' account-boost pairs');
    if (expiredBoosts.length === 0) {
        logger('No boosts to expire, returning');
        return { result: 'NO_BOOSTS' };
    }

    const accountIds = expiredBoosts.map((row) => row.accountId);
    const userIdsExpired = await rdsAccount.fetchUserIdsForAccounts(accountIds);
    
    const boostExpireUserIds = { };
    expiredBoosts.forEach((row) => {
        if (!Object.keys(boostExpireUserIds).includes(row.boostId)) {
            boostExpireUserIds[row.boostId] = [];
        }
        const userId = userIdsExpired[row.accountId];
        boostExpireUserIds[row.boostId].push(userId);
    });

    const boostIds = Object.keys(boostExpireUserIds);
    const logPublishPromises = boostIds.map((boostId) => (
        publisher.publishMultiUserEvent(boostExpireUserIds[boostId], 'BOOST_EXPIRED', { context: { boostId }})
    ));
    await Promise.all(logPublishPromises);
    return { result: 'EXPIRED_BOOSTS', boostsExpired: expiredBoosts.length };
};

const obtainFloatBalance = async ({ clientId, floatId, currency }) => {
    const floatBalanceMap = await rdsFloat.getFloatBalanceAndFlows([floatId]);
    const floatBalanceCurr = floatBalanceMap.get(floatId);
    const floatBalanceInfo = floatBalanceCurr[currency];
    logger('For client-float: ', `${clientId}::${floatId}`, ', extracted float balance info: ', floatBalanceInfo);
    return opsUtil.convertToUnit(floatBalanceInfo.amount, floatBalanceInfo.unit, 'HUNDREDTH_CENT');
};

const assembleAccrualPayload = async (clientFloatInfo) => {
    logger('Assembling from: ', clientFloatInfo);

    const floatAmountHunCent = await obtainFloatBalance(clientFloatInfo);
    const lastFloatAccrualTime = await rdsFloat.getLastFloatAccrualTime(clientFloatInfo.floatId, clientFloatInfo.clientId);
    
    // see the balance handler for a more detailed & commented version
    const accrualRateAnnualBps = clientFloatInfo.accrualRateAnnualBps;
    const basisPointDivisor = 100 * 100; // i.e., hundredths of a percent
    const annualAccrualRateNominalGross = new DecimalLight(accrualRateAnnualBps).dividedBy(basisPointDivisor);
    // note : assumes the annual rate is simple, not effective
    const dailyAccrualRateNominalNet = annualAccrualRateNominalGross.dividedBy(365);
    
    const calculationTimeMillis = moment().valueOf();
    const millisSinceLastCalc = calculationTimeMillis - lastFloatAccrualTime.valueOf();
    logger(`Last calculation was at ${lastFloatAccrualTime.format()}, which is ${millisSinceLastCalc} msecs ago, and there are ${MILLIS_IN_DAY} msecs in a day`);
    const portionOfDay = new DecimalLight(millisSinceLastCalc).dividedBy(new DecimalLight(MILLIS_IN_DAY));
    logger(`That works out to ${portionOfDay.toNumber()} as a proportion of a day, since the last calc`);
    const accrualRateToApply = dailyAccrualRateNominalNet.times(portionOfDay);
    logger(`And hence, from an annual ${annualAccrualRateNominalGross.toNumber()}, an amount to apply of ${accrualRateToApply.toNumber()}`);

    const todayAccrualAmount = new DecimalLight(floatAmountHunCent).times(accrualRateToApply);
    logger(`Another check: ${todayAccrualAmount.toNumber()}, rate to apply: ${accrualRateToApply.toNumber()}`);
    logger(`Altogether, with annual bps of ${accrualRateAnnualBps}, and a float balance of ${floatAmountHunCent}, we have an accrual of ${todayAccrualAmount.toNumber()}`);

    const identifierToUse = `SYSTEM_CALC_DAILY_${calculationTimeMillis}`;

    // add calculation basis for logging, notification email, etc. 
    const calculationBasis = {
        floatAmountHunCent,
        accrualRateAnnualBps,
        millisSinceLastCalc,
        accrualRateApplied: accrualRateToApply.toNumber()
    };

    // todo : store the calculation basis in the float log
    return {
        clientId: clientFloatInfo.clientId,
        floatId: clientFloatInfo.floatId,
        accrualAmount: todayAccrualAmount.toDecimalPlaces(0).toNumber(),
        currency: clientFloatInfo.currency,
        unit: 'HUNDREDTH_CENT',
        referenceTimeMillis: calculationTimeMillis,
        backingEntityIdentifier: identifierToUse,
        backingEntityType: 'ACCRUAL_EVENT',
        calculationBasis
    };
};

const assembleAccrualInvocation = async (clientFloatInfo) => {
    const accrualPayload = await assembleAccrualPayload(clientFloatInfo);

    const accrualInvocation = {
        FunctionName: config.get('lambdas.processAccrual'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(accrualPayload)
    };

    logger('Accrual invocation: ', accrualInvocation);

    return accrualInvocation;
};

const safeSimpleFormat = (objectWithAmount, unit, currency) => {
    if (!objectWithAmount) {
        return 'Unknown : Error, consult logs';
    }

    if (typeof objectWithAmount.amount !== 'number' && typeof objectWithAmount.amount !== 'string') {
        return 'Unknown : bad number parameter';
    }

    const amount = typeof objectWithAmount.amount === 'number' ? objectWithAmount.amount : parseInt(objectWithAmount.amount, 10);
    return `${currency} ${parseFloat(opsUtil.convertToUnit(amount, unit, 'WHOLE_CURRENCY')).toFixed(FORMAT_NUM_DIGITS)}`;
};

const extractParamsForFloatAccrualEmail = (accrualInvocation, accrualInvocationResult) => {
    const resultPayload = JSON.parse(accrualInvocationResult['Payload']);
    const resultBody = JSON.parse(resultPayload.body);

    const accrualInstruction = JSON.parse(accrualInvocation['Payload']);
    const unit = accrualInstruction.unit;
    const currency = accrualInstruction.currency;
    
    const bonusFeeRaw = resultBody.entityAllocations['BONUS_FEE'];
    const companyFeeRaw = resultBody.entityAllocations['CLIENT_FEE'];

    const bonusShareRaw = resultBody.entityAllocations['BONUS_SHARE'];
    const companyShareRaw = resultBody.entityAllocations['CLIENT_SHARE'];

    const numberUserAllocations = resultBody.userAllocationTransactions.allocationRecords.accountTxIds.length;
    const bonusAllocation = Reflect.has(resultBody.userAllocationTransactions, 'bonusAllocation') 
        ? 'None' : '(yes : insert excess)';

    const bpsToPercentAndTrim = (rate) => parseFloat(rate * 100).toFixed(FORMAT_NUM_DIGITS);

    return {
        clientId: accrualInstruction.clientId,
        floatId: accrualInstruction.floatId,
        floatAmount: safeSimpleFormat({ amount: accrualInstruction.calculationBasis.floatAmountHunCent }, unit, currency),
        baseAccrualRate: `${accrualInstruction.calculationBasis.accrualRateAnnualBps} bps`,
        dailyRate: `${bpsToPercentAndTrim(accrualInstruction.calculationBasis.accrualRateApplied)} %`,
        accrualAmount: safeSimpleFormat({ amount: accrualInstruction.accrualAmount }, unit, currency),
        bonusAmount: safeSimpleFormat(bonusFeeRaw, unit, currency),
        companyAmount: safeSimpleFormat(companyFeeRaw, unit, currency),
        bonusShare: safeSimpleFormat(bonusShareRaw, unit, currency),
        companyShare: safeSimpleFormat(companyShareRaw, unit, currency),
        numberUserAllocations,
        bonusAllocation: JSON.stringify(bonusAllocation)
    };
};

const initiateFloatAccruals = async () => {
    const clientsAndFloats = await dynamoFloat.listClientFloats();
    logger('Have client and float info: ', clientsAndFloats);
    
    // we do these in two distinct stages so that we can retain the calculation basis etc in the invocations
    // we do rely somewhat on Promise.all preserving order, which is part of spec, but keep an eye out once many floats
    const accrualInvocations = await Promise.all(clientsAndFloats.map((clientAndFloat) => assembleAccrualInvocation(clientAndFloat)));
    const accrualInvocationResults = await Promise.all(accrualInvocations.map((invocation) => lambda.invoke(invocation).promise()));

    logger('Results of accruals: ', accrualInvocationResults);

    // todo: use more robust templating so can handle indefinite length arrays, for now just do this one
    const accrualEmailDetails = extractParamsForFloatAccrualEmail(accrualInvocations[0], accrualInvocationResults[0]);

    const emailResult = await publisher.sendSystemEmail({
        subject: 'Daily float accrual results',
        toList: config.get('email.accrualResult.toList'),
        bodyTemplateKey: config.get('email.accrualResult.templateKey'),
        templateVariables: accrualEmailDetails
    });

    logger('Result of email send: ', emailResult);

    return accrualInvocations.length;
};

const formatAllPendingTransactionsForEmail = async (allPendingTransactions) => {
    logger(`Formatting all pending transactions for email. Pending Transactions: ${JSON.stringify(allPendingTransactions)}`);
    const transactionsWithWholeCurrencyAmount = allPendingTransactions.map((transaction) => ({ ...transaction, wholeCurrencyAmount: opsUtil.convertToUnit(transaction.amount, transaction.unit, 'WHOLE_CURRENCY'), unit: 'WHOLE_CURRENCY' }));
    const htmlTemplateForRow = `
        <tr>
            <td>{humanReference}</td>
            <td>{currency} {wholeCurrencyAmount}</td>
            <td>{unit}</td>
            <td>{transactionType}</td>
            <td>{creationTime}</td>
            <td>{settlementStatus}</td>
         </tr>
    `;
    logger('html template', htmlTemplateForRow);
    const startingValue = '';
    const pendingTransactionsFormattedForEmail = transactionsWithWholeCurrencyAmount.reduce((accumulator, pendingTransaction) => {
        const transactionAsTableRow = stringFormat(htmlTemplateForRow, pendingTransaction);
        return `${accumulator} ${transactionAsTableRow}`;
    }, startingValue);

    logger(`Successfully formatted all pending transactions for email. Transactions: ${JSON.stringify(pendingTransactionsFormattedForEmail)}`);
    return pendingTransactionsFormattedForEmail;
};

const notifyAdminOfPendingTransactionsForAllUsers = async () => {
    logger('Start job to notify admin of pending transactions for all users');

    const startTime = moment(0).format(); // fetch pending transactions for all time i.e. 1970 till date
    const endTime = moment().format();
    const allPendingTransactions = await rdsAccount.fetchPendingTransactionsForAllUsers(startTime, endTime);
    if (!allPendingTransactions || allPendingTransactions.length === 0) {
        logger('all tx', allPendingTransactions);
        logger('No pending transactions, returning');
        return { result: 'NO_PENDING_TRANSACTIONS' };
    }

    const allPendingTransactionsEmailDetails = await formatAllPendingTransactionsForEmail(allPendingTransactions);
    const emailResult = await publisher.sendSystemEmail({
        subject: config.get('email.allPendingTransactions.subject'),
        toList: config.get('email.allPendingTransactions.toList'),
        bodyTemplateKey: config.get('email.allPendingTransactions.templateKey'),
        templateVariables: {
            pendingTransactionsTableInHTML: allPendingTransactionsEmailDetails
        }
    });

    logger(`Result of email to notify admin of pending transactions for all users. Email Result: ${JSON.stringify(emailResult)}`);
    return allPendingTransactions.length;
};

// note : system stat email transferred to data pipeline, for various reasons

// used to control what should execute
const operationMap = {
    'ACRRUE_FLOAT': initiateFloatAccruals,
    'EXPIRE_HANGING': expireHangingTransactions,
    'EXPIRE_BOOSTS': expireBoosts, 
    'CHECK_FLOATS': floatConsistency.checkAllFloats,
    'ALL_PENDING_TRANSACTIONS': notifyAdminOfPendingTransactionsForAllUsers
};

/**
 * Runs daily. Does several things:
 * (1) checks for accruals on each float & then triggers the relevant job
 * (2) sends an email to the designated list with key stats for the day
 * (3) cleans up transaction ledger by setting old pending transactions to expired
 */
module.exports.runRegularJobs = async (event) => {
    logger('Scheduled job received event: ', event);

    const tasksToRun = Array.isArray(event.specificOperations) ? event.specificOperations : config.get('defaults.scheduledJobs');
    const promises = tasksToRun.filter((operation) => Reflect.has(operationMap, operation)).map((operation) => operationMap[operation]());
    const results = await Promise.all(promises);

    logger('Results of tasks: ', results);

    return {
        statusCode: 200,
        body: results
    };
};
