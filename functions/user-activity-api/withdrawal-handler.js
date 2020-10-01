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

const DEFAULT_UNIT = 'HUNDREDTH_CENT';
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

// todo : use cache (note prefix though)
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

// ///////////////////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////////////////// BANK DETAILS & VERIFICATION HANDLING //////////////////////////////////
// /////////////////////////////////////////////////////////////////////////////////////////////////////////

const initializeBankVerification = async (bankDetails, userProfile) => {
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
        return 'MANUAL_JOB'; // event will be published below
    }

    return resultPayload.jobId;
};

const cacheBankDetailsUsingPriorVerification = async (bankDetails, systemWideUserId, priorVerificationResult) => {
    const { verificationStatus, verificationLog, creationMoment } = priorVerificationResult;
    const verificationTime = creationMoment.format('DD MMMM, YYYY');
    const detailsToCache = { ...bankDetails, verificationStatus, verificationLog, verificationTime };
    await redis.set(systemWideUserId, JSON.stringify(detailsToCache), 'EX', config.get('cache.ttls.withdrawal'));
    return detailsToCache;
};

const cacheBankDetailWithJobId = async (bankDetails, userProfile) => {
    const verificationJobId = await initializeBankVerification(bankDetails, userProfile);
    const detailsToCache = { ...bankDetails, verificationStatus: 'PENDING', verificationJobId };    
    await redis.set(userProfile.systemWideUserId, JSON.stringify(detailsToCache), 'EX', config.get('cache.ttls.withdrawal'));
    return detailsToCache;
};

// note: for a lot of compliance reasons, we are not persisting the bank account, so we rather cache it
const initiateBankVerificationAndCache = async (bankDetails, userProfile) => {
    const { systemWideUserId } = userProfile;
    const alreadyVerified = await dynamodb.fetchBankVerificationResult(systemWideUserId, bankDetails);
    logger('Result of prior bank verification check: ', alreadyVerified);
    return alreadyVerified 
        ? cacheBankDetailsUsingPriorVerification(bankDetails, systemWideUserId, alreadyVerified) 
        : cacheBankDetailWithJobId(bankDetails, userProfile);  
};

// CHECK, IF NECESSARY, IF THE JOB ID EXISTS (AFTER FIRST DOING ONE MORE CHECK ON TABLE)
const checkBankVerification = async (verificationJobId) => {
    const parameters = { jobId: verificationJobId };
    const lambdaInvocation = {
        FunctionName: config.get('lambdas.userBankVerify'),
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ operation: 'statusCheck', parameters })
    };

    const resultOfLambda = await lambda.invoke(lambdaInvocation).promise();
    logger('Raw result from verification lambda: ', resultOfLambda);

    if (resultOfLambda['StatusCode'] !== 200) {
        // the 3rd party API is not always consistent or great in its error reporting, which can cause
        // fails when something is just still processing, even though interface has error handling; hence
        // instead of throwing or causing a general fail here, instead just return 'ERROR' and let it be marked pending
        return { result: 'ERROR' };
    }

    const resultPayload = JSON.parse(resultOfLambda['Payload']);
    if (!Reflect.has(resultPayload, 'result')) {
        // as above
        return { result: 'ERROR' };
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

    const promisesToExecute = [];
    if (verificationStatus === 'VERIFIED' || verificationStatus === 'FAILED') {
        // in these two cases we stash the result against a one-way hash of the account details so we do not repeat
        // _note_ we could also move this to event handler and do it there, _but_ bank verifications are expensive, and this is a few
        // millis longer, on a process where we do not mind a little extra friction, hence doing it here
        const stashVerificationArgs = { systemWideUserId, bankDetails: cachedDetails, verificationStatus, verificationLog: failureReason };
        cachedDetails.verificationTime = moment().format('DD MMMM, YYYY');
        promisesToExecute.push(dynamodb.setBankVerificationResult(stashVerificationArgs));
    }

    promisesToExecute.push(redis.set(systemWideUserId, JSON.stringify(cachedDetails), 'EX', config.get('cache.detailsTTL')));
    await Promise.all(promisesToExecute);
};

// bank verifier does not work for all banks, and sometimes is offline, so we just initiate a check -
const checkAndLogBankVerification = async (systemWideUserId) => {
    const cachedDetails = await redis.get(systemWideUserId);
    const bankDetails = JSON.parse(cachedDetails);

    // remove when not in present context (i.e., need to lock down admin route again)
    if (!bankDetails) {
        logger('Nothing to do, likely admin call');
        const logContext = { cause: 'No bank details, must be admin manual process' };
        await publisher.publishUserEvent(systemWideUserId, 'BANK_VERIFICATION_MANUAL', { context: logContext });
        return;
    }
    
    if (Reflect.has(bankDetails, 'verificationStatus') && bankDetails.verificationStatus !== 'PENDING') {
        logger('Already done a check, no need to repeat, return');
        return;
    }

    const existingVerification = await dynamodb.fetchBankVerificationResult(systemWideUserId, bankDetails);
    if (existingVerification) {
        logger('Have prior verification, utilizing and returning: ', existingVerification);
        await cacheBankDetailsUsingPriorVerification(bankDetails, systemWideUserId, existingVerification);
        return;
    }

    // if it comes back verified, we cache it and log it, if not, we tell admin they need to manually verify
    const { verificationJobId } = bankDetails;
    if (!verificationJobId) {
        logger('No bank verification job!');
        const logContext = { cause: 'No bank verification job ID' };
        await Promise.all([
            updateBankAccountVerificationStatus(systemWideUserId, 'MANUAL'),
            publisher.publishUserEvent(systemWideUserId, 'BANK_VERIFICATION_MANUAL', { context: logContext })
        ]);
        return;
    }

    // if it's an unsupported bank or the verification system is off, or other reasons, do this
    if (verificationJobId === 'MANUAL_JOB') {
        const contextToLog = { cause: 'Unsupported bank, or otherwise requiring manual verification' };
        await Promise.all([
            updateBankAccountVerificationStatus(systemWideUserId, 'MANUAL'),
            publisher.publishUserEvent(systemWideUserId, 'BANK_VERIFICATION_MANUAL', { context: contextToLog })
        ]);
        return;
    }

    const bankVerificationStatus = await checkBankVerification(verificationJobId);
    logger('Result of verification call: ', bankVerificationStatus);

    // this is distinguished from ERROR; it means the call succeded and the result was 'this is not the person's account'
    if (bankVerificationStatus.result === 'FAILED') {
        const contextToLog = { resultFromVerifier: bankVerificationStatus };
        await Promise.all([
            updateBankAccountVerificationStatus(systemWideUserId, 'FAILED', bankVerificationStatus.cause),
            publisher.publishUserEvent(systemWideUserId, 'BANK_VERIFICATION_FAILED', { context: contextToLog })
        ]);
        return;
    }

    if (bankVerificationStatus.result === 'VERIFIED') {
        const contextToLog = { resultFromVerifier: bankVerificationStatus };
        await Promise.all([
            updateBankAccountVerificationStatus(systemWideUserId, 'VERIFIED'),
            publisher.publishUserEvent(systemWideUserId, 'BANK_VERIFICATION_SUCCEEDED', { context: contextToLog })
        ]);
        return;
    }

    // in this case, we leave the status pending as subsequent checks may succeed, but issue manual check needed alert
    if (bankVerificationStatus.result === 'ERROR') {
        const contextToLog = { cause: 'Error on third party bank verification service' };
        await Promise.all([
            updateBankAccountVerificationStatus(systemWideUserId, 'PENDING'),
            publisher.publishUserEvent(systemWideUserId, 'BANK_VERIFICATION_MANUAL', { context: contextToLog })
        ]);
        return;
    }

    logger('Bank verification still pending, come back later, but cached for now');
    await updateBankAccountVerificationStatus(systemWideUserId, 'PENDING');
};


// ///////////////////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////////////////// INTEREST PROJECTIONS ETC CHECKING /////////////////////////////////////
// /////////////////////////////////////////////////////////////////////////////////////////////////////////

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
    // not using prudential here
    const floatDeductions = new DecimalLight(floatProjectionVars.bonusPoolShareOfAccrual).plus(floatProjectionVars.clientShareOfAccrual);

    const annualInterestRateAsDecimalLight = annualAccrualRateNominalGross.times(new DecimalLight(1).minus(floatDeductions));
    logger(`Annual Interest rate as big number: ${annualInterestRateAsDecimalLight}`);
    return annualInterestRateAsDecimalLight;
};

const obtainWithdrawalCardMsg = (clientFloatVars) => {
    const annualInterestRate = calculateAnnualInterestRate(clientFloatVars);
    const valueForText = Math.floor((annualInterestRate.times(100)).toNumber());
    return `Every R100 kept in your Jupiter account earns you at least R${valueForText} after a year - hard at work earning for you! If possible, delay or reduce your withdrawal and keep your money earning for you`;
};

const calculateAvailableBalance = async (accountId, currency) => {
    const [settledSum, pendingTx] = await Promise.all([
        persistence.sumAccountBalance(accountId, currency),
        persistence.fetchPendingTransactions(accountId)
    ]);

    logger('Calculating available balance for withdrawal, have pending: ', pendingTx);
    const pendingWithdrawalsSum = pendingTx.filter((row) => row.transactionType === 'WITHDRAWAL' && row.currency === currency).
        reduce((sum, row) => sum + opsUtil.convertToUnit(row.amount, row.unit, settledSum.unit), 0);

    logger('Resulting amount to deduct: ', pendingWithdrawalsSum);
    // withdrawals have a negative sign, so need to add
    return { ...settledSum, amount: settledSum.amount + pendingWithdrawalsSum };
};

// ///////////////////////////////////////////////////////////////////////////////////////////////////////////
// ////////////////////////////////// AND NOW THE MAIN HANDLERS /////////////////////////////////////////////
// /////////////////////////////////////////////////////////////////////////////////////////////////////////

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
        const authParams = opsUtil.extractUserDetails(event);
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }
        
        const withdrawalInformation = JSON.parse(event.body);
        const { accountId, bankDetails } = withdrawalInformation;
        
        // see note below about interaction of this and admin/self check above
        const systemWideUserId = withdrawalInformation.systemWideUserId || authParams.systemWideUserId;
        await publisher.publishUserEvent(systemWideUserId, 'WITHDRAWAL_EVENT_INITIATED');

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
        const [availableBalance, messageBody, bankCacheResult] = await Promise.all([
            calculateAvailableBalance(accountId, currency),
            obtainWithdrawalCardMsg(floatVars),
            initiateBankVerificationAndCache(bankDetails, userProfile)
        ]);

        logger('Result of bank verification check/initiation and cache: ', bankCacheResult);
        
        const responseObject = {
            availableBalance,
            cardTitle: 'Are you sure?',
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
        const authParams = opsUtil.extractUserDetails(event);
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }

        const withdrawalInformation = opsUtil.extractParamsFromEvent(event);
        const systemWideUserId = withdrawalInformation.systemWideUserId || authParams.systemWideUserId;
        
        logger('Setting withdrawal amount for user: ', systemWideUserId, ' with params: ', withdrawalInformation);
        
        if (!withdrawalInformation.amount || !withdrawalInformation.unit || !withdrawalInformation.currency) {
            logger('Withdrawal amount failed validation, responding with failure');
            return invalidRequestResponse('Error, must send amount to withdraw, along with unit and currency');
        }

        // then, check if amount is above balance
        const accountId = withdrawalInformation.accountId;
        const availableBalance = await calculateAvailableBalance(accountId, withdrawalInformation.currency);

        if (!checkSufficientBalance(withdrawalInformation, availableBalance)) {
            return invalidRequestResponse('Error, trying to withdraw more than available');
        }
        
        // make sure the amount is negative (as that makes the sums etc work), and round for occasional floating point errors in here
       const convertedAmount = opsUtil.convertToUnit(withdrawalInformation.amount, withdrawalInformation.unit, DEFAULT_UNIT);
       
        withdrawalInformation.amount = -Math.round(Math.abs(convertedAmount));
        withdrawalInformation.unit = DEFAULT_UNIT;

        withdrawalInformation.transactionType = 'WITHDRAWAL';
        withdrawalInformation.settlementStatus = 'INITIATED';
        withdrawalInformation.initiationTime = moment();

        // get client float for interest projections, and bank ref info, to assist in generating a tracker 
        const [clientFloatInfo, bankRefInfo] = await Promise.all([
            obtainClientFloatId(withdrawalInformation), 
            persistence.fetchInfoForBankRef(accountId),
            checkAndLogBankVerification(systemWideUserId)
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
        return { statusCode: 200, body: JSON.stringify(resultObject) };
    } catch (err) {
        return handleError(err);
    }
};

const abortTransactionIncludingLogging = async ({ transactionId, systemWideUserId }) => {
    // in time, process the do-not-withdraw boost, and tell the user, then update the transaction
    const { accountId, settlementStatus } = await persistence.fetchTransaction(transactionId);
    const logContext = { oldStatus: settlementStatus, newStatus: 'CANCELLED' };
    const txLog = { accountId, systemWideUserId, logContext };
    const userLog = { transactionId, ...logContext };
    // we use "ABORTED" here so boosts and other event processing can handle this differently
    await Promise.all([
        persistence.updateTxSettlementStatus({ transactionId, settlementStatus: 'CANCELLED', logToInsert: txLog }),
        publisher.publishUserEvent(systemWideUserId, 'WITHDRAWAL_EVENT_ABORTED', { context: userLog })
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
        const authParams = opsUtil.extractUserDetails(event);
        if (!opsUtil.isDirectInvokeAdminOrSelf(event)) {
          return { statusCode: status('Forbidden'), message: 'User ID not found in context' };
        }

        const withdrawalInformation = JSON.parse(event.body);

        // if user is not admin and system wider user ID is present and not equal to user, check above will throw the error
        const systemWideUserId = withdrawalInformation.systemWideUserId || authParams.systemWideUserId;

        if (!withdrawalInformation.transactionId) {
            return invalidRequestResponse('Requires a transaction Id');
        } else if (!withdrawalInformation.userDecision || ['CANCEL', 'WITHDRAW'].indexOf(withdrawalInformation.userDecision) < 0) {
            return invalidRequestResponse('Requires a valid user decision');
        }

        const transactionId = withdrawalInformation.transactionId;
        if (withdrawalInformation.userDecision === 'CANCEL') {
            await abortTransactionIncludingLogging({ transactionId, systemWideUserId });
            return { statusCode: 200 };
        }
        
        // in case it was pending before -- only do it after cancel else pointless
        await checkAndLogBankVerification(systemWideUserId);

        // user wants to go through with it, so (1) send an email about it, (2) update the transaction to pending, (3) update 3rd-party
        const resultOfUpdate = await persistence.updateTxSettlementStatus({ transactionId, settlementStatus: 'PENDING' });
        logger('Result of update: ', resultOfUpdate);

        // then, return the balance
        if (!resultOfUpdate) {
            throw new Error('Transaction update returned empty rows');
        }

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

        const response = { balance: newBalance };
        
        return { statusCode: 200, body: JSON.stringify(response) };
    } catch (err) {
        return handleError(err);
    }
};
