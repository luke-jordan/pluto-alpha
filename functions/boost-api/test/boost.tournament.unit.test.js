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
const expireBoostsStub = sinon.stub();
const flipBoostStatusStub = sinon.stub();
const findUsersForAccountsStub = sinon.stub();

const findPooledAccountsStub = sinon.stub();
const updateBoostAmountStub = sinon.stub();

const redemptionHandlerStub = sinon.stub();
const calculateAmountStub = sinon.stub();

const isTournamentFinishedStub = sinon.stub();
const endTournamentStub = sinon.stub();

const publishMultiUserStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../boost-expiry-handler', {
    './persistence/rds.boost': {
        'fetchBoost': fetchBoostStub,
        'findAccountsForBoost': findAccountsStub,
        'findLogsForBoost': findBoostLogsStub, 
        'updateBoostAccountStatus': updateBoostAccountStub,
        'updateBoostAmountRedeemed': updateBoostRedeemedStub,
        'insertBoostAccountLogs': insertBoostLogStub,
        'updateBoostAmount': updateBoostAmountStub,
        'findAccountsForPooledReward': findPooledAccountsStub,
        'endFinishedTournaments': endTournamentStub,
        'isTournamentFinished': isTournamentFinishedStub,
        'expireBoostsPastEndTime': expireBoostsStub,
        'flipBoostStatusPastExpiry': flipBoostStatusStub,
        'findUserIdsForAccounts': findUsersForAccountsStub
    },
    './boost-redemption-handler': {
        'redeemOrRevokeBoosts': redemptionHandlerStub,
        'calculateBoostAmount': calculateAmountStub
    },
    'publish-common': {
        'publishMultiUserEvent': publishMultiUserStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient  
    },
    '@noCallThru': true
});

const ACTIVE_BOOST_STATUS = ['CREATED', 'OFFERED', 'UNLOCKED', 'PENDING'];

const testBoostId = uuid();

describe('*** UNIT TEST BOOST EXPIRY HANDLING', () => {

    beforeEach(() => (testHelper.resetStubs(
        fetchBoostStub, findAccountsStub, findBoostLogsStub, updateBoostAccountStub, redemptionHandlerStub, publishMultiUserStub,
        lamdbaInvokeStub, isTournamentFinishedStub, endTournamentStub, flipBoostStatusStub, findUsersForAccountsStub
    )));

    const formAccountResponse = (accountUserMap) => [{ boostId: testBoostId, accountUserMap }];
    const mockTournamentBoost = (boostCategory, statusConditions) => ({
        boostId: testBoostId,
        boostType: 'GAME',
        boostCategory,
        boostCurrency: 'USD',
        boostUnit: 'HUNDREDTH_CENT',
        boostAmount: 50000,
        fromFloatId: 'test-float',
        fromBonusPoolId: 'test-bonus-pool',
        statusConditions
    });

    const mockAccountUserMap = (indices, status) => indices.reduce((obj, index) => ({
        ...obj, [`account-id-${index}`]: { userId: `some-user-id${index}`, status }
    }), {});

    it('Happy path, awards boost to top two scorers, number taps', async () => {
        const mockBoost = mockTournamentBoost('TAP_SCREEN', {
            UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
            PENDING: ['number_taps_greater_than #{0::10000}'],
            REDEEMED: ['number_taps_in_first_N #{2::10000}']
        });

        fetchBoostStub.resolves(mockBoost);

        const mockUserResponseList = [
            { accountId: 'account-id-1', logContext: { numberTaps: 20, timeTakenMillis: 10000 } },
            { accountId: 'account-id-2', logContext: { numberTaps: 10, timeTakenMillis: 10000 } },
            { accountId: 'account-id-3', logContext: { numberTaps: 40, timeTakenMillis: 10000 } }
        ];
        findBoostLogsStub.resolves(mockUserResponseList);
        
        // todo : clean up, bit of a mess (should only need one call then pass the map around)
        findAccountsStub.onFirstCall().resolves(formAccountResponse({ // winners
            'account-id-3': { userId: 'some-user-id', status: 'PENDING' },
            'account-id-1': { userId: 'some-user-id2', status: 'PENDING' }
        }));
        findAccountsStub.onSecondCall().resolves(formAccountResponse({ // all players
            'account-id-2': { userId: 'some-user-id3', status: 'PENDING' },
            'account-id-3': { userId: 'some-user-id', status: 'PENDING' },
            'account-id-1': { userId: 'some-user-id2', status: 'PENDING' },
            'account-id-4': { userId: 'some-user-id4', status: 'PENDING' }
        }));
        findAccountsStub.onThirdCall().resolves(formAccountResponse({ // losers
            'account-id-2': { userId: 'some-user-id3', status: 'PENDING' },
            'account-id-4': { userId: 'some-user-id4', status: 'PENDING' }
        }));

        const resultOfExpiry = await handler.handleExpiredBoost(testBoostId);
        expect(resultOfExpiry).to.exist;
        expect(resultOfExpiry).to.have.property('statusCode', 200);

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
            logContext: { ranking, numberTaps, accountScore: numberTaps, scoreType: 'NUMBER', topScore: 40 }
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

    it('Also works for percent destroyed tournament', async () => {
        const mockBoost = mockTournamentBoost('DESTROY_IMAGE', {
                UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
                PENDING: ['percent_destroyed_above #{0::10000}'],
                REDEEMED: ['percent_destroyed_in_first_N #{2::10000}']
        });

        fetchBoostStub.resolves(mockBoost);

        const mockUserResponseList = [
            { accountId: 'account-id-1', logContext: { percentDestroyed: 20, timeTakenMillis: 10000 } },
            { accountId: 'account-id-2', logContext: { percentDestroyed: 40, timeTakenMillis: 10000 } },
            { accountId: 'account-id-3', logContext: { percentDestroyed: 10, timeTakenMillis: 10000 } }
        ];
        findBoostLogsStub.resolves(mockUserResponseList);

        findAccountsStub.onFirstCall().resolves(formAccountResponse(mockAccountUserMap([1, 2], 'PENDING'))); // for winners
        findAccountsStub.onSecondCall().resolves(formAccountResponse(mockAccountUserMap([1, 2, 3, 4], 'PENDING'))); // all
        findAccountsStub.onThirdCall().resolves(formAccountResponse(mockAccountUserMap([3, 4], 'PENDING')));

        const resultOfExpiry = await handler.handleExpiredBoost(testBoostId);
        expect(resultOfExpiry).to.exist;
        expect(resultOfExpiry).to.have.property('statusCode', 200);

        // just testing the most important things, rest covered above
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);
        expect(findBoostLogsStub).to.have.been.calledOnceWithExactly(testBoostId, 'GAME_RESPONSE');
        
        const expectedRedemptionMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'some-user-id1', status: 'PENDING' },
                'account-id-2': { userId: 'some-user-id2', status: 'PENDING' }
            }
        };

        const redemptionEvent = { eventType: 'BOOST_TOURNAMENT_WON', boostId: testBoostId };
        const redemptionCall = { redemptionBoosts: [mockBoost], affectedAccountsDict: expectedRedemptionMap, event: redemptionEvent };
        expect(redemptionHandlerStub).to.have.been.calledOnceWithExactly(redemptionCall);

        const expectedRedemptionUpdate = {
            boostId: testBoostId,
            accountIds: ['account-id-1', 'account-id-2'],
            newStatus: 'REDEEMED',
            logType: 'STATUS_CHANGE'
        };

        const expectedExpiredUpdate = {
            boostId: testBoostId,
            accountIds: ['account-id-3', 'account-id-4'],
            newStatus: 'EXPIRED',
            logType: 'STATUS_CHANGE'
        };

        const expectedLogObject = (accountId, ranking, percentDestroyed) => ({ 
            boostId: testBoostId,
            accountId,
            logType: 'GAME_OUTCOME',
            logContext: { ranking, percentDestroyed, accountScore: percentDestroyed, scoreType: 'PERCENT', topScore: 40 }
        });

        const expectedLogs = [
            expectedLogObject('account-id-1', 2, 20), 
            expectedLogObject('account-id-2', 1, 40), 
            expectedLogObject('account-id-3', 3, 10)
        ];

        expect(updateBoostAccountStub).to.have.been.calledTwice;
        expect(updateBoostAccountStub).to.have.been.calledWithExactly([expectedRedemptionUpdate]);
        expect(updateBoostAccountStub).to.have.been.calledWithExactly([expectedExpiredUpdate]);

        expect(insertBoostLogStub).to.have.been.calledWithExactly(expectedLogs);

        // if we reach here then remainder is covered above
        expect(publishMultiUserStub).to.have.been.calledTwice;        
    });

    // note : will also have to do this for random boosts
    it('Sets boost amount to prize, if a pooled reward', async () => {

        const mockBoost = mockTournamentBoost('DESTROY_IMAGE', {
                UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
                PENDING: ['percent_destroyed_above #{0::10000}'],
                REDEEMED: ['percent_destroyed_in_first_N #{2::10000}']
        });

        const mockPoolContrib = 500000; // 50 bucks in bc
        const mockPercentAward = 0.05;

        mockBoost.rewardParameters = {
            rewardType: 'POOLED',
            poolContributionPerUser: { amount: mockPoolContrib, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            percentPoolAsReward: mockPercentAward,
            clientFloatContribution: { type: 'NONE' }
        };

        fetchBoostStub.resolves(mockBoost);

        const mockUserResponseList = [
            { accountId: 'account-id-1', logContext: { percentDestroyed: 20, timeTakenMillis: 10000 } },
            { accountId: 'account-id-2', logContext: { percentDestroyed: 40, timeTakenMillis: 10000 } },
            { accountId: 'account-id-3', logContext: { percentDestroyed: 10, timeTakenMillis: 10000 } }
        ];
        findBoostLogsStub.resolves(mockUserResponseList);

        findAccountsStub.onFirstCall().resolves(formAccountResponse(mockAccountUserMap([1, 2], 'PENDING'))); // for winners
        findAccountsStub.onSecondCall().resolves(formAccountResponse(mockAccountUserMap([1, 2, 3, 4], 'PENDING'))); // all
        findAccountsStub.onThirdCall().resolves(formAccountResponse(mockAccountUserMap([3, 4], 'PENDING')));

        const mockPoolContribMap = { boostId: testBoostId, accountIds: ['account-id-1', 'account-id-2', 'account-id-3']};
        findPooledAccountsStub.resolves(mockPoolContribMap);

        const expectedRewardAmount = 3 * mockPoolContrib * mockPercentAward;
        calculateAmountStub.returns({ boostAmount: expectedRewardAmount });

        const resultOfExpiry = await handler.handleExpiredBoost(testBoostId);
        expect(resultOfExpiry).to.deep.equal({ statusCode: 200, boostsRedeemed: 2 });

        // just testing the most important things, rest covered above
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);
        expect(findBoostLogsStub).to.have.been.calledOnceWithExactly(testBoostId, 'GAME_RESPONSE');
        
        const expectedRedemptionMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'some-user-id1', status: 'PENDING' },
                'account-id-2': { userId: 'some-user-id2', status: 'PENDING' }
            }
        };

        const redemptionEvent = { eventType: 'BOOST_TOURNAMENT_WON', boostId: testBoostId };
        const redemptionCall = { 
            redemptionBoosts: [mockBoost], 
            affectedAccountsDict: expectedRedemptionMap, 
            event: redemptionEvent,
            pooledContributionMap: { [testBoostId]: mockPoolContribMap.accountIds}
        };
        expect(redemptionHandlerStub).to.have.been.calledOnceWithExactly(redemptionCall);

        // everything else is handled above
        expect(updateBoostAmountStub).to.have.been.calledOnceWithExactly(testBoostId, expectedRewardAmount);
    });

    it('Handles case if no one played', async () => {
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


        const resultOfExpiry = await handler.handleExpiredBoost(testBoostId);
        expect(resultOfExpiry).to.exist;
        
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);

        const expectedFindParams = { boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS, accountIds: null };
        expect(findAccountsStub).to.have.been.calledOnceWithExactly(expectedFindParams);

        const expectedExpireInstruct = { boostId: testBoostId, accountIds: ['account-id-1', 'account-id-2'], newStatus: 'EXPIRED', logType: 'STATUS_CHANGE' };
        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedExpireInstruct]);

        expect(publishMultiUserStub).to.have.been.calledOnceWithExactly(['some-user-id', 'some-user-id2'], 'BOOST_EXPIRED', { context: { boostId: testBoostId }});
    });

    it('Handles random reward user selection', async () => {
        const mockBoost = mockTournamentBoost('TAP_SCREEN', {
            UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
            PENDING: ['number_taps_greater_than #{0::10000}'],
            REDEEMED: ['randomly_chosen_first_N #{3}']
        });

        fetchBoostStub.resolves(mockBoost);
        expireBoostsStub.resolves(['boost-id-1']);
        flipBoostStatusStub.resolves([{ boostId: 'boost-id-1', accountId: 'account-id-7' }]);
        findUsersForAccountsStub.resolves('user-id-7');

        // Lazy loading because stubbing in this way seems to stub across test files. Avoiding interference with other Math.random consumers.
        // May need another sinon.restore() at the end of this test suite.
        sinon.restore();
        const mathRandomStub = sinon.stub(Math, 'random');

        const accountsForBoost = { // all
            'account-id-1': { userId: 'user-id-1', status: 'PENDING' },
            'account-id-2': { userId: 'user-id-2', status: 'PENDING' },
            'account-id-3': { userId: 'user-id-3', status: 'PENDING' },
            'account-id-4': { userId: 'user-id-4', status: 'PENDING' },
            'account-id-5': { userId: 'user-id-5', status: 'PENDING' },
            'account-id-6': { userId: 'user-id-6', status: 'PENDING' }
        };

        const accountIds = Object.keys(accountsForBoost);

        const randomFloor = 0.01;
        [...Array(accountIds.length).keys()].map((index) => mathRandomStub.onCall(index).returns((index + randomFloor) / 10));
        
        findAccountsStub.onFirstCall().resolves(formAccountResponse(accountsForBoost));

        findAccountsStub.onSecondCall().resolves(formAccountResponse({ // winners
            'account-id-5': { userId: 'user-id-5', status: 'PENDING' },
            'account-id-1': { userId: 'user-id-1', status: 'PENDING' },
            'account-id-3': { userId: 'user-id-3', status: 'PENDING' }
        }));

        findAccountsStub.onThirdCall().resolves(formAccountResponse({ // losers
            'account-id-2': { userId: 'user-id-2', status: 'PENDING' },
            'account-id-4': { userId: 'user-id-4', status: 'PENDING' },
            'account-id-6': { userId: 'user-id-6', status: 'PENDING' }
        }));

        const resultOfSelection = await handler.checkForBoostsToExpire({ boostId: testBoostId });
        
        expect(resultOfSelection).to.deep.equal({ result: 'SUCCESS' });
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly('boost-id-1');

        const winningAccounts = ['account-id-4', 'account-id-5', 'account-id-6'];
        expect(findAccountsStub).to.have.been.calledWithExactly({ boostIds: [testBoostId], status: ['PENDING'] });
        expect(findAccountsStub).to.have.been.calledWithExactly({ boostIds: [testBoostId], status: ACTIVE_BOOST_STATUS, accountIds: winningAccounts });

        const expectedRedemptionUpdate = {
            boostId: testBoostId,
            accountIds: winningAccounts,
            newStatus: 'REDEEMED',
            logType: 'STATUS_CHANGE'
        };

        expect(updateBoostAccountStub).to.have.been.calledOnceWithExactly([expectedRedemptionUpdate]);
        expect(flipBoostStatusStub).to.have.been.calledOnceWithExactly();
        expect(findUsersForAccountsStub).to.have.have.been.calledOnceWithExactly(['account-id-7'], true);
    });

});
