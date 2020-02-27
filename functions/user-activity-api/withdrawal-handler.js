'use strict';

const logger = require('debug')('jupiter:withdraw:main');
const config = require('config');
const moment = require('moment');

const opsUtil = require('ops-util-common');
const paymentUtil = require('./payment-link');

const status = require('statuses');
const publisher = require('publish-common');
const persistence = require('./persistence/rds');
const dynamodb = require('./persistence/dynamodb');

const DecimalLight = require('decimal.js-light');
const FIVE_YEARS = 5;

const Redis = require('ioredis');
const redis = new Redis({ 
    port: config.get('cache.port'), 
    host: config.get('cache.host'), 
    keyPrefix: `${config.get('cache.keyPrefixes.withdrawal')}::`
});

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const invalidRequestResponse = (messageForBody) => ({ statusCode: 400, body: messageForBody });

const handleError = (err) => { 
    logger('FATAL_ERROR: ', err);
    return { statusCode: 500, body: JSON.stringify(err.message) };
};

const collapseAmount = (amountDict) => `${amountDict.amount}::${amountDict.unit}::${amountDict.currency}`;

const fetchUserProfile = async (systemWideUserId) => {
    const profileFetchLambdaInvoke = {
        FunctionName: config.get('lambdas.fetchProfile'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ systemWideUserId })
    };
    const profileFetchResult = await lambda.invoke(profileFetchLambdaInvoke).promise();
    logger('Result of profile fetch: ', profileFetchResult);

    return JSON.parse(JSON.parse(profileFetchResult['Payload']).body);
};

// note: for a lot of compliance reasons, we are not persisting the bank account, so rather cache it
const cacheBankAccountDetails = async (systemWideUserId, bankAccountDetails, verificationJobId) => {
    const accountTimeOut = config.get('cache.ttls.withdrawal');
    logger('Logging, passed job ID: ', verificationJobId);
    await redis.set(systemWideUserId, JSON.stringify({ ...bankAccountDetails, verificationJobId }), 'EX', accountTimeOut);
    logger('Done! Can move along');
};

const getBankVerificationJobId = async (bankDetails, userProfile) => {
    const initials = userProfile.personalName.split(' ').map((name) => name[0]).join('');
    const parameters = {
        bankName: bankDetails.bankName,
        accountNumber: bankDetails.accountNumber,
        accountType: bankDetails.accountType,
        reference: userProfile.systemWideUserId,
        initials,
        surname: userProfile.familyName,
        nationalId: userProfile.nationalId
    };

    const lambdaInvocation = {
        FunctionName: config.get('lambdas.userBankVerify'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ operation: 'initialize', parameters })
    };

    logger('Invoking bank verification initialize, with invocation: ', lambdaInvocation);
    const resultOfLambda = await lambda.invoke(lambdaInvocation).promise();
    logger('Received response from bank verification lambda: ', resultOfLambda);
    if (resultOfLambda['StatusCode'] !== 200) {
        throw new Error(resultOfLambda['Payload']);
    }

    const resultPayload = JSON.parse(resultOfLambda['Payload']);
    if (resultPayload.status !== 'SUCCESS') {
        throw new Error(JSON.stringify(resultPayload));
    }

    return resultPayload.jobId;
};

const checkBankVerification = async (systemWideUserId) => {
    const bankDetailsRaw = await redis.get(systemWideUserId);
    logger('Bank details from Redis: ', bankDetailsRaw);
    const bankDetails = JSON.parse(bankDetailsRaw);
    
    if (Reflect.has(bankDetails, 'verificationStatus')) {
        const alreadyCached = true;
        return bankDetails.verificationStatus ? { result: 'VERIFIED', alreadyCached } 
            : { result: 'FAILED', cause: bankDetails.failureReason, alreadyCached };
    }
    
    if (!bankDetails.verificationJobId) {
        throw new Error('No job ID for bank verification');
    }

    const parameters = { jobId: bankDetails.verificationJobId };
    const lambdaInvocation = {
        FunctionName: config.get('lambdas.userBankVerify'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ operation: 'statusCheck', parameters })
    };

    const resultOfLambda = await lambda.invoke(lambdaInvocation).promise();
    if (resultOfLambda['StatusCode'] !== 200) {
        throw new Error(resultOfLambda['Payload']);
    }

    const resultPayload = JSON.parse(resultOfLambda['Payload']);
    if (!Reflect.has(resultPayload, 'result')) {
        throw new Error(JSON.stringify(resultPayload));
    }

    return resultPayload;
};

const updateBankAccountVerificationStatus = async (systemWideUserId, verificationStatus, failureReason) => {
    const cachedDetailsRaw = await redis.get(systemWideUserId);
    const cachedDetails = JSON.parse(cachedDetailsRaw);
    cachedDetails.verificationStatus = verificationStatus;
    if (failureReason) {
        cachedDetails.failureReason = failureReason;
    }
    await redis.set(systemWideUserId, JSON.stringify({ cachedDetails }), 'EX', config.get('cache.detailsTTL'));
};

const obtainClientFloatId = async (withdrawalInformation) => {
    if (withdrawalInformation.floatId && withdrawalInformation.clientId) {
        return { clientId: withdrawalInformation.clientId, floatId: withdrawalInformation.floatId };
    }
    
    const floatAndClient = await persistence.getOwnerInfoForAccount(withdrawalInformation.accountId);
    const floatId = withdrawalInformation.floatId || floatAndClient.floatId;
    const clientId = withdrawalInformation.clientId || floatAndClient.clientId;
    return { clientId, floatId };
};

const fetchClientFloatVars = async (withdrawalInformation) => {
    const { clientId, floatId } = await obtainClientFloatId(withdrawalInformation);
    return dynamodb.fetchFloatVarsForBalanceCalc(clientId, floatId);
};

const calculateAnnualInterestRate = (floatProjectionVars) => {
    const basisPointDivisor = 100 * 100; // i.e., hundredths of a percent
    const annualAccrualRateNominalGross = new DecimalLight(floatProjectionVars.accrualRateAnnualBps).dividedBy(basisPointDivisor);
    const floatDeductions = new DecimalLight(floatProjectionVars.bonusPoolShareOfAccrual).plus(floatProjectionVars.clientShareOfAccrual).
    plus(floatProjectionVars.prudentialFactor);

    const annualInterestRateAsDecimalLight = annualAccrualRateNominalGross.times(new DecimalLight(1).minus(floatDeductions));
    logger(`Annual Interest rate as big number: ${annualInterestRateAsDecimalLight}`);
    return annualInterestRateAsDecimalLight;
};

const obtainWithdrawalCardMsg = (clientFloatVars) => {
    const annualInterestRate = calculateAnnualInterestRate(clientFloatVars);
    const twoYearRate = (annualInterestRate.plus(1).pow(2)).minus(1);
    
    const valueForText = (twoYearRate.times(100)).toInteger().toNumber();
    return `Over the next two years you could accumulate ${valueForText}% interest. Why not delay your withdrawal to keep these ` + 
        `savings and earn more for your future!`;
};

/**
 * Initiates a withdrawal by setting the bank account for it, which gets verified, and then we go from there
 * @param {object} event An evemt object containing the request context and request body. The request context contains
 * details such as the callers system wide user id along with the callers roles and permissions. The request body contains the transaction
 * information to be processed. Details on the request body's properties are provided below.
 * @property {string} accountId The account from which to withdraw.
 * @property {object} bankDetails An object containing bank details to be cached.
 */
module.exports.setWithdrawalBankAccount = async (event) => {
    try {
        logger('Initiating withdrawal ...');
        const authParams = event.requestContext ? event.requestContext.authorizer : null;
        if (!authParams || !authParams.systemWideUserId) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }
        
        await publisher.publishUserEvent(authParams.systemWideUserId, 'WITHDRAWAL_EVENT_INITIATED');
        const withdrawalInformation = JSON.parse(event.body);
        const { accountId, bankDetails } = withdrawalInformation;
        const { systemWideUserId } = authParams;

        // dispatch a series of events: cache the bank account, send off bank account for verification, etc.
        const [userProfile, priorUserSaves, currency, floatVars] = await Promise.all([
            fetchUserProfile(systemWideUserId),
            persistence.countSettledSaves(accountId),
            persistence.findMostCommonCurrency(accountId),
            fetchClientFloatVars(withdrawalInformation)
        ]);

        // then, make sure the user has saved in the past, and get their most common currency
        if (priorUserSaves === 0) {            
            return invalidRequestResponse({ result: 'USER_HAS_NOT_SAVED' });
        }

        // then, get the balance available, and check if the bank verification has completed, in time also the boost etc.
        logger('Most common currency: ', currency);
        const [bankVerifyJobId, availableBalance, messageBody] = await Promise.all([
            getBankVerificationJobId(bankDetails, userProfile),
            persistence.sumAccountBalance(accountId, currency),
            obtainWithdrawalCardMsg(floatVars)
        ]);

        await cacheBankAccountDetails(systemWideUserId, bankDetails, bankVerifyJobId);
        
        // todo : actually calculate projection
        const responseObject = {
            availableBalance,
            cardTitle: 'Did you know?',
            cardBody: messageBody
        };

        return { statusCode: 200, body: JSON.stringify(responseObject) };
    } catch (err) {
        return handleError(err);
    }
};

// note: _should_ come from client as positive, but just to make sure
const checkSufficientBalance = (withdrawalInformation, balanceInformation) => {
    const withdrawalInBalanceUnit = opsUtil.convertToUnit(withdrawalInformation.amount, withdrawalInformation.unit, balanceInformation.unit);
    const absValueWithdrawal = Math.abs(withdrawalInBalanceUnit); 
    return absValueWithdrawal <= balanceInformation.amount;
};

const calculateCompoundInterest = async (amount, annualInterestRateAsDecimalLight, numberOfYears) => {
    logger(`Calculate potential compound interest for amount: ${amount} at annual interest rate: ${annualInterestRateAsDecimalLight} for years: ${numberOfYears}`);
    const amountAsDecimalLight = new DecimalLight(amount);
    const baseCompoundRatePerYear = new DecimalLight(1).plus(annualInterestRateAsDecimalLight);
    const baseCompoundRateAfterGivenYears = baseCompoundRatePerYear.pow(numberOfYears);

    const potentialCompoundInterest = amountAsDecimalLight.times(baseCompoundRateAfterGivenYears).minus(amountAsDecimalLight);
    logger(`Successfully calculated Potential Compound Interest: ${potentialCompoundInterest}`);
    return potentialCompoundInterest.toInteger().toNumber();
};

const constructParametersForPotentialInterest = async (withdrawalInformation, calculationUnit = 'HUNDREDTH_CENT') => {
    const floatProjectionVars = await dynamodb.fetchFloatVarsForBalanceCalc(withdrawalInformation.clientId, withdrawalInformation.floatId);
    const annualInterestRate = await calculateAnnualInterestRate(floatProjectionVars);
    const withdrawalAmount = Math.abs(opsUtil.convertToUnit(withdrawalInformation.amount, withdrawalInformation.unit, calculationUnit));
    return { withdrawalAmount, annualInterestRate };
};

/**
 * Proceeds to next item, the withdrawal amount, where we create the pending transaction, and decide whether to make an offer
 * @param {object} event An event object containing the request context and request body.
 * @property {string} unit The unit in which to carry out calculations.
 * @property {string} currency The transactions currency.
 * @property {string} accountId The accounts unique identifier.
 */
module.exports.setWithdrawalAmount = async (event) => {
    try {
        const authParams = event.requestContext ? event.requestContext.authorizer : null;
        if (!authParams || !authParams.systemWideUserId) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }

        // do a check first, before proceeding onwards
        const { systemWideUserId } = authParams;
        logger('Setting withdrawal amount for user: ', systemWideUserId);

        const bankVerificationStatus = await checkBankVerification(systemWideUserId);
        if (bankVerificationStatus.result === 'FAILED') {
            await updateBankAccountVerificationStatus(systemWideUserId, false, bankVerificationStatus.cause);
            return invalidRequestResponse({ result: 'BANK_ACCOUNT_INVALID' });
        }

        if (bankVerificationStatus.result === 'VERIFIED') {
            await updateBankAccountVerificationStatus(systemWideUserId, true);
        }

        const withdrawalInformation = JSON.parse(event.body);
        
        if (!withdrawalInformation.amount || !withdrawalInformation.unit || !withdrawalInformation.currency) {
            logger('Withdrawal amount failed validation, responding with failure');
            return invalidRequestResponse('Error, must send amount to withdraw, along with unit and currency');
        }

        // then, check if amount is above balance
        const accountId = withdrawalInformation.accountId;
        const availableBalance = await persistence.sumAccountBalance(accountId, withdrawalInformation.currency);

        if (!checkSufficientBalance(withdrawalInformation, availableBalance)) {
            return invalidRequestResponse('Error, trying to withdraw more than available');
        }
        
        // make sure the amount is negative (as that makes the sums etc work)
        withdrawalInformation.amount = -Math.abs(withdrawalInformation.amount);
        withdrawalInformation.transactionType = 'WITHDRAWAL';
        withdrawalInformation.settlementStatus = 'INITIATED';
        withdrawalInformation.initiationTime = moment();

        // get client float for interest projections, and bank ref info, to assist in generating a tracker 
        const [clientFloatInfo, bankRefInfo] = await Promise.all([
            obtainClientFloatId(withdrawalInformation), 
            persistence.fetchInfoForBankRef(accountId)
        ]);

        const { clientId, floatId } = clientFloatInfo;
        const { humanRef: bankRefStem, count: priorSaveCount } = bankRefInfo;

        const humanRef = paymentUtil.generateBankRef({ bankRefStem, priorSaveCount });

        const withdrawWithInfo = { ...withdrawalInformation, clientId, floatId, humanRef };

        // (1) create the pending transaction, and (2) decide if a boost should be offered
        const { transactionDetails } = await persistence.addTransactionToAccount(withdrawWithInfo);
        logger('Transaction details from persistence: ', transactionDetails);
        const transactionId = transactionDetails[0]['accountTransactionId'];

        // for now, we are just stubbing this :: and in fact now removing it
        // const delayTime = moment().add(1, 'week');
        // const delayOffer = { boostAmount: '30000::HUNDREDTH_CENT::ZAR', requiredDelay: delayTime };

        // work out how much the user would earn over next five years
        const { withdrawalAmount, annualInterestRate } = await constructParametersForPotentialInterest(withdrawWithInfo, 'HUNDREDTH_CENT');
        const potentialInterestAmount = await calculateCompoundInterest(withdrawalAmount, annualInterestRate, FIVE_YEARS);
        const potentialInterest = { amount: potentialInterestAmount, unit: 'HUNDREDTH_CENT', currency: withdrawalInformation.currency };

        const resultObject = { transactionId, potentialInterest };
        logger('Result object on withdrawal amount, to send back: ', resultObject);

        // then, assemble and send back
        return {
            statusCode: 200, body: JSON.stringify(resultObject)
        };
    } catch (err) {
        return handleError(err);
    }
};

const cancelTransactionIncludingLogging = async ({ transactionId, systemWideUserId }) => {
    // in time, process the do-not-withdraw boost, and tell the user, then update the transaction
    const { accountId, settlementStatus } = await persistence.fetchTransaction(transactionId);
    const logContext = { oldStatus: settlementStatus, newStatus: 'CANCELLED' };
    const txLog = { accountId, systemWideUserId, logContext };
    const userLog = { transactionId, ...logContext };
    await Promise.all([
        persistence.updateTxSettlementStatus({ transactionId, settlementStatus: 'CANCELLED', logToInsert: txLog }),
        publisher.publishUserEvent(systemWideUserId, 'WITHDRAWAL_EVENT_CANCELLED', { context: userLog })
    ]);
};

/**
 * This function confirms a withdrawal. However, it makes it only "pending", until admin confirms the transfer is done.
 * @param {object} event An event object containing the request context and request body. Body properties are described below.
 * @property {string} transactionId The transactions unique identifier.
 * @property {string} userDecision The users decision. Valid values are CANCEL AND WITHDRAW.
 */
module.exports.confirmWithdrawal = async (event) => {
    try {
        const authParams = event.requestContext ? event.requestContext.authorizer : null;
        if (!authParams || !authParams.systemWideUserId) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }

        const { systemWideUserId } = authParams;

        const withdrawalInformation = JSON.parse(event.body);
        if (!withdrawalInformation.transactionId) {
            return invalidRequestResponse('Requires a transaction Id');
        } else if (!withdrawalInformation.userDecision || ['CANCEL', 'WITHDRAW'].indexOf(withdrawalInformation.userDecision) < 0) {
            return invalidRequestResponse('Requires a valid user decision');
        }

        const transactionId = withdrawalInformation.transactionId;
        if (withdrawalInformation.userDecision === 'CANCEL') {
            await cancelTransactionIncludingLogging({ transactionId, systemWideUserId });
            return { statusCode: 200 };
        }
        
        // in case it was pending before -- only do it after cancel else pointless
        const bankVerificationStatus = await checkBankVerification(systemWideUserId);
        if (bankVerificationStatus.result === 'FAILED') {
            if (!bankVerificationStatus.alreadyCached) {
                await updateBankAccountVerificationStatus(systemWideUserId, false, bankVerificationStatus.cause);
            }
            return invalidRequestResponse({ result: 'BANK_ACCOUNT_INVALID' });
        }

        if (bankVerificationStatus.result === 'VERIFIED' && !bankVerificationStatus.alreadyCached) {
            await updateBankAccountVerificationStatus(systemWideUserId, true);
        }

        // user wants to go through with it, so (1) send an email about it, (2) update the transaction to pending, (3) update 3rd-party
        const resultOfUpdate = await persistence.updateTxSettlementStatus({ transactionId, settlementStatus: 'PENDING' });
        logger('Result of update: ', resultOfUpdate);

        // then, return the balance
        if (!resultOfUpdate) {
            throw new Error('Transaction update returned empty rows');
        }

        const response = { balance: resultOfUpdate.newBalance };
        
        // last, publish this (i.e., so instruction goes out)
        const txProperties = await persistence.fetchTransaction(transactionId);
        logger('Withdrawal TX properties: ', txProperties);
        const newBalance = await persistence.sumAccountBalance(txProperties.accountId, txProperties.currency);
        logger('New account balance: ', newBalance);
        
        const context = {
            transactionId,
            accountId: txProperties.accountId,
            timeInMillis: txProperties.settlementTime,
            withdrawalAmount: collapseAmount(txProperties),
            newBalance: collapseAmount(newBalance)
        };
        
        await publisher.publishUserEvent(systemWideUserId, 'WITHDRAWAL_EVENT_CONFIRMED', { context });

        return { statusCode: 200, body: JSON.stringify(response) };
    } catch (err) {
        return handleError(err);
    }
};
