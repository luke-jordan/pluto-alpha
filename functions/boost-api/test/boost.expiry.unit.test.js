'use strict';

// const logger = require('debug')('jupiter:boosts:test');
const uuid = require('uuid/v4');

const testHelper = require('./boost.test.helper');

const sinon = require('sinon');
const chai = require('chai');
const expect = chai.expect;
chai.use(require('sinon-chai'));

const fetchBoostStub = sinon.stub();
const findAccountsStub = sinon.stub();
const findBoostLogsStub = sinon.stub();
const updateBoostAccountStub = sinon.stub();
const updateBoostRedeemedStub = sinon.stub();
const insertBoostLogStub = sinon.stub();

const redemptionHandlerStub = sinon.stub();

const publishMultiUserStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-process-handler', {
    './persistence/rds.boost': {
        'fetchBoost': fetchBoostStub,
        'findAccountsForBoost': findAccountsStub,
        'findLogsForBoost': findBoostLogsStub, 
        'updateBoostAccountStatus': updateBoostAccountStub,
        'updateBoostAmountRedeemed': updateBoostRedeemedStub,
        'insertBoostAccountLogs': insertBoostLogStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiUserStub
    },
    '@noCallThru': true
});

const ACTIVE_BOOST_STATUS = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING'];

const testBoostId = uuid();

describe('*** UNIT TEST BOOST EXPIRY HANDLING', () => {

    beforeEach(() => testHelper.resetStubs(fetchBoostStub, findAccountsStub, updateBoostAccountStub, publishMultiUserStub));

    it('Happy path, awards boost to top two scorers', async () => {

        const testEvent = {
            eventType: 'BOOST_EXPIRED',
            boostId: testBoostId
        };

        const mockBoost = {
            boostId: testBoostId,
            boostType: 'GAME',
            boostCategory: 'TAP_SCREEN',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000,
            fromFloatId: 'test-float',
            fromBonusPoolId: 'test-bonus-pool',
            statusConditions: {
                UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
                PENDING: ['number_taps_greater_than #{0::10000}'],
                REDEEMED: ['number_taps_in_first_N #{2::10000}']
            }
        };

        fetchBoostStub.resolves(mockBoost);

        const mockUserResponseList = [
            { accountId: 'account-id-1', logContext: { numberTaps: 20, timeTakenMillis: 10000 } },
            { accountId: 'account-id-2', logContext: { numberTaps: 10, timeTakenMillis: 10000 } },
            { accountId: 'account-id-3', logContext: { numberTaps: 40, timeTakenMillis: 10000 } }
        ];
        findBoostLogsStub.resolves(mockUserResponseList);

        const formAccountResponse = (accountUserMap) => [{ boostId: testBoostId, accountUserMap }];
        
        // todo : clean up, bit of a mess (should only need one call then pass the map around)
        findAccountsStub.onFirstCall().resolves(formAccountResponse({
            'account-id-3': { userId: 'some-user-id', status: 'PENDING' },
            'account-id-1': { userId: 'some-user-id2', status: 'PENDING' }
        }));
        findAccountsStub.onSecondCall().resolves(formAccountResponse({
            'account-id-2': { userId: 'some-user-id3', status: 'PENDING' },
            'account-id-3': { userId: 'some-user-id', status: 'PENDING' },
            'account-id-1': { userId: 'some-user-id2', status: 'PENDING' },
            'account-id-4': { userId: 'some-user-id4', status: 'PENDING' }
        }));
        findAccountsStub.onThirdCall().resolves(formAccountResponse({
            'account-id-2': { userId: 'some-user-id3', status: 'PENDING' },
            'account-id-4': { userId: 'some-user-id4', status: 'PENDING' }
        }));

        const resultOfExpiry = await handler.processEvent(testEvent);
        expect(resultOfExpiry).to.deep.equal({ statusCode: 200, boostsRedeemed: 2 });

        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);
        expect(findBoostLogsStub).to.have.been.calledOnceWithExactly(testBoostId, 'GAME_RESPONSE');
        
        const expectedFindAccountParams = (accountIds) => ({ boostIds: [testBoostId], accountIds, status: ACTIVE_BOOST_STATUS });
        expect(findAccountsStub).to.have.been.calledThrice;
        expect(findAccountsStub).to.have.been.calledWith(expectedFindAccountParams(['account-id-1', 'account-id-3']));
        expect(findAccountsStub).to.have.been.calledWith({ boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS });
        expect(findAccountsStub).to.have.been.calledWith(expectedFindAccountParams(['account-id-2', 'account-id-4']));

        const expectedRedemptionMap = {
            [testBoostId]: {
                'account-id-3': { userId: 'some-user-id', status: 'PENDING' },
                'account-id-1': { userId: 'some-user-id2', status: 'PENDING' }
            }
        };

        const redemptionEvent = { eventType: 'BOOST_TOURNAMENT_WON', boostId: testBoostId };
        const redemptionCall = { redemptionBoosts: [mockBoost], affectedAccountsDict: expectedRedemptionMap, event: redemptionEvent };
        expect(redemptionHandlerStub).to.have.been.calledOnceWithExactly(redemptionCall);

        const expectedRedemptionUpdate = {
            boostId: testBoostId,
            accountIds: ['account-id-1', 'account-id-3'],
            newStatus: 'REDEEMED',
            logType: 'STATUS_CHANGE'
        };

        const expectedExpiredUpdate = {
            boostId: testBoostId,
            accountIds: ['account-id-2', 'account-id-4'],
            newStatus: 'EXPIRED',
            logType: 'STATUS_CHANGE'
        };

        const expectedLogObject = (accountId, ranking, numberTaps) => ({ 
            boostId: testBoostId,
            accountId,
            logType: 'GAME_OUTCOME',
            logContext: { ranking, numberTaps, topScore: 40 }
        });
        const expectedLogs = [expectedLogObject('account-id-1', 2, 20), expectedLogObject('account-id-2', 3, 10), expectedLogObject('account-id-3', 1, 40)];

        expect(updateBoostAccountStub).to.have.been.calledTwice;
        expect(updateBoostAccountStub).to.have.been.calledWithExactly([expectedRedemptionUpdate]);
        expect(updateBoostAccountStub).to.have.been.calledWithExactly([expectedExpiredUpdate]);

        expect(insertBoostLogStub).to.have.been.calledWithExactly(expectedLogs);

        expect(publishMultiUserStub).to.have.been.calledTwice;
        const publishOptions = { context: { boostId: testBoostId }};
        expect(publishMultiUserStub).to.have.been.calledWithExactly(['some-user-id', 'some-user-id2'], 'BOOST_TOURNAMENT_WON', publishOptions);
        expect(publishMultiUserStub).to.have.been.calledWithExactly(['some-user-id3', 'some-user-id4'], 'BOOST_EXPIRED', publishOptions);
    });

    it('Expires all accounts for non-game boost', async () => {
        const testEvent = {
            eventType: 'BOOST_EXPIRED',
            boostId: testBoostId
        };

        const mockBoost = {
            boostId: testBoostId,
            boostType: 'SIMPLE',
            boostCategory: 'TIME_LIMITED',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000
        };

        fetchBoostStub.resolves(mockBoost);
        findAccountsStub.resolves([{
            boostId: testBoostId,
            accountUserMap: {
                'account-id-1': { userId: 'some-user-id', status: 'OFFERED' },
                'account-id-2': { userId: 'some-user-id2', status: 'OFFERED' }
            }
        }]);

        const resultOfExpiry = await handler.processEvent(testEvent);
        expect(resultOfExpiry).to.exist;
        
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);

        const expectedFindParams = { boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS, accountIds: null };
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(expectedFindParams);

        const expectedExpireInstruct = { boostId: testBoostId, accountIds: ['account-id-1', 'account-id-2'], newStatus: 'EXPIRED', logType: 'STATUS_CHANGE' };
        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedExpireInstruct]);

        expect(publishMultiUserStub).to.have.been.calledOnceWithExactly(['some-user-id', 'some-user-id2'], 'BOOST_EXPIRED', { context: { boostId: testBoostId }});
    });

    it('And the same if no winner (no status conditions)', async () => {
        const testEvent = {
            eventType: 'BOOST_EXPIRED',
            boostId: testBoostId
        };

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

        const resultOfExpiry = await handler.processEvent(testEvent);
        expect(resultOfExpiry).to.exist;
        
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);

        const expectedFindParams = { boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS, accountIds: null };
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(expectedFindParams);

        const expectedExpireInstruct = { boostId: testBoostId, accountIds: ['account-id-1', 'account-id-2'], newStatus: 'EXPIRED', logType: 'STATUS_CHANGE' };
        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedExpireInstruct]);

        expect(publishMultiUserStub).to.have.been.calledOnceWithExactly(['some-user-id', 'some-user-id2'], 'BOOST_EXPIRED', { context: { boostId: testBoostId }});
    });

    it('Also if no one played', async () => {
        const testEvent = {
            eventType: 'BOOST_EXPIRED',
            boostId: testBoostId
        };

        const mockBoost = {
            boostId: testBoostId,
            boostType: 'GAME',
            boostCategory: 'TAP_THE_SCREEN',
            boostCurrency: 'USD',
            boostUnit: 'HUNDREDTH_CENT',
            boostAmount: 50000,
            statusConditions: {
                'OFFERED': ['something'],
                'REDEEMED': ['number_taps_in_first_N #{2::10000}']   
            }
        };

        fetchBoostStub.resolves(mockBoost);
        findBoostLogsStub.resolves([]);

        findAccountsStub.resolves([{
            boostId: testBoostId,
            accountUserMap: {
                'account-id-1': { userId: 'some-user-id', status: 'OFFERED' },
                'account-id-2': { userId: 'some-user-id2', status: 'OFFERED' }
            }
        }]);


        const resultOfExpiry = await handler.processEvent(testEvent);
        expect(resultOfExpiry).to.exist;
        
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);

        const expectedFindParams = { boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS, accountIds: null };
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(expectedFindParams);

        const expectedExpireInstruct = { boostId: testBoostId, accountIds: ['account-id-1', 'account-id-2'], newStatus: 'EXPIRED', logType: 'STATUS_CHANGE' };
        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedExpireInstruct]);

        expect(publishMultiUserStub).to.have.been.calledOnceWithExactly(['some-user-id', 'some-user-id2'], 'BOOST_EXPIRED', { context: { boostId: testBoostId }});
    });

});