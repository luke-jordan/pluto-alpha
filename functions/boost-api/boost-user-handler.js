'use strict';

const logger = require('debug')('jupiter:boosts:handler');
const config = require('config');
const statusCodes = require('statuses');

const boostRedemptionHandler = require('./boost-redemption-handler');
const persistence = require('./persistence/rds.boost');
const publisher = require('publish-common');

const util = require('./boost.util');
const conditionTester = require('./condition-tester');

const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: config.get('aws.region') });

const expireFinishedTournaments = async (boost) => {
    // for now, we only care enough if this is a friend tournament
    const flags = boost.flags || []; // just as even small chance of accidental fragility here would be a really bad trade-off
    if (!util.isBoostTournament(boost) || !flags.includes('FRIEND_TOURNAMENT')) {
        return;
    }

    // the expiry handler will take care of the checks to see if everyone else has played, and if so, will end this
    logger('Telling boost expiry to check ...');
    const expiryInvocation = util.lambdaParameters({}, 'boostExpire', false);
    await lambda.invoke(expiryInvocation).promise();
    logger('Dispatched');
};

const recordGameResult = async (params, boost, accountId) => {
    const gameLogContext = { 
        timeTakenMillis: params.timeTakenMillis 
    };
    
    if (typeof params.numberTaps === 'number') {
        gameLogContext.numberTaps = params.numberTaps;
    }

    if (typeof params.percentDestroyed === 'number') {
        gameLogContext.percentDestroyed = params.percentDestroyed;
    }

    const boostLog = { boostId: boost.boostId, accountId, logType: 'GAME_RESPONSE', logContext: gameLogContext };
    await persistence.insertBoostAccountLogs([boostLog]);
};

const generateUpdateInstruction = ({ boostId, statusResult, accountId, boostAmount }) => {
    logger('Generating update instructions, with status results: ', statusResult);
    const highestStatus = statusResult.sort(util.statusSorter)[0];
    
    const logContext = { newStatus: highestStatus, boostAmount };

    return {
        boostId,
        accountIds: [accountId],
        newStatus: highestStatus,
        logType: 'STATUS_CHANGE',
        logContext
    };
};

const calculateUserQuizScore = async ({ gameParams, userResponses, timeTakenMillis, systemWideUserId }) => {
    const questionSnippetIds = gameParams.questionSnippetIds;
    const questionSnippets = await persistence.fetchQuestionSnippets(questionSnippetIds);
    logger('Got question snippets: ', questionSnippets);

    const correctAnswers = userResponses.filter((userResponse) => {
        const { snippetId, userAnswerText } = userResponse;
        const questionSnippet = questionSnippets.find((snippet) => snippet.snippetId === snippetId);
        return questionSnippet && userAnswerText === questionSnippet.responseOptions.correctAnswerText;
    });

    const numberCorrectAnswers = correctAnswers.length;
    const numberQuestions = questionSnippetIds.length;

    logger(`User quiz score is: ${numberCorrectAnswers}/${numberQuestions}`);

    const logContext = { numberCorrectAnswers, numberQuestions, timeTakenMillis, userResponses, questionSnippets };
    await publisher.publishUserEvent(systemWideUserId, 'QUIZ_ANSWER', { context: logContext });

    return { numberCorrectAnswers, numberQuestions, correctAnswers: questionSnippets.map(({ responseOptions }) => responseOptions.correctAnswerText) };
};

/**
 * @param {object} event The event from API GW. Contains a body with the parameters:
 * @property {number} numberTaps The number of taps (if a boost game)
 * @property {number} percentDestroyed The amount of the image/screen 'destroyed' (for that game)
 * @property {number} timeTaken The amount of time taken to complete the game (in seconds)  
 */
module.exports.processUserBoostResponse = async (event) => {
    try {        
        const userDetails = util.extractUserDetails(event);
        if (!userDetails) {
            return { statusCode: statusCodes('Forbidden') };
        }

        const params = util.extractEventBody(event);
        logger('Event params: ', params);

        const { systemWideUserId } = userDetails;
        const { boostId, eventType } = params;

        // todo : make sure boost is available for this account ID
        const [boost, accountId] = await Promise.all([
            persistence.fetchBoost(boostId), 
            persistence.getAccountIdForUser(systemWideUserId)
        ]);

        logger('Fetched boost: ', boost);
        logger('Relevant account ID: ', accountId);

        const boostAccountJoin = await persistence.fetchCurrentBoostStatus(boostId, accountId);
        logger('And current boost status: ', boostAccountJoin);
        if (!boostAccountJoin) {
            return { statusCode: statusCodes('Bad Request'), body: JSON.stringify({ message: 'User is not offered this boost' }) };
        }

        const { boostStatus: currentStatus } = boostAccountJoin;
        const allowableStatus = ['CREATED', 'OFFERED', 'UNLOCKED']; // as long as not redeemed or pending, status check will do the rest
        if (boost.flags && boost.flags.includes('ALLOW_REPEAT_PLAY')) {
            allowableStatus.push('PENDING');
        }

        if (!allowableStatus.includes(currentStatus)) {
            return { statusCode: statusCodes('Bad Request'), body: JSON.stringify({ message: 'Boost is not open and repeat play not allowed', status: currentStatus }) };
        }

        let resultBody = {};
        if (boost.boostType === 'GAME' && boost.boostCategory === 'QUIZ') {
            const quizParams = { gameParams: boost.gameParams, userResponses: params.userResponses, timeTakenMillis: params.timeTakenMillis, systemWideUserId };
            const resultOfQuiz = await calculateUserQuizScore(quizParams);
            logger('Result of quiz: ', resultOfQuiz);
            const { numberCorrectAnswers, numberQuestions } = resultOfQuiz;
            params.percentDestroyed = Number((numberCorrectAnswers / numberQuestions).toFixed(2)) * 100; // for status checks
            // at the moment we leave in correct answers because we may want to display to user (open to abuse down the line so keep watch)
            resultBody.resultOfQuiz = resultOfQuiz;
        }

        const statusEvent = { eventType, eventContext: params };
        const statusResult = conditionTester.extractStatusChangesMet(statusEvent, boost);

        if (boost.boostType === 'GAME' && eventType === 'USER_GAME_COMPLETION') {
            await recordGameResult(params, boost, accountId);
        }
        
        if (statusResult.length === 0) {
            // only a malformed tournament would have no status change when user plays, but just in case
            const returnResult = util.isBoostTournament(boost) ? { result: 'TOURNAMENT_ENTERED', endTime: boost.boostEndTime.valueOf() } : { result: 'NO_CHANGE' };
            return { statusCode: 200, body: JSON.stringify({ ...returnResult, ...resultBody })};
        }

        resultBody = { result: 'TRIGGERED', statusMet: statusResult, endTime: boost.boostEndTime.valueOf(), ...resultBody };

        let resultOfTransfer = {};
        let boostAmount = boost.boostAmount;

        if (statusResult.includes('REDEEMED')) {
            // do this first, as if it fails, we do not want to proceed
            const accountDict = { [boostId]: { [accountId]: { userId: systemWideUserId, newStatus: 'REDEEMED' } }};
            const redemptionCall = { redemptionBoosts: [boost], affectedAccountsDict: accountDict, event: { accountId, eventType }};
            resultOfTransfer = await boostRedemptionHandler.redeemOrRevokeBoosts(redemptionCall);
            logger('Boost process-redemption, result of transfer: ', resultOfTransfer);
            boostAmount = resultOfTransfer[boostId].boostAmount;
        }

        if (resultOfTransfer[boostId] && resultOfTransfer[boostId].result !== 'SUCCESS') {
            throw Error('Error transferring redemption');
        }

        const updateInstruction = generateUpdateInstruction({ boostId, statusResult, accountId, boostAmount });
        logger('Sending this update instruction to persistence: ', updateInstruction);
        
        const adjustedLogContext = { ...updateInstruction.logContext, processType: 'USER', submittedParams: params };
        updateInstruction.logContext = adjustedLogContext;
        
        const resultOfUpdates = await persistence.updateBoostAccountStatus([updateInstruction]);
        logger('Result of update operation: ', resultOfUpdates);
   
        if (statusResult.includes('REDEEMED')) {
            resultBody.amountAllocated = { amount: boostAmount, unit: boost.boostUnit, currency: boost.boostCurrency };
            await persistence.updateBoostAmountRedeemed([boostId]);
        }

        if (statusResult.includes('PENDING')) {
            await expireFinishedTournaments(boost);
        }

        return {
            statusCode: 200,
            body: JSON.stringify(resultBody)
        };
        
    } catch (err) {
        logger('FATAL_ERROR: ', err);
        return { statusCode: statusCodes('Internal Server Error'), body: JSON.stringify(err.message) };
    }
};
