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

const assembleAccrualData = (accrualInvocation, accrualInvocationResult) => {
    const resultPayload = JSON.parse(accrualInvocationResult['Payload']);
    const resultBody = JSON.parse(resultPayload.body);

    const accrualInstruction = JSON.parse(accrualInvocation['Payload']);
    const unit = accrualInstruction.unit;
    const currency = accrualInstruction.currency;
    
    const bonusFee = resultBody.entityAllocations['BONUS_FEE'];
    const companyFee = resultBody.entityAllocations['CLIENT_FEE'];

    const bonusShare = resultBody.entityAllocations['BONUS_SHARE'];
    const companyShare = resultBody.entityAllocations['CLIENT_SHARE'];

    const numberUserAllocations = resultBody.userAllocationTransactions.allocationRecords.accountTxIds.length;
    const bonusExcessAllocation = Reflect.has(resultBody.userAllocationTransactions, 'bonusAllocation');

    return {
        clientId: accrualInstruction.clientId,
        floatId: accrualInstruction.floatId,
        calculationUnit: unit,
        calculationCurrency: currency,
        floatAmount: accrualInstruction.calculationBasis.floatAmountHunCent,
        baseAccrualRate: accrualInstruction.calculationBasis.accrualRateAnnualBps,
        dailyRate: accrualInstruction.calculationBasis.accrualRateApplied,
        accrualAmount: accrualInstruction.accrualAmount,
        bonusFee,
        companyFee,
        bonusShare,
        companyShare,
        numberUserAllocations,
        bonusExcessAllocation
    };
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

const extractParamsForFloatAccrualEmail = (accrualParamsAndResults) => {
    const bonusAllocation = accrualParamsAndResults.bonusExcessAllocation ? '(yes : insert excess)' : 'None';

    const bpsToPercentAndTrim = (rate) => parseFloat(rate * 100).toFixed(FORMAT_NUM_DIGITS);
    const { clientId, floatId, calculationUnit: unit, calculationCurrency: currency } = accrualParamsAndResults;

    return {
        clientId,
        floatId,
        floatAmount: safeSimpleFormat({ amount: accrualParamsAndResults.floatAmount }, unit, currency),
        baseAccrualRate: `${accrualParamsAndResults.baseAccrualRate} bps`,
        dailyRate: `${bpsToPercentAndTrim(accrualParamsAndResults.dailyRate)} %`,
        accrualAmount: safeSimpleFormat({ amount: accrualParamsAndResults.accrualAmount }, unit, currency),
        bonusAmount: safeSimpleFormat(accrualParamsAndResults.bonusFee, unit, currency),
        companyAmount: safeSimpleFormat(accrualParamsAndResults.companyFee, unit, currency),
        bonusShare: safeSimpleFormat(accrualParamsAndResults.bonusShare, unit, currency),
        companyShare: safeSimpleFormat(accrualParamsAndResults.companyShare, unit, currency),
        numberUserAllocations: accrualParamsAndResults.numberUserAllocations,
        bonusAllocation: JSON.stringify(bonusAllocation)
    };
};

const invokeAccrualAndPublish = async (clientFloatInfo) => {
    const accrualPayload = await assembleAccrualPayload(clientFloatInfo);

    const accrualInvocation = {
        FunctionName: config.get('lambdas.processAccrual'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify(accrualPayload)
    };

    logger('Accrual invocation: ', accrualInvocation);

    const accrualResult = await lambda.invoke(accrualInvocation).promise();
    logger('Accrual result from lambda: ', accrualResult);

    try {
        const accrualParamsAndResults = assembleAccrualData(accrualInvocation, accrualResult);
    
        const eventOptions = { initiator: 'scheduled_daily_system_job', context: accrualParamsAndResults };
        await publisher.publishUserEvent(`${clientFloatInfo.clientId}::${clientFloatInfo.floatId}`, 'FLOAT_ACCRUAL', eventOptions);
    
        // todo: consider using a single email and/or extracting admin from client-float pair
        const accrualEmailDetails = extractParamsForFloatAccrualEmail(accrualParamsAndResults);
    
        if (config.get('email.accrualResult.enabled')) {
            const emailResult = await publisher.sendSystemEmail({
                subject: 'Daily float accrual results',
                toList: config.get('email.accrualResult.toList'),
                bodyTemplateKey: config.get('email.accrualResult.templateKey'),
                templateVariables: accrualEmailDetails
            });
            
            logger('Result of email send: ', emailResult);
        }
        
        return accrualEmailDetails;    
    } catch (err) {
        // since the above are not essential (just notifications), we do not want to trigger a rerun of everything
        // but do need a notification, so do so here 
        logger('FATAL_ERROR:', err);
        return 'PUBLICATION_ERROR';
    }
};

const initiateFloatAccruals = async () => {
    const clientsAndFloats = await dynamoFloat.listClientFloats();
    logger('Have client and float info: ', clientsAndFloats);
    
    // we do these in two distinct stages so that we can retain the calculation basis etc in the invocations
    // we do rely somewhat on Promise.all preserving order, which is part of spec, but keep an eye out once many floats
    const accrualInvocationResults = await Promise.all(clientsAndFloats.map((clientAndFloat) => invokeAccrualAndPublish(clientAndFloat)));
    // const accrualInvocationResults = await Promise.all(accrualInvocations.map((invocation) => lambda.invoke(invocation).promise()));

    logger('Results of accruals: ', accrualInvocationResults);

    return accrualInvocationResults.length;
};

const generateUserViewLink = (humanRef) => {
    const profileSearch = `users?searchValue=${encodeURIComponent(humanRef)}&searchType=bankReference`;
    return `${config.get('email.systemLinks.baseUrl')}/#/${profileSearch}`;
};

const formatAllPendingTransactionsForEmail = async (allPendingTransactions) => {
    logger(`Formatting all pending transactions for email. Pending Transactions: ${JSON.stringify(allPendingTransactions)}`);
    const transactionsForHumans = allPendingTransactions.map((transaction) => ({ 
        ...transaction, 
        wholeCurrencyAmount: opsUtil.convertToUnit(transaction.amount, transaction.unit, 'WHOLE_CURRENCY'), 
        creationTime: moment(transaction.creationTime).format('MMMM Do YYYY, h:mm:ss a'),
        linkToUser: generateUserViewLink(transaction.humanReference)
    }));
    
    const htmlTemplateForRow = `
        <tr>
            <td>{humanReference}</td>
            <td>{currency} {wholeCurrencyAmount}</td>
            <td>{transactionType}</td>
            <td>{creationTime}</td>
            <td>{settlementStatus}</td>
            <td><a href='{linkToUser}'>User profile</a></td>
         </tr>`;
    
    logger('html template', htmlTemplateForRow);
    
    const startingValue = '';
    const pendingTransactionsFormattedForEmail = transactionsForHumans.reduce((accumulator, pendingTransaction) => {
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
        logger('No pending transactions, returning');
        return { result: 'NO_PENDING_TRANSACTIONS' };
    }
    
    const allPendingTransactionsEmailDetails = await formatAllPendingTransactionsForEmail(allPendingTransactions);

    const emailResult = await publisher.sendSystemEmail({
        subject: config.get('email.allPendingTransactions.subject'),
        toList: config.get('email.allPendingTransactions.toList'),
        bodyTemplateKey: config.get('email.allPendingTransactions.templateKey'),
        templateVariables: {
            presentDate: moment().format('dddd, MMMM Do YYYY, h:mm:ss a'),
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
    if (!event.specificOperations) {
        logger('Default job pattern is now turned off');
        return { statusCode: 400 };
    }

    // leaving some robustness in otherwise might get loops of recurring failure
    const tasksToRun = Array.isArray(event.specificOperations) ? event.specificOperations : [];
    const promises = tasksToRun.filter((operation) => Reflect.has(operationMap, operation)).map((operation) => operationMap[operation]());
    const results = await Promise.all(promises);

    logger('Results of tasks: ', results);

    return {
        statusCode: 200,
        body: results
    };
};
