'use strict';

const logger = require('debug')('jupiter:admin:scheduled');
const config = require('config');
const moment = require('moment');

const BigNumber = require('bignumber.js');

const rdsAccount = require('./persistence/rds.admin');
const rdsFloat = require('./persistence/rds.analytics');
const dynamoFloat = require('./persistence/dynamo.float');

const opsUtil = require('ops-util-common');
const publisher = require('publish-common');

const AWS = require('aws-sdk');
AWS.config.update({ region: config.get('aws.region') });
const lambda = new AWS.Lambda();

const MILLIS_IN_DAY = 86400000;

const expireHangingTransactions = async () => {
    const resultOfExpiration = await rdsAccount.expireHangingTransactions();
    return resultOfExpiration.length;
};

const assembleAccrualPayload = async (clientFloatInfo) => {
    logger('Assembling from: ', clientFloatInfo);

    const floatBalanceMap = await rdsFloat.getFloatBalanceAndFlows([clientFloatInfo.floatId]);
    const floatBalanceCurr = floatBalanceMap.get(clientFloatInfo.floatId);
    logger('And whole thing: ', floatBalanceCurr, ' which should be: ', clientFloatInfo.currency);
    const floatBalanceInfo = floatBalanceCurr[clientFloatInfo.currency];
    logger('Extracted float balance info: ', floatBalanceInfo);
    const floatAmountHunCent = opsUtil.convertToUnit(floatBalanceInfo.amount, floatBalanceInfo.unit, 'HUNDREDTH_CENT');
    
    const lastFloatAccrualTime = await rdsFloat.getLastFloatAccrualTime(clientFloatInfo.floatId, clientFloatInfo.clientId);
    
    // see the balance handler for a more detailed & commented version
    const accrualRateAnnualBps = clientFloatInfo.accrualRateAnnualBps;
    const basisPointDivisor = 100 * 100; // i.e., hundredths of a percent
    const annualAccrualRateNominalGross = new BigNumber(accrualRateAnnualBps).dividedBy(basisPointDivisor);
    // note : assumes the annual rate is simple, not effective
    const dailyAccrualRateNominalNet = annualAccrualRateNominalGross.dividedBy(365);
    
    const calculationTimeMillis = moment().valueOf();
    const millisSinceLastCalc = calculationTimeMillis - lastFloatAccrualTime.valueOf();
    logger(`Last calculation was at ${lastFloatAccrualTime.format()}, which is ${millisSinceLastCalc} msecs ago, and there are ${MILLIS_IN_DAY} msecs in a day`);
    const portionOfDay = new BigNumber(millisSinceLastCalc).dividedBy(new BigNumber(MILLIS_IN_DAY));
    logger(`That works out to ${portionOfDay.toNumber()} as a proportion of a day, since the last calc`);
    const accrualRateToApply = dailyAccrualRateNominalNet.times(portionOfDay);
    logger(`And hence, from an annual ${annualAccrualRateNominalGross.toNumber()}, an amount to apply of ${accrualRateToApply.toNumber()}`);

    const todayAccrualAmount = new BigNumber(floatAmountHunCent).times(accrualRateToApply);
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
        accrualAmount: todayAccrualAmount.decimalPlaces(0).toNumber(),
        currency: clientFloatInfo.currency,
        unit: 'HUNDREDTH_CENT',
        referenceTimeMillis: calculationTimeMillis,
        backingEntityIdentifier: identifierToUse,
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

const extractParamsForEmail = (accrualInvocation, accrualInvocationResult) => {
    const resultPayload = JSON.parse(accrualInvocationResult['Payload']);
    const resultBody = JSON.parse(resultPayload.body);

    const accrualInstruction = JSON.parse(accrualInvocation['Payload']);
    const unit = accrualInstruction.unit;
    const currency = accrualInstruction.currency;
    
    const bonusAmountRaw = resultBody.entityAllocations.bonusShare;
    const companyShareRaw = resultBody.entityAllocations.clientShare;

    const simpleFormat = (amount) => `${currency} ${opsUtil.convertToUnit(amount, unit, 'WHOLE_CURRENCY')}`;

    const numberUserAllocations = resultBody.userAllocationTransactions.allocationRecords.length;
    const bonusAllocation = Reflect.has(resultBody.userAllocationTransactions, 'bonusAllocation') 
        ? 'None' : '(yes : insert excess)';

    return {
        floatAmount: simpleFormat(accrualInstruction.calculationBasis.floatAmountHunCent),
        baseAccrualRate: `${accrualInstruction.calculationBasis.accrualRateAnnualBps} bps`,
        dailyRate: `${accrualInstruction.calculationBasis.accrualRateApplied} %`,
        accrualAmount: simpleFormat(accrualInstruction.accrualAmount),
        bonusAmount: simpleFormat(bonusAmountRaw),
        companyAmount: simpleFormat(companyShareRaw),
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

    // todo: use more robust templatting so can handle indefinite length arrays, for now just do this one
    const accrualEmailDetails = extractParamsForEmail(accrualInvocations[0], accrualInvocationResults[0]);

    const emailResult = await publisher.sendSystemEmail({
        subject: 'Daily float accrual results',
        toList: config.get('email.accrualResult.toList'),
        bodyTemplateKey: config.get('email.accrualResult.templateKey'),
        templateVariables: accrualEmailDetails
    });

    logger('Result of email send: ', emailResult);

    return accrualInvocations.length;
};

const sendSystemStats = async () => {
    const endTime = moment();
    const startOfTime = moment(0);
    const startOfDay = moment().startOf('day');
    const startOfWeek = moment().startOf('week');

    logger(`Finding users with times: end = ${endTime.format()}, start of time: ${startOfTime.format()}, start of day: ${startOfDay.format()}, start of week: ${startOfWeek.format()}`);

    // todo : obviously, want to add a lot into here
    const [userNumbersTotal, userNumbersWeek, userNumbersToday, numberSavedTotal, numberSavedToday, numberSavedWeek] = 
        await Promise.all([
            rdsAccount.countUserIdsWithAccounts(startOfTime, endTime, false),
            rdsAccount.countUserIdsWithAccounts(startOfWeek, endTime, false),
            rdsAccount.countUserIdsWithAccounts(startOfDay, endTime, false),
            rdsAccount.countUserIdsWithAccounts(startOfTime, endTime, true),
            rdsAccount.countUserIdsWithAccounts(startOfWeek, endTime, true),
            rdsAccount.countUserIdsWithAccounts(startOfDay, endTime, true)
        ]);

    const templateVariables = { userNumbersTotal, userNumbersWeek, userNumbersToday, numberSavedTotal, numberSavedToday, numberSavedWeek };

    logger('Sending : ', templateVariables);

    return publisher.sendSystemEmail({ 
        subject: 'Daily system stats',
        toList: config.get('email.systemStats.toList'),
        bodyTemplateKey: config.get('email.systemStats.templateKey'),
        templateVariables
    });
};

/**
 * Runs daily. Does several things:
 * (1) checks for accruals on each float & then triggers the relevant job
 * (2) sends an email to the designated list with key stats for the day
 * (3) cleans up transaction ledger by setting old pending transactions to expired
 */
module.exports.runRegularJobs = async (event) => {
    logger('Scheduled job received event: ', event);

    const [statResult, accrualResult, numberExpired] = await Promise.all([
        sendSystemStats(),
        initiateFloatAccruals(),
        expireHangingTransactions()
    ]);

    logger('Result of stat send: ', statResult);
    logger('Accrual result: ', accrualResult);
    logger('Expire handler: ', numberExpired);

    const responseStats = {
        numberExpired,
        numberAccruals: accrualResult
    };

    return { 
        statusCode: 200,
        body: { responseStats }
    };
};
