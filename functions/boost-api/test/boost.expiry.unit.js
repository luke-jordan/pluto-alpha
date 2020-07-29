
'use strict';

const { resetStubs, expectNoCalls } = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const fetchBoostStub = sinon.stub();
const expireWholeBoostStub = sinon.stub();
const endFinishedTournsStub = sinon.stub();
const expireIndividualOffersStub = sinon.stub();

const findAccountsStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const findBoostLogsStub = sinon.stub();
const findUserIdsStub = sinon.stub();

const publishMultiUserStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-expiry-handler', {
    './persistence/rds.boost': {
        'fetchBoost': fetchBoostStub,
        'expireBoostsPastEndTime': expireWholeBoostStub,
        'endFinishedTournaments': endFinishedTournsStub,
        'findAccountsForBoost': findAccountsStub,
        'updateBoostAccountStatus': updateBoostAccountStub,
        'findLogsForBoost': findBoostLogsStub,
        'flipBoostStatusPastExpiry': expireIndividualOffersStub,
        'findUserIdsForAccounts': findUserIdsStub
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiUserStub
    }
});

describe('*** UNIT TEST NON-TOURNAMENT EXPIRY ***', () => {

    const testBoostId = 'boost-id-1';
    const ACTIVE_BOOST_STATUS = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING'];

    beforeEach(() => resetStubs(fetchBoostStub, findAccountsStub, updateBoostAccountStub, expireIndividualOffersStub, findUserIdsStub, publishMultiUserStub));

    it('Expires all accounts for non-game boost', async () => {
        const mockBoost = {
            boostId: testBoostId,
            boostType: 'SIMPLE',
            boostCategory: 'SIMPLE_SAVE',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000,
            statusConditions: {
                REDEEMED: ['something']
            }
        };

        // so these two do not run (covered elsewhere)
        endFinishedTournsStub.resolves({}); 
        expireIndividualOffersStub.resolves([]);

        expireWholeBoostStub.resolves([testBoostId]);
        fetchBoostStub.resolves(mockBoost);
        
        findAccountsStub.resolves([{
            boostId: testBoostId,
            accountUserMap: {
                'account-id-1': { userId: 'some-user-id', status: 'OFFERED' },
                'account-id-2': { userId: 'some-user-id2', status: 'OFFERED' }
            }
        }]);

        const resultOfExpiry = await handler.checkForBoostsToExpire({});
        expect(resultOfExpiry).to.exist;
        
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);

        const expectedFindParams = { boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS, accountIds: null };
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(expectedFindParams);

        const expectedExpireInstruct = { boostId: testBoostId, accountIds: ['account-id-1', 'account-id-2'], newStatus: 'EXPIRED', logType: 'STATUS_CHANGE' };
        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedExpireInstruct]);

        expect(publishMultiUserStub).to.have.been.calledOnceWithExactly(['some-user-id', 'some-user-id2'], 'BOOST_EXPIRED', { context: { boostId: testBoostId }});
    });

    it('And the same if no winner (no status conditions)', async () => {
        const mockBoost = {
            boostId: testBoostId,
            boostType: 'GAME',
            boostCategory: 'TAP_THE_SCREEN',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000,
            statusConditions: {
                'OFFERED': ['something']
            }
        };

        fetchBoostStub.resolves(mockBoost);
        findAccountsStub.resolves([{
            boostId: testBoostId,
            accountUserMap: {
                'account-id-1': { userId: 'some-user-id', status: 'OFFERED' },
                'account-id-2': { userId: 'some-user-id2', status: 'OFFERED' }
            }
        }]);

        const resultOfExpiry = await handler.handleExpiredBoost(testBoostId);
        expect(resultOfExpiry).to.exist;
        
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);

        const expectedFindParams = { boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS, accountIds: null };
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(expectedFindParams);

        const expectedExpireInstruct = { boostId: testBoostId, accountIds: ['account-id-1', 'account-id-2'], newStatus: 'EXPIRED', logType: 'STATUS_CHANGE' };
        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedExpireInstruct]);

        expect(publishMultiUserStub).to.have.been.calledOnceWithExactly(['some-user-id', 'some-user-id2'], 'BOOST_EXPIRED', { context: { boostId: testBoostId }});
    });

    it('Handles individualized boosts', async () => {
        
        expireIndividualOffersStub.resolves([
            { accountId: 'account-1', boostId: 'boost-1' },
            { accountId: 'account-2', boostId: 'boost-1' },
            { accountId: 'account-3', boostId: 'boost-2' }
        ]);

        findUserIdsStub.resolves({ 'account-1': 'user-1', 'account-2': 'user-2', 'account-3': 'user-3' });

        const expiryResult = await handler.expireIndividualizedBoosts();
        
        expect(expiryResult).to.deep.equal({
            result: 'SUCCESS',
            boostsExpired: 2,
            offersExpired: 3
        });

        expect(expireIndividualOffersStub).to.have.been.calledOnceWithExactly();
        expect(findUserIdsStub).to.have.been.calledOnceWithExactly(['account-1', 'account-2', 'account-3'], true);

        expect(publishMultiUserStub).to.have.been.calledTwice;
        expect(publishMultiUserStub).to.have.been.calledWith(['user-1', 'user-2'], 'BOOST_EXPIRED', { context: { boostId: 'boost-1' }});
        expect(publishMultiUserStub).to.have.been.calledWith(['user-3'], 'BOOST_EXPIRED', { context: { boostId: 'boost-2' }});
    });

    it('Skips expiring boosts with individualized expiry', async () => {
        const mockBoost = {
            boostId: testBoostId,
            boostType: 'SIMPLE',
            boostCategory: 'SIMPLE_SAVE',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000,
            statusConditions: { REDEEMED: ['something'] },
            expiryParameters: {
                individualizedExpiry: true
            }
        };

        fetchBoostStub.resolves(mockBoost);

        const resultOfExpiry = await handler.handleExpiredBoost(testBoostId);
        expect(resultOfExpiry).to.deep.equal({ resultCode: 200, body: 'Not a game, or no responses' });
        
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);
        expectNoCalls(findAccountsStub, findUserIdsStub, updateBoostAccountStub, publishMultiUserStub);
    });

    it('Runs through all tasks, even if empty', async () => {
        endFinishedTournsStub.resolves({}); 
        expireWholeBoostStub.resolves([]);
        expireIndividualOffersStub.resolves([]);

        const resultOfAll = await handler.checkForBoostsToExpire({});
        expect(resultOfAll).to.deep.equal({ result: 'SUCCESS' });
        
        expectNoCalls(fetchBoostStub, findAccountsStub, findUserIdsStub, updateBoostAccountStub, publishMultiUserStub);
    });

});
