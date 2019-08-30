'use strict';

const logger = require('debug')('jupiter:boosts:test');
const moment = require('moment');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const insertBoostStub = sinon.stub();
const findBoostStub = sinon.stub();
const findAccountsStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const alterBoostStub = sinon.stub();

const momentStub = sinon.stub();

const publishStub = sinon.stub();
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
        'alterBoost': alterBoostStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'publish-common': {
        'publishUserEvent': publishStub
    },
    'moment': momentStub,
    '@noCallThru': true
});

const resetStubs = () => testHelper.resetStubs(insertBoostStub, findBoostStub, findAccountsStub, updateBoostAccountStub, alterBoostStub);

const testStartTime = moment();
const testEndTime = moment().add(7, 'days');
const testMktingAdmin = uuid();

describe('*** UNIT TEST BOOSTS *** Validation and error checks for insert', () => {

    it('Rejects event without authorization', async () => {
        const resultOfCall = await handler.createBoostWrapper({ boostType: 'FRAUD' });
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403 });
    });

    it('Rejects all categories except referrals if user is ordinary role', async () => {
        const resultOfCall = await handler.createBoostWrapper(testHelper.wrapEvent({ boostTypeCategory: 'SIMPLE::TIME_LIMITED' }, uuid(), 'ORDINARY_USER' ));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.deep.equal({ statusCode: 403, body: 'Ordinary users cannot create boosts'});
    });

    it('Swallows an error and return its message', async () => {
        const resultOfCall = await handler.createBoostWrapper(testHelper.wrapEvent({ badObject: 'This is bad' }));
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.have.property('statusCode', 500);
    });

});

describe('*** UNIT TEST BOOSTS *** Individual or limited users', () => {

    const referralWindowEnd = moment().add(3, 'months');
    const timeSaveCompleted = moment();
    
    const testReferringUser = uuid();
    const testReferredUser = uuid();

    // IDs for message templates for referrer and referred
    const testReferringMsgId = uuid();
    const testReferredMsgId = uuid();

    const mockBoostToFromPersistence = {
        creatingUserId: uuid(),
        boostType: 'REFERRAL',
        boostCategory: 'USER_CODE_USED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: referralWindowEnd,
        statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
        boostAudience: 'INDIVIDUAL',
        boostAudienceSelection: `whole_universe from #{'{"specific_accounts": ["${testReferringUser}","${testReferredUser}"]}'}`,
        defaultStatus: 'PENDING',
        messageInstructionIds: [
            { accountId: testReferringUser, msgInstructionId: testReferringMsgId, status: 'REDEEMED' }, 
            { accountId: testReferredUser, msgInstructionId: testReferredMsgId, status: 'REDEEMED' }
        ],
        flags: [ 'REDEEM_ALL_AT_ONCE' ]
    };

    it('Happy path inserting a referral-based individual boost', async () => {
        logger('About to create a referral based boost, for two users, ending at: ', referralWindowEnd);

        const testPersistedTime = moment();
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(referralWindowEnd.valueOf()).returns(referralWindowEnd);

        const expectedFromRds = {
            boostId: uuid(),
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 2
        };
        insertBoostStub.resolves(expectedFromRds);

        const testBodyOfEvent = {
            boostTypeCategory: 'REFERRAL::USER_CODE_USED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: referralWindowEnd.valueOf(),
            boostAudience: 'INDIVIDUAL',
            boostAudienceSelection: `whole_universe from #{'{"specific_accounts": ["${testReferringUser}","${testReferredUser}"]}'}`,
            initialStatus: 'PENDING',
            statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
            redemptionMsgInstructions: [
                { accountId: testReferringUser, msgInstructionId: testReferringMsgId}, 
                { accountId: testReferredUser, msgInstructionId: testReferredMsgId }
            ]
        };

        // logger('COPY::::::::::::::::');
        // logger(JSON.stringify(testHelper.wrapEvent(testBodyOfEvent).body));

        const resultOfInstruction = await handler.createBoostWrapper(testHelper.wrapEvent(testBodyOfEvent, 
            mockBoostToFromPersistence.creatingUserId, 'ORDINARY_USER'));

        const bodyOfResult = testHelper.standardOkayChecks(resultOfInstruction);
        expect(bodyOfResult).to.deep.equal(expectedFromRds);

        expect(insertBoostStub).to.have.been.calledWithExactly(mockBoostToFromPersistence);
    });

});

describe('*** UNIT TEST BOOSTS *** General audience', () => {

    beforeEach(() => resetStubs());

    const testRedemptionMsgId = uuid();

    const mockBoostToFromPersistence = {
        creatingUserId: testMktingAdmin,
        boostType: 'SIMPLE',
        boostCategory: 'TIME_LIMITED',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        statusConditions: { REDEEMED: ['save_event_greater_than #{200000::HUNDREDTH_CENT::USD}' ] },
        boostAudience: 'GENERAL',
        boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`,
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
            boostTypeCategory: 'SIMPLE::TIME_LIMITED',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostSource: {
                bonusPoolId: 'primary_bonus_pool',
                clientId: 'some_client_co',
                floatId: 'primary_cash'
            },
            endTimeMillis: testEndTime.valueOf(),
            statusConditions: { REDEEMED: ['save_event_greater_than #{200000::HUNDREDTH_CENT::USD}' ] },
            boostAudience: 'GENERAL',
            boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`,
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

    beforeEach(() => resetStubs());

    const testBoostId = uuid();
    const testMsgInstructId = uuid();
    const testCreatingUserId = uuid();
    
    const testExpiryTime = moment().add(1, 'day');
    const testPersistedTime = moment().add(1, 'second');

    const messageDefinitions = {
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

    const gameParams = {
        gameType: 'CHASE_ARROW',
        timeLimitSeconds: 20,
        winningThreshold: 20,
        instructionBand: 'Tap the screen as many times as you can in 20 seconds',
        entryCondition: "save_event_greater_than #{100000:HUNDREDTH_CENT:USD}"
    };

    const testStatusConditions = {
        OFFERED: ['message_instruction_created'],
        UNLOCKED: ['save_event_greater_than #{100000:HUNDREDTH_CENT:USD}'],
        REDEEMED: ['taps_submitted', 'number_taps_greater_than #{20::20000}']
    };

    // todo: validation that type/category matches game params
    const testBodyOfEvent = {
        creatingUserId: testCreatingUserId,
        boostTypeCategory: 'GAME::TAP_SCREEN',
        boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
        boostSource: {
            bonusPoolId: 'primary_bonus_pool',
            clientId: 'some_client_co',
            floatId: 'primary_cash'
        },
        endTimeMillis: testEndTime.valueOf(),
        boostAudience: 'GENERAL',
        boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`,
        messagesToCreate: messageDefinitions,
        gameParams
    };

    const mockBoostToFromPersistence = {
        creatingUserId: testCreatingUserId,
        boostType: 'GAME',
        boostCategory: 'TAP_SCREEN',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: testStartTime,
        boostEndTime: testEndTime,
        statusConditions: testStatusConditions,
        boostAudience: 'GENERAL',
        boostAudienceSelection: `random_sample #{0.33} from #{'{"clientId": "some_client_co"}'}`,
        defaultStatus: 'CREATED',
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
        messagePayload.audienceType = 'GENERAL';
        messagePayload.selectionInstruction = `match_other from #{entityType: 'boost', entityId: ${testBoostId}}`;
        
        const messageTemplates = Object.keys(messageDefinitions).map((key) => {
            const msgTemplate = messageDefinitions[key];
            msgTemplate.identifier = key;
            msgTemplate.actionToTake = standardMsgActions[key].action;
            msgTemplate.actionContext = { ...standardMsgActions[key].context, gameParams: gameParams };
            return { 'DEFAULT': msgTemplate }
        });

        messagePayload.template = { sequence: messageTemplates };
        return messagePayload;
    };

    const mockMsgInstructReturnBody = [{ instructionId: testMsgInstructId, creationTimeMillis: moment().valueOf() }]
    const mockMsgIdDict = [{ accountId: 'ALL', status: 'ALL', msgInstructionId: testMsgInstructId }];

    // logger('Here is the test event: ', JSON.stringify(testBodyOfEvent));

    it('Happy path creates a game boost, including setting up the messages', async () => {
    
        const mockResultFromRds = {
            boostId: testBoostId,
            persistedTimeMillis: testPersistedTime.valueOf(),
            numberOfUsersEligible: 100
        };

        mockBoostToFromPersistence.boostId = testBoostId;

        momentStub.onFirstCall().returns(testStartTime);
        momentStub.withArgs(testEndTime.valueOf()).returns(testEndTime);
        insertBoostStub.resolves(mockResultFromRds);
        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });
        alterBoostStub.resolves({ updatedTime: moment() });

        const expectedResult = JSON.parse(JSON.stringify(mockResultFromRds));
        expectedResult.messageInstructions = mockMsgIdDict;

        const expectedMsgInstruct = assembleMessageInstruction();

        const resultOfCreate = await handler.createBoost(testBodyOfEvent);
        expect(resultOfCreate).to.exist;
        expect(resultOfCreate).to.deep.equal(expectedResult);

        // then set up invocation checks
        Reflect.deleteProperty(mockBoostToFromPersistence, 'boostId');
        const expectMsgLambdaInvoke = testHelper.wrapLambdaInvoc('message_instruct_create', false, expectedMsgInstruct);
        
        expect(insertBoostStub).to.have.been.calledOnceWithExactly(mockBoostToFromPersistence);
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(expectMsgLambdaInvoke);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly(testBoostId, { messageInstructionIds: { instructions: mockMsgIdDict }});        
        
    });

});