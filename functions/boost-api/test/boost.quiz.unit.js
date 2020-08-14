'use strict';

const logger = require('debug')('jupiter:boost:quiz-tests');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

// quiz create stubs
const insertBoostStub = sinon.stub();
const findBoostStub = sinon.stub();
const findAccountsStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const alterBoostStub = sinon.stub();
const findMsgInstructStub = sinon.stub();
const findUserIdsStub = sinon.stub();

const momentStub = sinon.stub();

const publishStub = sinon.stub();
const publishMultiStub = sinon.stub();

// quiz reponse stubs
const fetchBoostStub = sinon.stub();
const fetchAccountStatusStub = sinon.stub();
const updateBoostRedeemedStub = sinon.stub();
const getAccountIdForUserStub = sinon.stub();
const insertBoostLogStub = sinon.stub();
const fetchSnippetsStub = sinon.stub();

const redemptionHandlerStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const quizCreateHandler = proxyquire('../boost-create-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub,
        'findBoost': findBoostStub,
        'findAccountsForBoost': findAccountsStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'setBoostMessages': alterBoostStub,
        'findMsgInstructionByFlag': findMsgInstructStub,
        'findUserIdsForAccounts': findUserIdsStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'publish-common': {
        'publishUserEvent': publishStub,
        'publishMultiUserEvent': publishMultiStub
    },
    'moment': momentStub,
    '@noCallThru': true
});

const quizResponseHandler = proxyquire('../boost-user-handler', {
    './persistence/rds.boost': {
        'fetchBoost': fetchBoostStub,
        'fetchCurrentBoostStatus': fetchAccountStatusStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'updateBoostAmountRedeemed': updateBoostRedeemedStub,
        'getAccountIdForUser': getAccountIdForUserStub,
        'insertBoostAccountLogs': insertBoostLogStub,
        'fetchSnippets': fetchSnippetsStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient,
         // eslint-disable-next-line no-empty-function
         'config': { update: () => ({}) }
    },
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(insertBoostStub, alterBoostStub, findUserIdsStub, findAccountsStub, publishMultiStub, lambdaInvokeStub, momentStub);

describe.skip('*** UNIT TEST CREATE BOOST QUIZ ***', async () => {

    const testBoostId = uuid();
    const testMsgInstructId = uuid();
    const testCreatingUserId = uuid();
    const testAudienceId = uuid();
    
    const testStartTime = moment();
    const testPersistedTime = moment().add(1, 'second');
    const testEndTime = moment().add(7, 'days');

    const messageReqBody = {
        isMessageSequence: true,
        boostStatus: 'ALL',
        presentationType: 'ONCE_OFF',
        templates: { }
    };

    const gameParams = {
        gameType: 'QUIZ',
        timeLimitSeconds: 30,
        winningThreshold: 10,
        instructionBand: 'Answer all quiz questions correctly in 30 seconds',
        entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}',
        questionSnippetIds: ['snippet-id-1', 'snippet-id-2']
    };

    const mockMsgInstructReturnBody = {
        processResult: 'FIRED_INSTRUCT',
        message: { instructionId: testMsgInstructId, creationTimeMillis: moment().valueOf() }
    };

    beforeEach(resetStubs);

    it('Handles quiz game creation', async () => {

        const testBodyOfEvent = {
            label: 'Daily Quiz',
            creatingUserId: testCreatingUserId,
            boostTypeCategory: 'GAME::QUIZ',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: '10000000::HUNDREDTH_CENT::USD',
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            initialStatus: 'OFFERED',
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            messagesToCreate: [messageReqBody],
            gameParams
        };

        const mockResultFromRds = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 100,
            accountIds: [uuid(), uuid()]
        };

        momentStub.onFirstCall().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        insertBoostStub.resolves(mockResultFromRds);
        lambdaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });

        alterBoostStub.resolves({ updatedTime: moment() });

        const resultOfCreate = await handler.createBoost({ ...testBodyOfEvent });
        logger('Res: ', resultOfCreate)

    });
});

describe.skip('*** UNIT TEST QUIZ REPONSE HANDLING ***', () => {
    const testBoostId = uuid();
    const testUserId = uuid();
    const testAccountId = uuid();

    const snippetAsRelevent = (snippetId, correctAnswerText) => ({ snippetId, responseOptions: { correctAnswerText }});

    it('Redeems boost on quiz won', async () => {
        const testEvent = {
            eventType: 'USER_GAME_COMPLETION',
            boostId: testBoostId,
            timeTakenMillis: 15000,
            userResponses: [
                { snippetId: 'snippet-id-1', userAnswerText: 'Whenever you like' },
                { snippetId: 'snippet-id-2', userAnswerText: '5 percent' },
                { snippetId: 'snippet-id-3', userAnswerText: 'Any number of friends' }
            ]
        };

        const gameParams = {
            gameType: 'QUIZ',
            timeLimitSeconds: 30,
            winningThreshold: 2,
            instructionBand: 'Answer all quiz questions correctly in 30 seconds',
            entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}',
            questionSnippetIds: ['snippet-id-1', 'snippet-id-2', 'snippet-id-3']
        };
    
        const boostAsRelevant = {
            boostId: testBoostId,
            boostType: 'GAME',
            boostCategory: 'TAP_SCREEN',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000,
            fromFloatId: 'test-float',
            fromBonusPoolId: 'test-bonus-pool',
            boostEndTime: moment().endOf('day'),
            gameParams,
            statusConditions: {
                OFFERED: ['message_instruction_created'],
                UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
                REDEEMED: ['percent_destroyed_above #{0.5::30000}']
            }
        };

        fetchBoostStub.resolves(boostAsRelevant);
        fetchAccountStatusStub.withArgs(testBoostId, testAccountId).resolves({ boostStatus: 'UNLOCKED' });
        getAccountIdForUserStub.resolves(testAccountId);
        redemptionHandlerStub.resolves({ [testBoostId]: { result: 'SUCCESS', boostAmount: 50000 }});

        const questionSnippets = [
            snippetAsRelevent('snippet-id-1', 'Whenever you like'),
            snippetAsRelevent('snippet-id-2', '5 percent'),
            snippetAsRelevent('snippet-id-3', 'Any number of friends')
        ];

        fetchSnippetsStub.resolves(questionSnippets);
        
        const mockUpdateProcessedTime = moment();
        updateBoostAccountStub.resolves([{ boostId: testBoostId, updatedTime: mockUpdateProcessedTime }]);

        const expectedResult = { 
            result: 'TRIGGERED', 
            statusMet: ['REDEEMED'], 
            endTime: boostAsRelevant.boostEndTime.valueOf(),
            amountAllocated: { amount: 50000, unit: 'HUNDREDTH_CENT', currency: 'USD' }
        };

        const resultOfQuiz = await quizResponseHandler.processUserBoostResponse(testHelper.wrapEvent(testEvent, testUserId, 'ORDINARY_USER'));
        logger('Res:', resultOfQuiz);

    });
});