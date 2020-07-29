'use strict';

const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const insertBoostStub = sinon.stub();
const alterBoostStub = sinon.stub();
const findUserIdsStub = sinon.stub();
const findAccountsStub = sinon.stub();

const publishMultiStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

const momentStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

/* eslint-disable brace-style */
const handler = proxyquire('../boost-create-handler', {
    './persistence/rds.boost': {
        'insertBoost': insertBoostStub,
        'setBoostMessages': alterBoostStub,
        'findUserIdsForAccounts': findUserIdsStub,
        'findAccountsForBoost': findAccountsStub
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiStub
    },
    'aws-sdk': {
        'Lambda': class { constructor () { this.invoke = lambdaInvokeStub; }}
    },
    'moment': momentStub,
    '@noCallThru': true
});
/* eslint-enable brace-style */

const resetStubs = () => testHelper.resetStubs(insertBoostStub, alterBoostStub, findUserIdsStub, findAccountsStub, publishMultiStub, lambdaInvokeStub, momentStub);

// Possibly the single most complicated operation in probably the entire system: creating a boost-game, with attendant conditions,
// messages (the most complex), and much else.
describe('*** UNIT TEST BOOSTS *** Happy path game based boost', () => {

    const testBoostId = uuid();
    const testMsgInstructId = uuid();
    const testCreatingUserId = uuid();
    const testAudienceId = uuid();
    
    const testStartTime = moment();
    const testExpiryTime = moment().add(1, 'day');
    const testPersistedTime = moment().add(1, 'second');
    const testEndTime = moment().add(7, 'days');

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
        UNLOCKED: ['save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'],
        REDEEMED: ['number_taps_greater_than #{20::20000}']
    };

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
        initialStatus: 'OFFERED',
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
        defaultStatus: 'OFFERED',
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

    beforeEach(resetStubs);

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
        lambdaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });
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
        const lambdaPayload = JSON.parse(lambdaInvokeStub.getCall(0).args[0].Payload);
        
        expect(lambdaPayload).to.deep.equal(expectedMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, true);

        expect(publishMultiStub).to.have.been.calledTwice; // for both creation and offering
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
        lambdaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });
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

        const lambdaPayload = JSON.parse(lambdaInvokeStub.getCall(0).args[0].Payload);
        expect(lambdaPayload).to.deep.equal(expectedMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, true);

        expect(publishMultiStub).to.have.been.calledThrice; // we emit OFFERED as well, because we need it included
    });

    it('Happy path creates a game boost, with default status offered, but does not overwrite existing status conditions', async () => {
        const alreadyStatusDefinedBoost = { ...testBodyOfEvent };
        alreadyStatusDefinedBoost.initialStatus = 'OFFERED';
        alreadyStatusDefinedBoost.statusConditions = testStatusConditions;
    
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

        const expectedResult = { ...mockResultFromRds, messageInstructions: mockMsgIdDict };
        const expectedMsgInstruct = assembleMessageInstruction();

        // now we do the call
        const resultOfCreate = await handler.createBoost(alreadyStatusDefinedBoost);
        expect(resultOfCreate).to.exist;
        expect(resultOfCreate).to.deep.equal(expectedResult);

        // then set up invocation checks
        const expectedBoost = { ...mockBoostToFromPersistence };
        expectedBoost.defaultStatus = 'OFFERED';        
        expect(insertBoostStub).to.have.been.calledOnceWithExactly(expectedBoost);

        const lambdaPayload = JSON.parse(lambdaInvokeStub.getCall(0).args[0].Payload);
        expect(lambdaPayload).to.deep.equal(expectedMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, true);

        expect(publishMultiStub).to.have.been.calledTwice;
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
        lambdaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });
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
            UNLOCKED: ['save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'],
            PENDING: ['number_taps_greater_than #{0::20000}'],
            REDEEMED: ['number_taps_in_first_N #{20::20000}']
        };
        
        expect(insertBoostStub).to.have.been.calledOnceWithExactly(expectedBoost);

        const lambdaPayload = JSON.parse(lambdaInvokeStub.getCall(0).args[0].Payload);
        expect(lambdaPayload).to.deep.equal(expectedMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, true);

        expect(publishMultiStub).to.have.been.calledTwice;
    });

    it('Happy path creates a game boost, which is triggered later', async () => {
        const eventGameParams = {
            gameType: 'CHASE_ARROW',
            timeLimitSeconds: 10,
            winningThreshold: 50
        };

        const mockMsgTrigger = { triggerEvent: ['USER_CREATED_ACCOUNT'] };
        const eventMessageBody = {
            boostStatus: 'ALL',
            isMessageSequence: false,
            presentationType: 'EVENT_DRIVEN',
            template: messageTemplates.UNLOCKED,
            triggerParameters: mockMsgTrigger
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

        lambdaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });

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
        const mockMsgInstruct = { ...expectedMsgInstruct, actionToTake: 'PLAY_GAME', presentationType: 'EVENT_DRIVEN', triggerParameters: mockMsgTrigger, templates: expectedTemplate };
        
        const lambdaPayload = JSON.parse(lambdaInvokeStub.getCall(0).args[0].Payload);
        expect(lambdaPayload).to.deep.equal(mockMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, mockMsgIdDict, false);

        expect(findAccountsStub).to.not.have.been.called;
        
        expect(publishMultiStub).to.not.have.been.calledOnce; // because _not_ published for multi etc
    });
});
