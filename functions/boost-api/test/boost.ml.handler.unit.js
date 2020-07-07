'use strict';

const logger = require('debug')('jupiter:boosts:test');

const moment = require('moment');
const uuid = require('uuid/v4');

// const helper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
// const expect = chai.expect;
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const proxyquire = require('proxyquire').noCallThru();

const momentStub = sinon.stub();
const tinyGetStub = sinon.stub();
const findUserIdsStub = sinon.stub();
const updateStatusStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const fetchMlBoostsStub = sinon.stub();
const fetchAudienceStub = sinon.stub();
const accountStatusStub = sinon.stub();
const extractAccountIdsStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../boost-ml-handler', {
    './persistence/rds.boost': {
        'fetchActiveMlBoosts': fetchMlBoostsStub,
        'fetchBoostAudience': fetchAudienceStub,
        'extractAccountIds': extractAccountIdsStub,
        'findUserIdsForAccounts': findUserIdsStub,
        'fetchBoostAccountStatuses': accountStatusStub,
        'updateBoostAccountStatus': updateStatusStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    'tiny-json-http': {
        'get': tinyGetStub,
        '@noCallThru': true
    },
    'moment': momentStub,
    '@noCallThru': true
});

describe('*** UNIT TEST BOOST ML HANDLER ***', () => {
    const testStartTime = moment();
    const testEndTime = moment().add(3, 'months');
    const testUpdatedTime = moment().format();

    const testBoostId = uuid();
    const testAudienceId = uuid();
  
    const testCreatingUserId = uuid();
    const testReferringUser = uuid();
    const testReferredUser = uuid();

    const testReferringMsgId = uuid();
    const testReferredMsgId = uuid();

    const mockMlBoostFromRds = {
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
        boostEndTime: testEndTime,
        statusConditions: { REDEEMED: [`save_completed_by #{${testReferredUser}}`, `first_save_by #{${testReferredUser}}`] },
        boostAudienceType: 'INDIVIDUAL',
        audienceId: testAudienceId,
        defaultStatus: 'PENDING',
        mlPullParameters: {
            onlyOfferOnce: true,
            minDaysBetweenBoosts: 30,
            maxPortionOfAudience: 0.2
        },
        messageInstructionIds: [
            { accountId: testReferringUser, msgInstructionId: testReferringMsgId, status: 'REDEEMED' }, 
            { accountId: testReferredUser, msgInstructionId: testReferredMsgId, status: 'REDEEMED' }
        ],
        flags: ['REDEEM_ALL_AT_ONCE']
    };

    const mockBoostAccountStatus = (accountId, boostStatus) => ({
        boostId: testBoostId,
        accountId,
        boostStatus
    });

    it('Handles once-off machined determined boost offerings', async () => {
        const mockAccountIds = ['account-id-1', 'account-id-2'];
        
        const firstAccStatus = mockBoostAccountStatus('account-id-1', 'CREATED');
        const secondAccStatus = mockBoostAccountStatus('account-id-2', 'OFFERED');

        lamdbaInvokeStub.returns({ promise: () => ({ Payload: JSON.stringify({ 
            body: JSON.stringify({ result: 'Refreshed audience successfully, audience currently has 144 members' })
        })})});

        updateStatusStub.resolves([{ boostId: testBoostId, updatedTime: testUpdatedTime }]);
        accountStatusStub.resolves([firstAccStatus, secondAccStatus]);
        fetchMlBoostsStub.resolves([mockMlBoostFromRds]);
        extractAccountIdsStub.resolves(mockAccountIds);
        findUserIdsStub.resolves({ 'user-id-1': 'account-id-1' });
        tinyGetStub.resolves(['user-id-1']);

        const resultOfBoost = await handler.processMlBoosts({});
        logger('Result:', resultOfBoost);
    });

    // it('Handles recurring machine determined boost offerings', async () => {

    // });
});
