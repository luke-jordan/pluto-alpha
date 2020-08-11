'use strict';

const moment = require('moment');

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

const redemptionHandlerStub = sinon.stub();

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
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiUserStub
    }
});

const { resetStubs, expectNoCalls } = require('./boost.test.helper');

describe('*** UNIT TEST NON-TOURNAMENT EXPIRY ***', () => {

    const testBoostId = 'boost-id-1';
    const ACTIVE_BOOST_STATUS = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING'];

    beforeEach(() => resetStubs(fetchBoostStub, findAccountsStub, updateBoostAccountStub, expireIndividualOffersStub, findUserIdsStub, publishMultiUserStub));

    after(() => sinon.restore());

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

    it('Handles random reward user selection', async () => {
        const mockStatusConditions = {
            PENDING: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
            REDEEMED: ['randomly_chosen_first_N #{3}']
        };

        const mockBoost = {
            boostId: testBoostId,
            boostType: 'SIMPLE',
            boostCategory: 'SIMPLE_SAVE',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000,
            boostStartTime: moment().subtract(1, 'week'),
            boostEndTime: moment(),
            statusConditions: mockStatusConditions,
            flags: ['RANDOM_SELECTION']
        };

        fetchBoostStub.resolves(mockBoost);
        expireWholeBoostStub.resolves(['boost-id-1']);
        updateBoostAccountStub.resolves([{ boostId: 'boost-id-1', accountId: 'account-id-7' }]);
        
        // Lazy loading because stubbing in this way seems to stub across test files. Avoiding interference with other Math.random consumers.
        sinon.restore();
        const mathRandomStub = sinon.stub(Math, 'random');

        const accountsForBoost = { // all
            'account-id-1': { userId: 'user-id-1', status: 'PENDING' },
            'account-id-2': { userId: 'user-id-2', status: 'PENDING' },
            'account-id-3': { userId: 'user-id-3', status: 'PENDING' },
            'account-id-4': { userId: 'user-id-4', status: 'PENDING' },
            'account-id-5': { userId: 'user-id-5', status: 'PENDING' },
            'account-id-6': { userId: 'user-id-6', status: 'PENDING' },
            'account-id-7': { userId: 'user-id-7', status: 'OFFERED' }
        };

        const accountIds = Object.keys(accountsForBoost);

        const randomFloor = 0.01;
        [...Array(accountIds.length).keys()].map((index) => mathRandomStub.onCall(index).returns((index + randomFloor) / 10));

        const formAccountResponse = (accountUserMap) => [{ boostId: testBoostId, accountUserMap }];

        findAccountsStub.onFirstCall().resolves(formAccountResponse(accountsForBoost));

        const userStatus = (index) => ({ userId: `user-id-${index}`, status: 'PENDING' });
        findAccountsStub.onSecondCall().resolves(formAccountResponse({ // winners
            'account-id-4': userStatus(4),
            'account-id-5': userStatus(5),
            'account-id-6': userStatus(6)
        }));

        expireIndividualOffersStub.resolves([]); // just needed to avoid spurious error

        const resultOfSelection = await handler.checkForBoostsToExpire({ boostId: testBoostId });
        
        expect(resultOfSelection).to.deep.equal({ result: 'SUCCESS' });
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly('boost-id-1');

        const winningAccounts = ['account-id-4', 'account-id-5', 'account-id-6'];
        expect(findAccountsStub).to.have.been.calledWithExactly({ boostIds: [testBoostId], status: ['OFFERED', 'PENDING'] });
        expect(findAccountsStub).to.have.been.calledWithExactly({ boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS, accountIds: winningAccounts });


        const redemptionStatus = (index) => ({ ...userStatus(index), newStatus: 'REDEEMED' });
        const mockRedemptionMap = winningAccounts.reduce((obj, accountId, index) => ({ ...obj, [accountId]: redemptionStatus(index + 4) }), {}); 
        expect(redemptionHandlerStub).to.have.been.calledOnceWithExactly({
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: { [testBoostId]: mockRedemptionMap }, 
            event: { eventType: 'BOOST_RANDOM_SELECTED', boostId: testBoostId }
        });

        const expectedUpdate = (newStatus, accounts) => ({ boostId: testBoostId, accountIds: accounts, newStatus, logType: 'STATUS_CHANGE' });

        const expectedRedemptionUpdate = expectedUpdate('REDEEMED', winningAccounts);
        const expectedFailedUpdate = expectedUpdate('FAILED', ['account-id-1', 'account-id-2', 'account-id-3']);
        const expectedExpiredUpdate = expectedUpdate('EXPIRED', ['account-id-7']);

        expect(updateBoostAccountStub).to.have.been.calledWithExactly([expectedRedemptionUpdate]);
        expect(updateBoostAccountStub).to.have.been.calledWithExactly([expectedFailedUpdate, expectedExpiredUpdate]);

        expect(publishMultiUserStub).to.have.been.calledThrice;
        expect(publishMultiUserStub).to.have.been.calledWith(['user-id-4', 'user-id-5', 'user-id-6'], 'BOOST_RANDOM_SELECTED');
        expect(publishMultiUserStub).to.have.been.calledWith(['user-id-1', 'user-id-2', 'user-id-3'], 'BOOST_NOT_SELECTED');
        expect(publishMultiUserStub).to.have.been.calledWith(['user-id-7'], 'BOOST_EXPIRED', { context: { boostId: testBoostId }});
    });

});
