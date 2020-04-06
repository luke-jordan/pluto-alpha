'use strict';

const logger = require('debug')('jupiter:boosts:test');

const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));

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

const lamdbaInvokeStub = sinon.stub();
class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-create-handler', {
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

const resetStubs = () => testHelper.resetStubs(insertBoostStub, findBoostStub, findAccountsStub, updateBoostAccountStub, alterBoostStub, lamdbaInvokeStub, publishMultiStub);

const testStartTime = moment();
const testEndTime = moment().add(7, 'days');
const testMktingAdmin = uuid();
const testAudienceId = uuid();

describe('*** UNIT TEST BOOSTS *** Validation and error checks for insert', () => {

    it('Rejects event without authorization', async () => {
        const resultOfCall = await handler.createBoostWrapper({ boostType: 'FRAUD' });
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403 });
    });

    it('Rejects all categories except referrals if user is ordinary role', async () => {
        const resultOfCall = await handler.createBoostWrapper(testHelper.wrapEvent({ boostTypeCategory: 'SIMPLE::TIME_LIMITED' }, uuid(), 'ORDINARY_USER'));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403 });
    });

    it('Swallows an error and return its message', async () => {
        const resultOfCall = await handler.createBoostWrapper(testHelper.wrapEvent({ badObject: 'This is bad' }, uuid(), 'SYSTEM_ADMIN'));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.have.property('statusCode', 500);
    });

});

describe('*** UNIT TEST BOOSTS *** Individual or limited users', () => {

    const referralWindowEnd = moment().add(3, 'months');
    
    const testReferringUser = uuid();
    const testReferredUser = uuid();

    // IDs for message templates for referrer and referred
    const testReferringMsgId = uuid();
    const testReferredMsgId = uuid();

    const testCreatingUserId = uuid();

    const testClientId = 'some_client_co';

    // `whole_universe from #{'{"specific_accounts": ["${testReferringUser}","${testReferredUser}"]}'}`
    const mockBoostToFromPersistence = {
        creatingUserId: testCreatingUserId,
        label: 'Referral::Luke::Avish',
        boostType: 'REFERRAL',
        boostCategory: 'USER_CODE_USED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostBudget: 10000000,
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: referralWindowEnd,
        statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
        boostAudienceType: 'INDIVIDUAL',
        audienceId: testAudienceId,
        defaultStatus: 'PENDING',
        messageInstructionIds: [
            { accountId: testReferringUser, msgInstructionId: testReferringMsgId, status: 'REDEEMED' }, 
            { accountId: testReferredUser, msgInstructionId: testReferredMsgId, status: 'REDEEMED' }
        ],
        flags: ['REDEEM_ALL_AT_ONCE']
    };

    it('Happy path inserting a referral-based individual boost', async () => {
        logger('About to create a referral based boost, for two users, ending at: ', referralWindowEnd);

        const testPersistedTime = moment();
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(referralWindowEnd.valueOf()).returns(referralWindowEnd);

        const testCreatedAudienceId = uuid();
        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ 
            body: JSON.stringify({ audienceId: testCreatedAudienceId })
        })})});

        findMsgInstructStub.withArgs('REFERRAL::REDEEMED::REFERRER').resolves(testReferringMsgId);
        findMsgInstructStub.withArgs('REFERRAL::REDEEMED::REFERRED').resolves(testReferredMsgId);

        const expectedFromRds = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 2,
            accountIds: [testReferringUser, testReferredUser]
        };

        insertBoostStub.resolves(expectedFromRds);

        const testBodyOfEvent = {
            creatingUserId: testCreatingUserId,
            label: 'Referral::Luke::Avish',
            boostTypeCategory: 'REFERRAL::USER_CODE_USED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: '10000000::HUNDREDTH_CENT::USD',
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: testClientId,
                floatId: 'primary_cash'
            },
            endTimeMillis: referralWindowEnd.valueOf(),
            boostAudienceType: 'INDIVIDUAL',
            boostAudienceSelection: {
                table: config.get('tables.accountLedger'),
                conditions: [{ op: 'in', prop: 'account_id', value: `${testReferringUser}, ${testReferredUser}` }]
            },
            initialStatus: 'PENDING',
            statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
            messageInstructionFlags: {
                'REDEEMED': [
                    { accountId: testReferringUser, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRER' }, 
                    { accountId: testReferredUser, msgInstructionFlag: 'REFERRAL::REDEEMED::REFERRED' }
                ]
            }
        };

        findUserIdsStub.resolves(['user-id-1', 'user-id-2']);

        const resultOfInstruction = await handler.createBoost(testBodyOfEvent);
        expect(resultOfInstruction).to.deep.equal(expectedFromRds);

        const expectedAudiencePayload = {
            operation: 'create',
            params: {
                clientId: testClientId,
                creatingUserId: testCreatingUserId,
                isDynamic: false,
                propertyConditions: testBodyOfEvent.boostAudienceSelection
            }
        };
        const wrappedInvoke = testHelper.wrapLambdaInvoc('audience_selection', false, expectedAudiencePayload);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(wrappedInvoke);

        // const objectToRds = insertBoostStub.getCall(0).args[0];
        // logger('Sent to RDS: ', objectToRds);
        const expectedBoost = { ...mockBoostToFromPersistence };
        expectedBoost.audienceId = testCreatedAudienceId;
        expect(insertBoostStub).to.have.been.calledWithExactly(expectedBoost);

        expect(findUserIdsStub).to.have.been.calledWithExactly([testReferringUser, testReferredUser]);
        const expectedBoostAmount = { boostAmount: 100000, boostUnit: 'HUNDREDTH_CENT', boostCurrency: 'USD' };
        const expectedUserLogOptions = {
            initiator: testCreatingUserId,
            context: {
                boostType: 'REFERRAL', boostCategory: 'USER_CODE_USED', boostId: expectedFromRds.boostId, ...expectedBoostAmount
            }
        };
        expect(publishMultiStub).to.have.been.calledOnceWithExactly(['user-id-1', 'user-id-2'], 'BOOST_CREATED_REFERRAL', expectedUserLogOptions);
    });

});

describe('*** UNIT TEST BOOSTS *** General audience', () => {

    beforeEach(() => resetStubs());

    const testRedemptionMsgId = uuid();
    
    const mockBoostToFromPersistence = {
        creatingUserId: testMktingAdmin,
        label: 'Monday Limited Time Boost',
        boostType: 'SIMPLE',
        boostCategory: 'TIME_LIMITED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostBudget: 10000000,
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        statusConditions: { REDEEMED: ['save_event_greater_than #{200000::HUNDREDTH_CENT::USD}'] },
        boostAudienceType: 'GENERAL',
        audienceId: testAudienceId,
        defaultStatus: 'CREATED',
        messageInstructionIds: [{ accountId: 'ALL', status: 'REDEEMED', msgInstructionId: testRedemptionMsgId }]
    };

    it('Happy path creating a time-limited simple, general boost', async () => {
        logger('About to create a simple boost');

        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        const testNumberOfUsersInAudience = 100000;

        const testPersistedTime = moment();
        const persistenceResult = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: testNumberOfUsersInAudience
        };
        insertBoostStub.resolves(persistenceResult);

        const testBodyOfEvent = {
            label: 'Monday Limited Time Boost',
            boostTypeCategory: 'SIMPLE::TIME_LIMITED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: 10000000,
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            statusConditions: { REDEEMED: ['save_event_greater_than #{200000::HUNDREDTH_CENT::USD}'] },
            boostAudienceType: 'GENERAL',
            audienceId: testAudienceId,
            redemptionMsgInstructions: [{ accountId: 'ALL', msgInstructionId: testRedemptionMsgId }]
        };

        const resultOfInstruction = await handler.createBoostWrapper(testHelper.wrapEvent(testBodyOfEvent, testMktingAdmin, 'SYSTEM_ADMIN'));

        const bodyOfResult = testHelper.standardOkayChecks(resultOfInstruction);
        expect(bodyOfResult).to.deep.equal(persistenceResult);

        expect(insertBoostStub).to.have.been.calledWithExactly(mockBoostToFromPersistence);
    });

});

// The single most complicated operation in probably the entire system: creating a boost-game, with attendant conditions,
// messages (the most complex), and much else.
describe('*** UNIT TEST BOOSTS *** Happy path game based boost', () => {

    const testBoostId = uuid();
    const testMsgInstructId = uuid();
    const testCreatingUserId = uuid();
    
    const testExpiryTime = moment().add(1, 'day');
    const testPersistedTime = moment().add(1, 'second');

    const messageTemplates = {
        OFFERED: {
            title: 'Can you beat this challenge?',
            body: `Congratulations! You have saved so much you've unlocked a special challenge. Save R100 now to unlock it!`,
            display: {
                type: 'CARD',
                title: 'EMPHASIS',
                icon: 'BOOST_ROCKET'
            },
            actionToTake: 'ADD_CASH'
        },
        UNLOCKED: {
            title: 'Boost challenge unlocked!',
            body: 'Your top up was successful and you stand a chance to win R20. Follow the instructions below to play the game',
            display: {
                'type': 'MODAL',
                'iconType': 'SMILEY_FACE'
            },
            actionToTake: 'PLAY_GAME'
        },
        INSTRUCTION: {
            title: 'Boost challenge unlocked!',
            body: `You’ve unlocked this challenge and stand a chance of winning R20, but only if you can catch the arrow. Challenge will remain open until the end of the day`,
            display: {
                'type': 'CARD',
                'titleType': 'EMPHASIS',
                'iconType': 'UNLOCKED'
            },
            actionToTake: 'PLAY_GAME'
        },
        REDEEMED: {
            title: 'Well Done!',
            body: `You caught the arrow #{numberUserTaps} times! You won the challenge and R20 has been boosted to your account!`,
            display: {
                type: 'MODAL',
                iconType: 'THUMBS_UP'
            },
            actionToTake: 'DONE'
        },
        FAILURE: {
            title: 'Sorry, better luck next time!',
            body: `You missed out on this boost challenge, but keep an eye out for future boosts to earn more towards your savings!`,
            display: {
                'type': 'MODAL',
                'iconType': 'SAD_FACE'
            },
            actionToTake: 'DONE'
        }
    };

    const messageReqBody = {
        isMessageSequence: true,
        boostStatus: 'ALL',
        presentationType: 'ONCE_OFF',
        templates: messageTemplates
    };

    const gameParams = {
        gameType: 'CHASE_ARROW',
        timeLimitSeconds: 20,
        winningThreshold: 20,
        instructionBand: 'Tap the screen as many times as you can in 20 seconds',
        entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'
    };

    const testStatusConditions = {
        OFFERED: ['message_instruction_created'],
        UNLOCKED: ['save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'],
        REDEEMED: ['number_taps_greater_than #{20::20000}']
    };

    // todo: validation that type/category matches game params
    const testBodyOfEvent = {
        label: 'Midweek Catch Arrow',
        creatingUserId: testCreatingUserId,
        boostTypeCategory: 'GAME::CHASE_ARROW',
        boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
        boostBudget: '10000000::HUNDREDTH_CENT::USD',
        boostSource: {
            bonusPoolId: 'primary_bonus_pool',
            clientId: 'some_client_co',
            floatId: 'primary_cash'
        },
        endTimeMillis: testEndTime.valueOf(),
        boostAudienceType: 'GENERAL',
        audienceId: testAudienceId,
        messagesToCreate: [messageReqBody],
        gameParams
    };

    const mockBoostToFromPersistence = {
        creatingUserId: testCreatingUserId,
        label: 'Midweek Catch Arrow',
        boostType: 'GAME',
        boostCategory: 'CHASE_ARROW',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        boostBudget: 10000000,
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        statusConditions: testStatusConditions,
        boostAudienceType: 'GENERAL',
        audienceId: testAudienceId,
        defaultStatus: 'CREATED',
        gameParams,
        messageInstructionIds: { } 
    };

    // use jsonb for templates. define structure as: default // variant. and within default,
    // can be a single title/body, or can be a sequence. then user-message creater does the
    // relevant assembling, based on the sequence & construction of those templates
    const standardMsgActions = {
        'OFFERED': { action: 'ADD_CASH', context: { boostId: testBoostId, sequenceExpiryTimeMillis: testExpiryTime.valueOf() } },
        'UNLOCKED': { action: 'PLAY_GAME', context: { boostId: testBoostId, gameParams }},
        'INSTRUCTION': { action: 'PLAY_GAME', context: { boostId: testBoostId, gameParams }},
        'REDEEMED': { action: 'DONE', context: { checkOnDismissal: true } },
        'FAILURE': { action: 'DONE' }
    };

    const assembleMessageInstruction = () => {
        const messagePayload = {};
        messagePayload.creatingUserId = testCreatingUserId;
        messagePayload.boostStatus = 'ALL';
        messagePayload.audienceType = 'GENERAL';
        messagePayload.presentationType = 'ONCE_OFF';
        messagePayload.audienceId = testAudienceId;
        messagePayload.endTime = testEndTime.format();
        messagePayload.messagePriority = 100;
        
        const assembledMessageTemplates = Object.keys(messageTemplates).map((key) => {
            const msgTemplate = messageTemplates[key];
            msgTemplate.actionToTake = standardMsgActions[key].action;
            msgTemplate.actionContext = { ...standardMsgActions[key].context, gameParams: gameParams };
            return { 'DEFAULT': msgTemplate, identifier: key };
        });

        messagePayload.templates = { sequence: assembledMessageTemplates };
        return messagePayload;
    };

    const mockMsgInstructReturnBody = {
        processResult: 'FIRED_INSTRUCT',
        message: { instructionId: testMsgInstructId, creationTimeMillis: moment().valueOf() }
    };

    const mockMsgIdDict = [{ accountId: 'ALL', status: 'ALL', msgInstructionId: testMsgInstructId }];

    // logger('Here is the test event: ', JSON.stringify(testBodyOfEvent));

    const commonAssertions = () => {
        expect(insertBoostStub).to.have.not.been.called;
        expect(alterBoostStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    };

    beforeEach(() => {
        resetStubs();
        momentStub.reset();
    });

    it('Happy path creates a game boost, including setting up the messages', async () => {
        const mockResultFromRds = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 100,
            accountIds: [uuid(), uuid()]
        };

        momentStub.onFirstCall().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);
        insertBoostStub.resolves(mockResultFromRds);
        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });
        alterBoostStub.resolves({ updatedTime: moment() });

        const expectedResult = { ...mockResultFromRds, messageInstructions: mockMsgIdDict };
        const expectedMsgInstruct = assembleMessageInstruction();

        // now we do the call
        const resultOfCreate = await handler.createBoost({ ...testBodyOfEvent });
        expect(resultOfCreate).to.exist;
        expect(resultOfCreate).to.deep.equal(expectedResult);

        // then set up invocation checks
        const expectedBoostToRds = { ...mockBoostToFromPersistence };
        
        expect(insertBoostStub).to.have.been.calledOnceWithExactly(expectedBoostToRds);
        const lambdaPayload = JSON.parse(lamdbaInvokeStub.getCall(0).args[0].Payload);
        
        expect(lambdaPayload).to.deep.equal(expectedMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, true);
    });

    it('Happy path creates a game boost, with default status unlocked', async () => {
        const alreadyUnlockedBoost = { ...testBodyOfEvent };
        alreadyUnlockedBoost.initialStatus = 'UNLOCKED';
    
        const mockResultFromRds = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 100,
            accountIds: [uuid(), uuid()]
        };

        momentStub.onFirstCall().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);
        insertBoostStub.resolves(mockResultFromRds);
        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });
        alterBoostStub.resolves({ updatedTime: moment() });

        const expectedResult = { ...mockResultFromRds, messageInstructions: mockMsgIdDict };
        const expectedMsgInstruct = assembleMessageInstruction();

        // now we do the call
        const resultOfCreate = await handler.createBoost(alreadyUnlockedBoost);
        expect(resultOfCreate).to.exist;
        expect(resultOfCreate).to.deep.equal(expectedResult);

        // then set up invocation checks
        const expectedBoost = { ...mockBoostToFromPersistence };
        expectedBoost.defaultStatus = 'UNLOCKED';
        expectedBoost.statusConditions = { 
            REDEEMED: ['number_taps_greater_than #{20::20000}']
        };
        
        expect(insertBoostStub).to.have.been.calledOnceWithExactly(expectedBoost);

        const lambdaPayload = JSON.parse(lamdbaInvokeStub.getCall(0).args[0].Payload);
        expect(lambdaPayload).to.deep.equal(expectedMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, true);
    });

    it('Happy path creates a game boost, and sets up conditions for tournament', async () => {
        const tournParams = {
            gameType: 'CHASE_ARROW',
            timeLimitSeconds: 20,
            numberWinners: 20,
            entryCondition: 'save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'
        };

        const tournamentBoost = { ...testBodyOfEvent, gameParams: tournParams };
    
        const mockResultFromRds = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 100,
            accountIds: [uuid(), uuid()]
        };

        momentStub.onFirstCall().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);
        insertBoostStub.resolves(mockResultFromRds);
        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });
        alterBoostStub.resolves({ updatedTime: moment() });

        const expectedResult = { ...mockResultFromRds, messageInstructions: mockMsgIdDict };
        const expectedMsgInstruct = assembleMessageInstruction();

        // now we do the call
        const resultOfCreate = await handler.createBoost(tournamentBoost);
        expect(resultOfCreate).to.exist;
        expect(resultOfCreate).to.deep.equal(expectedResult);

        // then set up invocation checks
        const expectedBoost = { ...mockBoostToFromPersistence, gameParams: tournParams };
        expectedBoost.statusConditions = { 
            OFFERED: ['message_instruction_created'],
            UNLOCKED: ['save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'],
            PENDING: ['number_taps_greater_than #{0::20000}'],
            REDEEMED: ['number_taps_in_first_N #{20::20000}']
        };
        
        expect(insertBoostStub).to.have.been.calledOnceWithExactly(expectedBoost);

        const lambdaPayload = JSON.parse(lamdbaInvokeStub.getCall(0).args[0].Payload);
        expect(lambdaPayload).to.deep.equal(expectedMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, true);

        expect(publishMultiStub).to.have.been.called;
    });

    it('Happy path creates a game boost, which is triggered later', async () => {
        const eventGameParams = {
            gameType: 'CHASE_ARROW',
            timeLimitSeconds: 10,
            winningThreshold: 50
        };

        const eventMessageBody = {
            boostStatus: 'ALL',
            isMessageSequence: false,
            presentationType: 'EVENT_DRIVEN',
            template: messageTemplates.UNLOCKED,
            triggerParameters: {
                triggerEvent: ['USER_CREATED_ACCOUNT']
            }
        };    

        const eventBoost = { 
            ...testBodyOfEvent,
            initialStatus: 'UNCREATED',
            statusConditions: { UNLOCKED: ['event_occurs #{USER_CREATED_ACCOUNT}'] },
            gameParams: eventGameParams,
            messagesToCreate: [eventMessageBody]
        };
    
        const mockResultFromRds = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            accountIds: []
        };

        momentStub.onFirstCall().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);

        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });

        insertBoostStub.resolves(mockResultFromRds);
        alterBoostStub.resolves({ updatedTime: moment() });

        const expectedResult = { ...mockResultFromRds, messageInstructions: mockMsgIdDict };
        const expectedMsgInstruct = assembleMessageInstruction();

        const resultOfCreate = await handler.createBoost(eventBoost);
        expect(resultOfCreate).to.exist;
        expect(resultOfCreate).to.deep.equal(expectedResult);

        // then set up invocation checks
        const expectedBoost = { ...mockBoostToFromPersistence, defaultStatus: 'UNCREATED', gameParams: eventGameParams };
        expectedBoost.statusConditions = { 
            UNLOCKED: ['event_occurs #{USER_CREATED_ACCOUNT}'],
            REDEEMED: ['number_taps_greater_than #{50::10000}']
        };
        
        expect(insertBoostStub).to.have.been.calledOnceWithExactly(expectedBoost);

        const expectedTemplate = { template: { DEFAULT: messageTemplates.UNLOCKED }};
        const mockMsgInstruct = { ...expectedMsgInstruct, actionToTake: 'PLAY_GAME', presentationType: 'EVENT_DRIVEN', templates: expectedTemplate };
        
        const lambdaPayload = JSON.parse(lamdbaInvokeStub.getCall(0).args[0].Payload);
        expect(lambdaPayload).to.deep.equal(mockMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, false);

        expect(findAccountsStub).to.not.have.been.called;
        expect(publishMultiStub).to.not.have.been.called;
    });

    it('Handles test call', async () => {
        const resultOfCreate = await handler.createBoost();
        expect(resultOfCreate).to.exist;
        expect(resultOfCreate).to.deep.equal({ statusCode: 400 });
        commonAssertions();
    });

    it('Fail on boost category-game param mismatch', async () => {
        const expectedError = 'Boost category must match game type where boost type is GAME';

        const eventBody = { ...testBodyOfEvent };

        eventBody.boostTypeCategory = 'GAME::TAP_SCREEN';
        await expect(handler.createBoost(eventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();
    });

    it('Fail on missing game parameters where boost tyoe is GAME', async () => {
        const expectedError = 'Boost games require game parameters';

        const eventBody = { ...testBodyOfEvent };

        Reflect.deleteProperty(eventBody, 'gameParams');
        await expect(handler.createBoost(eventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();
    });

    it('Fail where boost reward is greater than boost budget', async () => {
        const expectedError = 'Boost reward cannot be greater than boost budget';

        const eventBody = { ...testBodyOfEvent };
        
        eventBody.boostAmountOffered = '10000001::HUNDREDTH_CENT::USD';
        await expect(handler.createBoost(eventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();
    });

    it('Fail on invalid boost category for boost type', async () => {
        const expectedError = 'The boost type is not compatible with the boost category';

        const testEventBody = { ...testBodyOfEvent };
        
        testEventBody.boostTypeCategory = 'GAME::TIME_LIMITED';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();

        testEventBody.boostTypeCategory = 'GAME::USER_CODE_USED';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();

        testEventBody.boostTypeCategory = 'SIMPLE::CHASE_ARROW';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();

        testEventBody.boostTypeCategory = 'SIMPLE::TAP_SCREEN';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();

        testEventBody.boostTypeCategory = 'SIMPLE::USER_CODE_USED';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();

        testEventBody.boostTypeCategory = 'REFERRAL::CHASE_ARROW';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();

        testEventBody.boostTypeCategory = 'REFERRAL::TAP_SCREEN';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();

        testEventBody.boostTypeCategory = 'REFERRAL::TIME_LIMITED';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();

        testEventBody.boostTypeCategory = 'GAME::TAP_SCREEN';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith('Boost category must match game type where boost type is GAME');
        commonAssertions();
    });

});
