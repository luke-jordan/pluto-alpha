'use strict';

const moment = require('moment');

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

const resetStubs = () => testHelper.resetStubs(insertBoostStub, findBoostStub, findAccountsStub, 
    updateBoostAccountStub, alterBoostStub, lamdbaInvokeStub, publishMultiStub, momentStub);

const testStartTime = moment();

const testClientId = 'some_client_co';
const mockBoostSource = { bonusPoolId: 'primary_bonus_pool', clientId: testClientId, floatId: 'primary_cash' };

describe('** UNIT TEST CREATING AN ML DETERMINED BOOST ***', () => {

    beforeEach(() => resetStubs());

    it('Unit test creating ML boost, happy path, sets up messages etc, but _does not fire_', async () => {

        const mockEndTime = moment().add(1, 'day').endOf('day');
        const mockAccountIds = ['account-1', 'account-2'];
        const mockUserIds = ['user-1', 'user-2'];

        const msgTemplate = { display: { type: 'CARD' }, title: 'Please save', body: 'Save now thanks' };

        const testBodyOfEvent = {
            creatingUserId: 'some-admin-user',
            label: 'Save today!',
            boostTypeCategory: 'SIMPLE::SIMPLE_SAVE',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: '10000000::HUNDREDTH_CENT::USD',
            boostSource: mockBoostSource,
            endTimeMillis: mockEndTime.valueOf(),
            boostAudienceType: 'ML_DETERMINED',
            audienceId: 'selection-universe-id',
            initialStatus: 'CREATED',
            statusConditions: { REDEEMED: ['save_event_greater_than #{100::WHOLE_CURRENCY::USD}'] },
            messagesToCreate: [{
                boostStatus: 'OFFERED', presentationType: 'ML_DETERMINED', isMessageSequence: false, template: msgTemplate
            }],
            flags: ['ML_DETERMINED']
        };
        
        momentStub.onFirstCall().returns(testStartTime);
        momentStub.withArgs(mockEndTime.valueOf()).returns(mockEndTime);

        // most of the items in here are amply tested elsewhere, so testing those that are important on this route only       
        const mockResultFromRds = { boostId: 'test-boost-id', accountIds: mockAccountIds };
        insertBoostStub.resolves(mockResultFromRds);

        findUserIdsStub.resolves(mockUserIds);

        const mockMsgInstructReturnBody = {
            processResult: 'INSTRUCT_STORED',
            message: { instructionId: 'created-msg-instruction-id', creationTimeMillis: moment().valueOf() }
        };
    
        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });
        alterBoostStub.resolves({ updatedTime: moment() });

        const mockMsgIdDict = [{ accountId: 'ALL', status: 'OFFERED', msgInstructionId: 'created-msg-instruction-id' }];
        const expectedResult = { ...mockResultFromRds, messageInstructions: mockMsgIdDict };

        // now we do the call
        const resultOfCreate = await handler.createBoost(testBodyOfEvent);
        expect(resultOfCreate).to.exist;
        expect(resultOfCreate).to.deep.equal(expectedResult);

        // then set up invocation checks
        const expectedBoostToRds = {
            creatingUserId: 'some-admin-user',
            label: 'Save today!',
            boostType: 'SIMPLE',
            boostCategory: 'SIMPLE_SAVE',
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            boostBudget: 10000000,
            fromBonusPoolId: 'primary_bonus_pool',
            fromFloatId: 'primary_cash',
            forClientId: 'some_client_co',
            boostStartTime: testStartTime,
            boostEndTime: mockEndTime,
            statusConditions: { REDEEMED: ['save_event_greater_than #{100::WHOLE_CURRENCY::USD}'] },
            boostAudienceType: 'ML_DETERMINED',
            audienceId: 'selection-universe-id',
            defaultStatus: 'CREATED',
            messageInstructionIds: [],
            flags: ['ML_DETERMINED']
        };

        expect(insertBoostStub).to.have.been.calledOnceWithExactly(expectedBoostToRds);

        const expectedMsgInstruct = {
            creatingUserId: 'some-admin-user',
            boostStatus: 'OFFERED',
            audienceType: 'ML_DETERMINED',
            presentationType: 'ML_DETERMINED',
            holdFire: true,
            audienceId: 'selection-universe-id',
            endTime: mockEndTime.format(),
            messagePriority: 100,
            templates: { template: { 'DEFAULT': msgTemplate } }
        };

        const lambdaPayload = JSON.parse(lamdbaInvokeStub.getCall(0).args[0].Payload);
        
        expect(lambdaPayload).to.deep.equal(expectedMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly('test-boost-id', mockMsgIdDict, false);

        // point here is _only_ created is called
        expect(publishMultiStub).to.have.been.calledOnceWith(mockUserIds, 'BOOST_CREATED_SIMPLE');
    });
    
});

describe('** UNIT TEST CREATING AN EVENT TRIGGERED BOOST ***', () => {

    beforeEach(() => resetStubs());

    it('Unit test creating event boost, does not insert accounts, does not trigger messages', async () => {

        const mockEndTime = moment().add(1, 'day').endOf('day');
        const mockAccountIds = ['account-1', 'account-2'];
        const mockUserIds = ['user-1', 'user-2'];

        const msgTemplate = { display: { type: 'CARD' }, title: 'Please save', body: 'Save now thanks' };
        const msgTrigger = { triggerEvent: 'USER_ACCOUNT_OPENED' };

        const mockConditions = { 
            OFFERED: ['event_occurs #{USER_CREATED_ACCOUNT}'], 
            REDEEMED: ['save_event_greater_than #{100::WHOLE_CURRENCY::USD}'] 
        };

        const testBodyOfEvent = {
            creatingUserId: 'some-admin-user',
            label: 'Save today!',
            boostTypeCategory: 'SIMPLE::SIMPLE_SAVE',
            boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
            boostBudget: '10000000::HUNDREDTH_CENT::USD',
            boostSource: mockBoostSource,
            endTimeMillis: mockEndTime.valueOf(),
            boostAudienceType: 'EVENT_DRIVEN',
            audienceId: 'selection-universe-id',
            initialStatus: 'UNCREATED',
            statusConditions: mockConditions,
            messagesToCreate: [{
                boostStatus: 'OFFERED', presentationType: 'EVENT_DRIVEN', triggerParameters: msgTrigger, template: msgTemplate, isMessageSequence: false
            }],
            flags: ['EVENT_DRIVEN']
        };
        
        momentStub.onFirstCall().returns(testStartTime);
        momentStub.withArgs(mockEndTime.valueOf()).returns(mockEndTime);

        // most of the items in here are amply tested elsewhere, so testing those that are important on this route only       
        const mockResultFromRds = { boostId: 'test-boost-id', accountIds: mockAccountIds };
        insertBoostStub.resolves(mockResultFromRds);

        findUserIdsStub.resolves(mockUserIds);

        const mockMsgInstructReturnBody = {
            processResult: 'INSTRUCT_STORED',
            message: { instructionId: 'created-msg-instruction-id', creationTimeMillis: moment().valueOf() }
        };
    
        lamdbaInvokeStub.returns({ promise: () => testHelper.mockLambdaResponse(mockMsgInstructReturnBody) });
        alterBoostStub.resolves({ updatedTime: moment() });

        const mockMsgIdDict = [{ accountId: 'ALL', status: 'OFFERED', msgInstructionId: 'created-msg-instruction-id' }];
        const expectedResult = { ...mockResultFromRds, messageInstructions: mockMsgIdDict };

        // now we do the call
        const resultOfCreate = await handler.createBoost(testBodyOfEvent);
        expect(resultOfCreate).to.exist;
        expect(resultOfCreate).to.deep.equal(expectedResult);

        // then set up invocation checks
        const expectedBoostToRds = {
            creatingUserId: 'some-admin-user',
            label: 'Save today!',
            boostType: 'SIMPLE',
            boostCategory: 'SIMPLE_SAVE',
            boostAmount: 100000,
            boostUnit: 'HUNDREDTH_CENT',
            boostCurrency: 'USD',
            boostBudget: 10000000,
            fromBonusPoolId: 'primary_bonus_pool',
            fromFloatId: 'primary_cash',
            forClientId: 'some_client_co',
            boostStartTime: testStartTime,
            boostEndTime: mockEndTime,
            statusConditions: mockConditions,
            boostAudienceType: 'EVENT_DRIVEN',
            audienceId: 'selection-universe-id',
            defaultStatus: null, // i.e., none, because set by event in status conditions
            messageInstructionIds: [],
            flags: ['EVENT_DRIVEN']
        };

        expect(insertBoostStub).to.have.been.calledOnceWithExactly(expectedBoostToRds);

        const expectedMsgInstruct = {
            creatingUserId: 'some-admin-user',
            boostStatus: 'OFFERED',
            audienceType: 'EVENT_DRIVEN',
            presentationType: 'EVENT_DRIVEN',
            holdFire: true,
            audienceId: 'selection-universe-id',
            endTime: mockEndTime.format(),
            messagePriority: 100,
            templates: { template: { 'DEFAULT': msgTemplate } },
            triggerParameters: msgTrigger
        };

        const lambdaPayload = JSON.parse(lamdbaInvokeStub.getCall(0).args[0].Payload);
        
        expect(lambdaPayload).to.deep.equal(expectedMsgInstruct);
        expect(alterBoostStub).to.have.been.calledOnceWithExactly('test-boost-id', mockMsgIdDict, false);

        // point here is _only_ created is called
        expect(publishMultiStub).to.not.have.been.called;
    });
    
});

describe('** UNIT TEST SOME BOOST VALIDATION ***', () => {

    beforeEach(() => resetStubs());

    const testBodyOfEvent = {
        label: 'Midweek Catch Arrow',
        creatingUserId: 'some-admin-user',
        boostTypeCategory: 'GAME::CHASE_ARROW',
        boostAmountOffered: '100000::HUNDREDTH_CENT::USD',
        boostBudget: '10000000::HUNDREDTH_CENT::USD',
        boostSource: {
            bonusPoolId: 'primary_bonus_pool',
            clientId: 'some_client_co',
            floatId: 'primary_cash'
        },
        endTimeMillis: moment().add(1, 'day').valueOf(),
        boostAudienceType: 'GENERAL',
        audienceId: 'audience-id',
        messagesToCreate: [],
        gameParams: { gameType: 'CHASE_ARROW' }
    };

    const commonAssertions = () => {
        expect(insertBoostStub).to.have.not.been.called;
        expect(alterBoostStub).to.have.not.been.called;
        expect(lamdbaInvokeStub).to.have.not.been.called;
    };

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

        testEventBody.boostTypeCategory = 'REFERRAL::SIMPLE_SAVE';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith(expectedError);
        commonAssertions();

        testEventBody.boostTypeCategory = 'GAME::TAP_SCREEN';
        await expect(handler.createBoost(testEventBody)).to.be.rejectedWith('Boost category must match game type where boost type is GAME');
        commonAssertions();
    });

});
