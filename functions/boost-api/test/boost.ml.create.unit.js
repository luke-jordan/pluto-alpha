'use strict';

// const logger = require('debug')('jupiter:boosts:test');

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
const testAudienceId = uuid();

describe('*** UNIT TEST BOOST CREATION *** Persists ML params', () => {

    const referralWindowEnd = moment().add(3, 'months');
    
    const testReferringUser = uuid();
    const testReferredUser = uuid();

    const testReferringMsgId = uuid();
    const testReferredMsgId = uuid();

    const testCreatingUserId = uuid();

    const testClientId = 'some_client_co';

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
        }
    };

    // todo: cuse game boost instead
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
        mlParameters: {
            maxPortionOfAudience: 0.2,
            minIntervalBetweenRuns: { unit: "days", value: 30 }
        },
        messageInstructionIds: [
            { accountId: testReferringUser, msgInstructionId: testReferringMsgId, status: 'REDEEMED' }, 
            { accountId: testReferredUser, msgInstructionId: testReferredMsgId, status: 'REDEEMED' }
        ],
        flags: ['REDEEM_ALL_AT_ONCE']
    };

    beforeEach(() => resetStubs());

    // ML boost creation is similar to any other boost creation, the key differences being the inclusion of 
    // mlBoostParameters in the event body and the presentationType 'MACHINE_DETERMINED' in messagesToCreate
    it('Happy path inserting a referral-based individual boost with ml params', async () => {
        const testPersistedTime = moment();
        momentStub.withArgs().returns(testStartTime);
        momentStub.withArgs(referralWindowEnd.valueOf()).returns(referralWindowEnd);

        const testCreatedAudienceId = uuid();
        lamdbaInvokeStub.onFirstCall().returns({ promise: () => ({ Payload: JSON.stringify({ 
            body: JSON.stringify({ audienceId: testCreatedAudienceId })
        })})});

        lamdbaInvokeStub.onSecondCall().returns({ promise: () => ({ Payload: JSON.stringify({ 
            body: JSON.stringify({ message: { instructionId: testReferringMsgId } })
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
            messagesToCreate: [{
                boostStatus: 'ALL',
                presentationType: 'MACHINE_DETERMINED',
                template: messageTemplates.OFFERED
            }],
            mlParameters: {
                maxPortionOfAudience: 0.20,
                minIntervalBetweenRuns: { unit: 'days', value: 30 }
            },
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
                conditions: testBodyOfEvent.boostAudienceSelection.conditions
            }
        };
        const audienceInvocation = testHelper.wrapLambdaInvoc('audience_selection', false, expectedAudiencePayload);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(audienceInvocation);

        const expectedInstructionPayload = {
            actionToTake: 'ADD_CASH',
            audienceType: 'INDIVIDUAL',
            boostStatus: 'ALL',
            creatingUserId: testCreatingUserId,
            endTime: referralWindowEnd.format(),
            messagePriority: 100,
            presentationType: 'MACHINE_DETERMINED',
            templates: {
                template: {
                    DEFAULT: {
                        actionContext: { boostId: expectedFromRds.boostId },
                        ...messageTemplates.OFFERED
                    }
                }
            }
        };
        const msgInstructionInvocation = testHelper.wrapLambdaInvoc('message_instruct_create', false, expectedInstructionPayload);
        expect(lamdbaInvokeStub).to.have.been.calledWithExactly(msgInstructionInvocation);

        const expectedBoost = { ...mockBoostToFromPersistence };
        expectedBoost.audienceId = testCreatedAudienceId;
        expect(insertBoostStub).to.have.been.calledWithExactly(expectedBoost);

        expect(findUserIdsStub).to.have.been.calledWithExactly([testReferringUser, testReferredUser]);
        const expectedBoostAmount = { boostAmount: 100000, boostUnit: 'HUNDREDTH_CENT', boostCurrency: 'USD' };
        const expectedUserLogOptions = {
            initiator: testCreatingUserId,
            context: {
                boostType: 'REFERRAL', boostCategory: 'USER_CODE_USED', boostId: expectedFromRds.boostId, ...expectedBoostAmount,
                boostStartTime: testStartTime.valueOf(), boostEndTime: referralWindowEnd.valueOf(), gameParams: undefined,
                rewardParameters: undefined, statusConditions: mockBoostToFromPersistence.statusConditions
            }
        };
        expect(publishMultiStub).to.have.been.calledOnceWithExactly(['user-id-1', 'user-id-2'], 'BOOST_CREATED_REFERRAL', expectedUserLogOptions);
    });

});
