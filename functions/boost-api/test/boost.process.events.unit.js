'use strict';

const moment = require('moment');
const uuid = require('uuid/v4');

const helper = require('./boost.test.helper');

const { ACTIVE_BOOST_STATUS } = require('../boost.util');

// testing more background events, like friendships, and so forth, and leaving boost.process.unit for user-driven
const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const findBoostStub = sinon.stub();
const getAccountIdStub = sinon.stub();
const findAccountsToRedeemStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const updateBoostRedemptionStub = sinon.stub();
const fetchUncreatedBoostStub = sinon.stub();

const redemptionHandlerStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-event-handler', {
    './persistence/rds.boost': {
        'findBoost': findBoostStub,
        'getAccountIdForUser': getAccountIdStub,
        'findAccountsForBoost': findAccountsToRedeemStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'updateBoostAmountRedeemed': updateBoostRedemptionStub,
        'fetchUncreatedActiveBoostsForAccount': fetchUncreatedBoostStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub
    }
});

describe('*** UNIT TEST FRIEND BOOST ***', () => {

    const mockBoostId = uuid();
    const mockCreatedMoment = moment().subtract(1, 'day');

    const mockBoost = {
        boostId: mockBoostId,
        boostType: 'SOCIAL',
        boostCategory: 'NUMBER_FRIENDS',
        boostAmount: 100000,
        boostUnit: 'HUNDREDTH_CENT',
        boostCurrency: 'USD',
        fromBonusPoolId: 'primary_bonus_pool',
        fromFloatId: 'primary_cash',
        forClientId: 'some_client_co',
        boostStartTime: mockCreatedMoment,
        boostEndTime: moment().add(5, 'days'),
        statusConditions: { REDEEMED: [`friends_added_since #{3::${mockCreatedMoment.valueOf()}}`] },
        boostAudience: 'GENERAL'
    };

    it('Processes a friend number boost correctly', async () => {
        const mockUserId = uuid();
        const mockAccountId = uuid();

        const mockFriend = (createdDaysAgo) => ({ relationshipId: uuid(), creationTimeMillis: moment().subtract(createdDaysAgo, 'days').valueOf() });

        const testEvent = {
            userId: mockUserId,
            eventType: 'FRIEND_REQUEST_TARGET_ACCEPTED',
            eventContext: { friendshipList: [mockFriend(0), mockFriend(1), mockFriend(1)] }
        };

        getAccountIdStub.resolves(mockAccountId);
        findBoostStub.resolves([mockBoost]);
        const mockAccountMap = { [mockAccountId]: { userId: mockUserId, status: 'OFFERED' }};
        findAccountsToRedeemStub.resolves([{ 
            boostId: mockBoostId,
            accountUserMap: mockAccountMap
        }]);
        redemptionHandlerStub.resolves({ [mockBoostId]: { result: 'SUCCESS' }});
        updateBoostAccountStub.resolves([{ boostId: mockBoostId, updatedTime: moment() }]);

        fetchUncreatedBoostStub.resolves([]); // as not tested here

        const result = await handler.handleBatchOfQueuedEvents(helper.composeSqsBatch([testEvent]));
        expect(result).to.exist; 

        expect(getAccountIdStub).to.have.been.calledOnceWithExactly(mockUserId);
        expect(findBoostStub).to.have.been.calledOnce; // key assembly tested in user processing
        expect(findAccountsToRedeemStub).to.have.been.calledOnceWithExactly({ // but this one is important, so keep 
            boostIds: [mockBoostId], status: ACTIVE_BOOST_STATUS, accountIds: [mockAccountId] 
        });

        // likewise
        const expectedRedemptionCall = {
            redemptionBoosts: [mockBoost], 
            revocationBoosts: [], 
            affectedAccountsDict: { [mockBoostId]: mockAccountMap }, 
            event: { ...testEvent, accountId: mockAccountId }
        };

        expect(redemptionHandlerStub).to.have.been.calledOnce;
        // helper.logNestedMatches(expectedRedemptionCall, redemptionHandlerStub.getCall(0).args[0]);
        expect(redemptionHandlerStub).to.have.been.calledOnceWithExactly(expectedRedemptionCall);
        
        const expectedBoostUpdate = {
            boostId: mockBoostId,
            accountIds: [mockAccountId],
            newStatus: 'REDEEMED',
            stillActive: true,
            logType: 'STATUS_CHANGE',
            logContext: { newStatus: 'REDEEMED', boostAmount: 100000 }
        };
        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedBoostUpdate]);
        expect(updateBoostRedemptionStub).to.have.been.calledOnce; // also sufficiently covered elsewhere
    });

});
