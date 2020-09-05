'use strict';

// const logger = require('debug')('jupiter:boost:quiz-tests');
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
const updateBoostAccountStub = sinon.stub();
const alterBoostStub = sinon.stub();
const findUserIdsStub = sinon.stub();

const publishUserEventStub = sinon.stub();
const publishMultiStub = sinon.stub();
const momentStub = sinon.stub();

// quiz response stubs
const fetchBoostStub = sinon.stub();
const fetchAccountStatusStub = sinon.stub();
const updateBoostRedeemedStub = sinon.stub();
const getAccountIdForUserStub = sinon.stub();
const insertBoostLogStub = sinon.stub();
const fetchSnippetsStub = sinon.stub();

const redeemOrRevokeStub = sinon.stub();

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
        'setBoostMessages': alterBoostStub,
        'findUserIdsForAccounts': findUserIdsStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'publish-common': {
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
        'fetchQuestionSnippets': fetchSnippetsStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redeemOrRevokeStub
    },
    'publish-common': {
        'publishUserEvent': publishUserEventStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient
    },
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(insertBoostStub, alterBoostStub, findUserIdsStub, publishMultiStub, lambdaInvokeStub, momentStub);

describe('*** UNIT TEST CREATE BOOST QUIZ ***', async () => {

    const testBoostId = uuid();
    const testMsgInstructId = uuid();
    const testCreatingUserId = uuid();
    const testAudienceId = uuid();
    
    const testStartTime = moment();
    const testPersistedTime = moment().add(1, 'second');
    const testEndTime = moment().add(7, 'days');

    const gameParams = {
        gameType: 'QUIZ',
        timeLimitSeconds: 30,
        winningThreshold: 10,
        instructionBand: 'Answer all quiz questions correctly in 30 seconds',
        entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}',
        questionSnippetIds: ['snippet-id-1', 'snippet-id-2']
    };

    const quizBoostToRds = {
        creatingUserId: testCreatingUserId,
        label: 'Daily Quiz',
        boostType: 'GAME',
        boostCategory: 'QUIZ',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostBudget: 10000000,
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        defaultStatus: 'OFFERED',
        audienceId: testAudienceId,
        boostAudienceType: 'GENERAL',
        messageInstructionIds: {},
        gameParams,
        statusConditions: {
            OFFERED: ['message_instruction_created'],
            UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
            REDEEMED: ['percent_destroyed_above #{50::30000}'],
            FAILED: ['number_taps_less_than #{10::30000}']
        }
    };

    beforeEach(resetStubs);

    it('Handles quiz game creation', async () => {
        const messageReqBody = {
            isMessageSequence: true,
            boostStatus: 'ALL',
            presentationType: 'ONCE_OFF',
            templates: { }
        };
        
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
            gameParams,
            statusConditions: {
                OFFERED: ['message_instruction_created'],
                UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
                REDEEMED: ['percent_destroyed_above #{50::30000}']
            }
        };

        const mockResultFromRds = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 100,
            accountIds: ['account-id-1', 'account-id-2']
        };

        momentStub.onFirstCall().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        insertBoostStub.resolves(mockResultFromRds);

        const mockMsgInstructReturnBody = {
            processResult: 'FIRED_INSTRUCT',
            message: { instructionId: testMsgInstructId, creationTimeMillis: moment().valueOf() }
        };
        
        lambdaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });

        alterBoostStub.resolves({ updatedTime: moment() });

        const resultOfCreate = await quizCreateHandler.createBoost({ ...testBodyOfEvent });
        expect(resultOfCreate).to.exist;

        const expectedResult = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 100,
            accountIds: ['account-id-1', 'account-id-2'],
            messageInstructions: [{
                accountId: 'ALL',
                status: 'ALL',
                msgInstructionId: testMsgInstructId
            }]
        };

        expect(resultOfCreate).to.deep.equal(expectedResult);
        expect(insertBoostStub).to.have.been.calledOnceWithExactly(quizBoostToRds);
        
        const msgInstructionPayload = {
            creatingUserId: testCreatingUserId,
            boostStatus: 'ALL',
            audienceType: 'GENERAL',
            presentationType: 'ONCE_OFF',
            audienceId: testAudienceId,
            endTime: testEndTime.format(),
            messagePriority: 100,
            templates: { sequence: [] }
        };

        const msgInstructionInvocation = testHelper.wrapLambdaInvoc('message_instruct_create', false, msgInstructionPayload);

        expect(lambdaInvokeStub).to.have.been.calledOnceWithExactly(msgInstructionInvocation);

        const msgInstructionIdDict = [{ accountId: 'ALL', status: 'ALL', msgInstructionId: testMsgInstructId }];
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, msgInstructionIdDict, true);
        expect(publishMultiStub).to.have.been.calledTwice;
    });
});

describe('*** UNIT TEST QUIZ REPONSE HANDLING ***', () => {
    const testBoostId = uuid();
    const testUserId = uuid();
    const testAccountId = uuid();

    const snippetAsRelevent = (snippetId, correctAnswerText) => ({ snippetId, responseOptions: { correctAnswerText }});

    it('Redeems quiz boost when won', async () => {
        const testEvent = {
            eventType: 'USER_GAME_COMPLETION',
            boostId: testBoostId,
            timeTakenMillis: 15000,
            userResponses: [
                { snippetId: 'snippet-id-1', userAnswerText: 'Whenever you like' },
                { snippetId: 'snippet-id-2', userAnswerText: '2 percent' },
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
            boostCategory: 'QUIZ',
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
                REDEEMED: ['percent_destroyed_above #{50::30000}']
            }
        };

        fetchBoostStub.resolves(boostAsRelevant);
        fetchAccountStatusStub.withArgs(testBoostId, testAccountId).resolves({ boostStatus: 'UNLOCKED' });
        getAccountIdForUserStub.resolves(testAccountId);
        redeemOrRevokeStub.resolves({ [testBoostId]: { result: 'SUCCESS', boostAmount: 50000 }});

        const questionSnippets = [
            snippetAsRelevent('snippet-id-1', 'Whenever you like'),
            snippetAsRelevent('snippet-id-2', '5 percent'),
            snippetAsRelevent('snippet-id-3', 'Any number of friends')
        ];

        fetchSnippetsStub.resolves(questionSnippets);
        
        const mockUpdateProcessedTime = moment();
        updateBoostAccountStub.resolves([{ boostId: testBoostId, updatedTime: mockUpdateProcessedTime }]);

        const resultOfQuiz = await quizResponseHandler.processUserBoostResponse(testHelper.wrapEvent(testEvent, testUserId, 'ORDINARY_USER'));
        const resultBody = testHelper.standardOkayChecks(resultOfQuiz);

        const expectedResult = { 
            result: 'TRIGGERED', 
            statusMet: ['REDEEMED'], 
            endTime: boostAsRelevant.boostEndTime.valueOf(),
            amountAllocated: { amount: 50000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            resultOfQuiz: {
                correctAnswers: ['Whenever you like', '5 percent', 'Any number of friends'],
                numberCorrectAnswers: 2,
                numberQuestions: 3
            }
        };
        expect(resultBody).to.deep.equal(expectedResult);

        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);

        const redemptionArgs = {
            event: { accountId: testAccountId, eventType: 'USER_GAME_COMPLETION' },
            redemptionBoosts: [boostAsRelevant],
            affectedAccountsDict: {
                [testBoostId]: { [testAccountId]: {
                    newStatus: 'REDEEMED',
                    userId: testUserId
                }}
            }
        };
        expect(redeemOrRevokeStub).to.have.been.calledOnceWithExactly(redemptionArgs);
        
        const expectedLogContext = { 
            submittedParams: { ...testEvent, percentDestroyed: 67 },
            processType: 'USER', 
            newStatus: 'REDEEMED', 
            boostAmount: 50000 
        };
        
        const expectedUpdateInstruction = {
            boostId: testBoostId,
            accountIds: [testAccountId],
            newStatus: 'REDEEMED',
            logType: 'STATUS_CHANGE',
            logContext: expectedLogContext
        };

        const logContext = { percentDestroyed: 67, timeTakenMillis: 15000 };
        const expectedGameLog = { boostId: testBoostId, accountId: testAccountId, logType: 'GAME_RESPONSE', logContext };

        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedUpdateInstruction]);
        expect(insertBoostLogStub).to.have.been.calledOnceWithExactly([expectedGameLog]);
        expect(updateBoostRedeemedStub).to.have.been.calledOnceWithExactly([testBoostId]);

        const expectedContext = {
            numberCorrectAnswers: 2,
            numberQuestions: 3,
            timeTakenMillis: 15000,
            questionSnippets,
            userResponses: testEvent.userResponses
        };
        
        expect(publishUserEventStub).to.have.been.calledWith(testUserId, 'QUIZ_ANSWER', { context: expectedContext });
    });
});
