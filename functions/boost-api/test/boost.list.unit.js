'use strict';

const logger = require('debug')('jupiter:boosts:list:test');
const uuid = require('uuid/v4');
const moment = require('moment');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./boost.test.helper');

const fetchMultiBoostsStub = sinon.stub();
const findAccountsStub = sinon.stub();
const fetchBoostLogsStub = sinon.stub();
const sumAmountsStub = sinon.stub();

const fetchBoostDetailsStub = sinon.stub();
const fetchTournScoresStub = sinon.stub();
const fetchSnippetsStub = sinon.stub();

const cacheGetStub = sinon.stub();
const cacheMultiGetStub = sinon.stub();
const cacheSetStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();
const handler = proxyquire('../boost-list-handler', {
    './persistence/rds.boost.list': {
        'fetchUserBoosts': fetchMultiBoostsStub,
        'findAccountsForUser': findAccountsStub,
        'fetchUserBoostLogs': fetchBoostLogsStub,
        'sumBoostAndSavedAmounts': sumAmountsStub,
        'fetchBoostDetails': fetchBoostDetailsStub,
        'fetchBoostScoreLogs': fetchTournScoresStub,
        'fetchQuestionSnippets': fetchSnippetsStub,
        '@noCallThru': true
    },
    'ioredis': class {
        constructor () {
            this.get = cacheGetStub;
            this.mget = cacheMultiGetStub;
            this.set = cacheSetStub;
        }
    },
    '@noCallThru': true
});

const wrapEvent = helper.wrapQueryParamEvent; // just for shorthand
const resetStubs = () => helper.resetStubs(
    fetchMultiBoostsStub, findAccountsStub, fetchTournScoresStub, fetchBoostLogsStub, 
    fetchBoostDetailsStub, fetchTournScoresStub, cacheGetStub, cacheMultiGetStub, cacheSetStub,
    sumAmountsStub
); 

const testBoostId = uuid();
const testUserId = uuid();
const testAccountId = uuid();

describe('*** UNIT TEST USER BOOST LIST HANDLER ***', () => {
    const testStatusCondition = { REDEEMED: [`save_completed_by #{${uuid()}}`, `first_save_by #{${uuid()}}`] };

    const testStartTime = moment().subtract(1, 'week');
    const testEndTime = moment().add(1, 'week');
    const testUpdatedTime = moment().subtract(1, 'day');

    const mockBoostFromRds = {
        boostId: testBoostId,
        creatingUserId: '',
        label: 'BOOST LABEL',
        active: true,
        boostType: 'SIMPLE',
        boostCategory: 'SIMPLE_SAVE',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostRedeemed: 600000,
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        startTime: testStartTime.format(),
        endTime: testEndTime.format(),
        updatedTime: testUpdatedTime.format(),
        statusConditions: testStatusCondition,
        boostStatus: 'OFFERED'
    };

    beforeEach(resetStubs);

    it('Lists all user boosts, active and inactive', async () => {
        fetchMultiBoostsStub.withArgs(testAccountId).resolves([mockBoostFromRds, mockBoostFromRds]);
        findAccountsStub.resolves([testAccountId]);

        const resultOfListing = await handler.listUserBoosts(helper.wrapQueryParamEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        const resultBody = helper.standardOkayChecks(resultOfListing, true);
        expect(resultBody).to.deep.equal([mockBoostFromRds, mockBoostFromRds]);
        
        expect(fetchMultiBoostsStub).to.have.been.calledOnceWithExactly(testAccountId);
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(fetchBoostLogsStub).to.not.have.been.called;
    });

    it('Lists all active boosts with flag', async () => {
        const excludedStatus = ['REDEEMED', 'REVOKED', 'FAILED', 'EXPIRED']; // starting to grandfather in FAILED
        findAccountsStub.resolves([testAccountId]);
        fetchMultiBoostsStub.resolves([mockBoostFromRds]); // not relevant to test

        const resultOfListing = await handler.listUserBoosts(wrapEvent({ flag: 'FRIEND_TOURNAMENT', onlyActive: true }, testUserId));
        
        const bodyOfResult = helper.standardOkayChecks(resultOfListing);
        expect(bodyOfResult).to.deep.equal([mockBoostFromRds]);

        expect(fetchMultiBoostsStub).to.have.been.calledOnce;
        expect(fetchMultiBoostsStub).to.have.been.calledWith(testAccountId, { flags: ['FRIEND_TOURNAMENT'], excludedStatus });
    });

    it('Fails on missing user id in context', async () => {
        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, null, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 403);
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify({ message: 'User ID not found in context' }));
        expect(fetchMultiBoostsStub).to.have.not.been.called;
        expect(findAccountsStub).to.have.not.been.called;
    });

    it('Fails where user account not found', async () => {
        findAccountsStub.resolves([]);

        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 403);
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify({ message: 'No account found for this user' }));
        expect(fetchMultiBoostsStub).to.have.not.been.called;
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
    });

    it('Catches thrown errors', async () => {
        findAccountsStub.throws(new Error('ERROR'));

        const resultOfListing = await handler.listUserBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        logger('Boost listing resulted in:', resultOfListing);

        expect(resultOfListing).to.exist;
        expect(resultOfListing).to.have.property('statusCode', 500);
        expect(resultOfListing.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfListing.body).to.deep.equal(JSON.stringify({ error: 'ERROR' }));
        expect(fetchMultiBoostsStub).to.have.not.been.called;
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
    });

});

describe('*** UNIT TEST BOOST DETAILS (CHANGED AND SPECIFIED) ***', () => {

    const testStartTime = moment().subtract(1, 'day');
    const testEndTime = moment().add(1, 'day');

    const testStatusCondition = { UNLOCKED: [`save_completed_by #{${uuid()}}`], REDEEMED: ['number_taps_in_first_N #{1:10000}'] };

    const mockBoost = {
        boostId: testBoostId,
        creatingUserId: 'user-id',
        label: 'Tournament!',
        active: true,
        boostType: 'GAME',
        boostCategory: 'TAP_SCREEN',
        boostAmount: 10,
        boostUnit: 'WHOLE_CURRENCY',
        boostCurrency: 'EUR',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        startTime: testStartTime.format(),
        endTime: testEndTime.format(),
        statusConditions: testStatusCondition,
        boostStatus: 'UNLOCKED'
    };

    beforeEach(resetStubs);

    it('Checks for boosts with recently changed status', async () => {
        const expiredBoost = { ...mockBoost };
        expiredBoost.boostType = 'SIMPLE';
        expiredBoost.boostStatus = 'EXPIRED';
        expiredBoost.boostUnit = 'WHOLE_CURRENCY';
        expiredBoost.boostAmount = 15;

        findAccountsStub.resolves([testAccountId]);

        fetchMultiBoostsStub.onFirstCall().resolves([mockBoost]);
        fetchMultiBoostsStub.onSecondCall().resolves([expiredBoost]);

        fetchBoostLogsStub.withArgs(testAccountId, [testBoostId], 'STATUS_CHANGE').resolves([]);

        const resultOfChangeFetch = await handler.listChangedBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        const resultBody = helper.standardOkayChecks(resultOfChangeFetch);
        
        expect(resultBody).to.deep.equal([{ ...mockBoost, statusChangeLogs: [] }, expiredBoost]);
        
        const excludedForPositive = ['CREATED', 'OFFERED', 'EXPIRED', 'FAILED'];
        const excludedForNegative = ['CREATED', 'OFFERED', 'PENDING', 'UNLOCKED', 'REDEEMED', 'CONSOLED'];
        
        expect(fetchMultiBoostsStub).to.have.been.calledWith(testAccountId, { changedSinceTime: sinon.match.any, excludedStatus: excludedForPositive });
        expect(fetchMultiBoostsStub).to.have.been.calledWith(testAccountId, { changedSinceTime: sinon.match.any, excludedStatus: excludedForNegative });

        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(fetchBoostLogsStub).to.have.been.calledTwice;
    });

    it('Attach game outcome result to game logs, won tournament', async () => {
        const gameBoost = { ...mockBoost };
        gameBoost.boostType = 'GAME';
        gameBoost.boostStatus = 'REDEEMED';

        findAccountsStub.resolves([testAccountId]);
        fetchMultiBoostsStub.onFirstCall().resolves([gameBoost]);
        fetchMultiBoostsStub.onSecondCall().resolves([]);

        const mockLockContext = { numberTaps: 10, ranking: 1 };
        const mockGameLog = { accountId: testAccountId, boostId: testBoostId, logType: 'GAME_OUTCOME', logContext: mockLockContext };

        const mockStatusContext = { newStatus: 'REDEEMED', boostAmount: 6 };
        const mockRedeemLog = { accountId: testAccountId, boostId: testBoostId, logType: 'STATUS_CHANGE', logContext: mockStatusContext };
        
        fetchBoostLogsStub.withArgs(testAccountId, [testBoostId], 'GAME_OUTCOME').resolves([mockGameLog]);
        fetchBoostLogsStub.withArgs(testAccountId, [testBoostId], 'STATUS_CHANGE').resolves([mockRedeemLog]);

        const resultOfChangeFetch = await handler.listChangedBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        const bodyOfResult = helper.standardOkayChecks(resultOfChangeFetch);

        const expectedBoost = { ...mockBoost, boostType: 'GAME', boostStatus: 'REDEEMED', gameLogs: [mockGameLog], statusChangeLogs: [mockRedeemLog] }; 
        const fetchedBoost = bodyOfResult[0];
        expect(fetchedBoost).to.deep.equal(expectedBoost);

        expect(fetchBoostLogsStub).to.have.been.calledTwice; // content of call is covered above
    });

    it('Attach game outcome result to game logs, lost tournament', async () => {
        const gameBoost = { ...mockBoost };
        gameBoost.boostStatus = 'EXPIRED';

        findAccountsStub.resolves([testAccountId]);
        fetchMultiBoostsStub.onFirstCall().resolves([]);
        fetchMultiBoostsStub.onSecondCall().resolves([gameBoost]);

        const mockLockContext = { numberTaps: 3, ranking: 4 };
        const mockGameLog = { accountId: testAccountId, boostId: testBoostId, logType: 'GAME_OUTCOME', logContext: mockLockContext };
        
        fetchBoostLogsStub.withArgs(testAccountId, [testBoostId], 'GAME_OUTCOME').resolves([mockGameLog]);
        fetchBoostLogsStub.resolves([]);

        const resultOfChangeFetch = await handler.listChangedBoosts(wrapEvent({}, testUserId, 'ORDINARY_USER'));
        const bodyOfResult = helper.standardOkayChecks(resultOfChangeFetch);

        const expectedBoost = { ...mockBoost, boostType: 'GAME', boostStatus: 'EXPIRED', gameLogs: [mockGameLog], statusChangeLogs: [] }; 
        const fetchedBoost = bodyOfResult[0];
        expect(fetchedBoost).to.deep.equal(expectedBoost);

        expect(fetchBoostLogsStub).to.have.callCount(4); // content of calls covered above, others are calls for unclear reasons

        expect(cacheGetStub).to.have.been.calledOnceWithExactly(`ACCOUNT_ID::${testUserId}`);
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(testUserId);
        expect(cacheSetStub).to.have.been.calledOnceWithExactly(`ACCOUNT_ID::${testUserId}`, testAccountId, 'EX', 3600); // one hour
    });

    it('Attaches all game logs to friend tournament, when asked for detail', async () => {
        const mockFriendTournBoost = { ...mockBoost };
        mockFriendTournBoost.flags = ['FRIEND_TOURNAMENT'];
        mockFriendTournBoost.accountIds = [testAccountId, 'account-2'];

        cacheGetStub.resolves(testAccountId);

        fetchBoostDetailsStub.resolves(mockFriendTournBoost);

        const mockLog = (userId, gameScore) => ({ userId, gameScore });        
        const mockTournLogs = [mockLog(testUserId, 15), mockLog('user-1', 10), mockLog('user-2', 20)];
        fetchTournScoresStub.resolves(mockTournLogs);

        cacheMultiGetStub.resolves([
            JSON.stringify({ systemWideUserId: testUserId }), 
            null, 
            JSON.stringify({ systemWideUserId: 'user-2', personalName: 'Some', familyName: 'Person' })
        ]);

        const resultOfListing = await handler.fetchBoostDetails(wrapEvent({ boostId: testBoostId }, testUserId));

        const bodyOfResult = helper.standardOkayChecks(resultOfListing);
        
        const expectedBoost = {
            ...mockFriendTournBoost,
            tournamentScores: [
                { playerName: 'SELF', playerScore: 15 },
                { playerName: 'Player 2', playerScore: 10 },
                { playerName: 'Some Person', playerScore: 20 }
            ]
        };
        expect(bodyOfResult).to.deep.equal(expectedBoost);

        expect(cacheGetStub).to.have.been.calledOnceWithExactly(`ACCOUNT_ID::${testUserId}`);
        expect(findAccountsStub).to.not.have.been.called;

        expect(fetchBoostDetailsStub).to.have.been.calledOnceWithExactly(testBoostId, true);
        expect(fetchTournScoresStub).to.have.been.calledOnceWithExactly(testBoostId);
        expect(cacheMultiGetStub).to.have.been.calledOnceWithExactly([`FRIEND_PROFILE::${testUserId}`, 'FRIEND_PROFILE::user-1', 'FRIEND_PROFILE::user-2']);    
    });

    it('Does not attach logs when not friend tournament, if not admin', async () => {
        const mockPlainBoost = { ...mockBoost };
        mockPlainBoost.flags = [];
        mockPlainBoost.accountIds = [testAccountId, 'account-2'];

        cacheGetStub.resolves(testAccountId);

        fetchBoostDetailsStub.resolves(mockPlainBoost);
        const resultOfListing = await handler.fetchBoostDetails(wrapEvent({ boostId: testBoostId }, testUserId));

        const bodyOfResult = helper.standardOkayChecks(resultOfListing);
        
        expect(bodyOfResult).to.deep.equal(mockPlainBoost);

        expect(cacheGetStub).to.have.been.calledOnceWithExactly(`ACCOUNT_ID::${testUserId}`);
        expect(findAccountsStub).to.not.have.been.called;

        expect(fetchBoostDetailsStub).to.have.been.calledOnceWithExactly(testBoostId, true);
        expect(fetchTournScoresStub).to.not.have.been.called;
        expect(cacheMultiGetStub).to.not.have.been.called;    
    });

    it('Rejects detail request if not offered boost', async () => {
        const mockPlainBoost = { ...mockBoost };
        mockPlainBoost.accountIds = ['other-account', 'account-2'];

        cacheGetStub.resolves(testAccountId);

        fetchBoostDetailsStub.resolves(mockPlainBoost);
        const resultOfListing = await handler.fetchBoostDetails(wrapEvent({ boostId: testBoostId }, testUserId));

        expect(resultOfListing).to.deep.equal({ statusCode: 403 });

        expect(cacheGetStub).to.have.been.calledOnceWithExactly(`ACCOUNT_ID::${testUserId}`);
        expect(findAccountsStub).to.not.have.been.called;

        expect(fetchBoostDetailsStub).to.have.been.calledOnceWithExactly(testBoostId, true);
        expect(fetchTournScoresStub).to.not.have.been.called;
        expect(cacheMultiGetStub).to.not.have.been.called;    

    });

    it('Calculates boost yields', async () => {
        const mockFriendTournBoost = { ...mockBoost };
        mockFriendTournBoost.flags = ['FRIEND_TOURNAMENT'];
        mockFriendTournBoost.accountIds = ['account-id-1', 'account-id-2'];

        cacheGetStub.resolves();
        findAccountsStub.resolves(['account-id-1']);
        fetchBoostDetailsStub.resolves(mockFriendTournBoost);

        const mockTournLogs = [
            { userId: 'user-id-1', gameScore: 13 },
            { userId: 'user-id-2', gameScore: 21 },
            { userId: 'user-id-3', gameScore: 34 }
        ];
        fetchTournScoresStub.resolves(mockTournLogs);

        cacheMultiGetStub.resolves([null, null, JSON.stringify({ systemWideUserId: 'user-id-3', personalName: 'Some', familyName: 'Person' })]);
        sumAmountsStub.resolves([{ boostId: 'boost-id-1', sumOfBoostAmount: 100000, sumOfSaved: 500 }]);

        const resultOfCalc = await handler.fetchBoostDetails(wrapEvent({ boostId: 'boost-id-1' }, 'admin-id', 'SYSTEM_ADMIN'));
        const resultBody = helper.standardOkayChecks(resultOfCalc, true);

        const expectedYields = { boostYields: [{ boostId: 'boost-id-1', boostYield: 0.02 }]};

        const expectedTournScores = { tournamentScores: [
            { playerName: 'Player 1', playerScore: 13 },
            { playerName: 'Player 2', playerScore: 21 },
            { playerName: 'Some Person', playerScore: 34 }
        ]};

        const expectedResult = { ...mockFriendTournBoost, ...expectedTournScores, ...expectedYields };

        expect(resultBody).to.deep.equal(expectedResult);
        expect(sumAmountsStub).to.have.been.calledOnceWithExactly(['boost-id-1']);

        expect(fetchTournScoresStub).to.have.been.calledOnceWithExactly('boost-id-1');
        expect(cacheGetStub).to.have.been.calledOnceWithExactly(`ACCOUNT_ID::admin-id`);

        const cacheMultiGetArgs = ['FRIEND_PROFILE::user-id-1', 'FRIEND_PROFILE::user-id-2', 'FRIEND_PROFILE::user-id-3'];
        expect(cacheMultiGetStub).to.have.been.calledOnceWithExactly(cacheMultiGetArgs);

        expect(findAccountsStub).to.have.been.calledOnceWithExactly('admin-id');
        expect(fetchBoostDetailsStub).to.have.been.calledOnceWithExactly('boost-id-1', true);
    });

    it('Fetches details for quiz boost', async () => {
        const testQuizBoost = { ...mockBoost, boostCategory: 'QUIZ' };

        testQuizBoost.flags = [];
        testQuizBoost.accountIds = ['account-id-1'];
        testQuizBoost.gameParams = {
            gameType: 'QUIZ',
            timeLimitSeconds: 30,
            winningThreshold: 10,
            instructionBand: 'Answer all quiz questions correctly in 30 seconds',
            entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}',
            questionSnippetIds: ['snippet-id-2', 'snippet-id-1']
        };

        findAccountsStub.resolves(['account-id-1']);
        fetchBoostDetailsStub.resolves(testQuizBoost);

        const testQuestionSnippet = (snippetId) => ({
            snippetId,
            title: 'Quiz Snippet 2',
            body: 'How often can you withdraw from your Jupiter account?',
            responseOptions: {
                responseTexts: [
                    'As often as you like',
                    'Tuesdays and Thursdays',
                    'Mondays and Wednesdays'
                ],
                correctAnswerText: 'As often you like'
            }
        });

        // note order here is reversed from that in questionSnippetIds, to make sure the sort is in place
        fetchSnippetsStub.resolves([testQuestionSnippet('snippet-id-1'), testQuestionSnippet('snippet-id-2')]);

        const testEvent = wrapEvent({ boostId: 'boost-id-1' }, 'user-id', 'ORDINARY_USER');
        
        const resultOfFetch = await handler.fetchBoostDetails(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfFetch, true);

        const expectedSnippets = ['snippet-id-2', 'snippet-id-1'].map(testQuestionSnippet).map((snippet) => {
            Reflect.deleteProperty(snippet.responseOptions, 'correctAnswerText');
            return snippet;
        });
        
        const expectedResult = { ...testQuizBoost, questionSnippets: expectedSnippets };

        expect(resultBody).to.deep.equal(expectedResult);

        expect(cacheGetStub).to.have.been.calledOnceWithExactly(`ACCOUNT_ID::user-id`);

        expect(findAccountsStub).to.have.been.calledOnceWithExactly('user-id');
        expect(fetchBoostDetailsStub).to.have.been.calledOnceWithExactly('boost-id-1', true);

        helper.expectNoCalls(sumAmountsStub, fetchTournScoresStub, cacheMultiGetStub);
    });
    
});
