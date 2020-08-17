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

describe('*** UNIT TEST BOOST TOURNAMENT END HANDLING', () => {

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

        redemptionHandlerStub.resolves({ [testBoostId]: { boostAmount: mockBoost.boostAmount, unit: mockBoost.boostUnit }});

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
                'account-id-3': { userId: 'some-user-id', status: 'PENDING', newStatus: 'REDEEMED' },
                'account-id-1': { userId: 'some-user-id2', status: 'PENDING', newStatus: 'REDEEMED' }
            }
        };

        const redemptionEvent = { eventType: 'BOOST_TOURNAMENT_WON', boostId: testBoostId };
        const redemptionCall = { redemptionBoosts: [mockBoost], affectedAccountsDict: expectedRedemptionMap, event: redemptionEvent };
        expect(redemptionHandlerStub).to.have.been.calledOnceWithExactly(redemptionCall);

        const expectedRedemptionUpdate = {
            boostId: testBoostId,
            accountIds: ['account-id-1', 'account-id-3'],
            newStatus: 'REDEEMED',
            logType: 'STATUS_CHANGE',
            logContext: { amountAwarded: { amount: mockBoost.boostAmount, unit: 'HUNDREDTH_CENT', currency: 'USD' } }
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

    it('Also works for percent destroyed tournament along with consolation prize', async () => {
        const mockBoost = mockTournamentBoost('DESTROY_IMAGE', {
                UNLOCKED: ['save_event_greater_than #{100::WHOLE_CURRENCY::ZAR}'],
                PENDING: ['percent_destroyed_above #{0::10000}'],
                REDEEMED: ['percent_destroyed_in_first_N #{2::10000}'],
                CONSOLED: ['status_at_expiry #{PENDING}']
        });

        mockBoost.rewardParameters = { 
            consolationPrize: { type: 'RANDOM' }
        };

        fetchBoostStub.resolves(mockBoost);

        const mockUserResponseList = [
            { accountId: 'account-id-1', logContext: { percentDestroyed: 20, timeTakenMillis: 10000 } },
            { accountId: 'account-id-2', logContext: { percentDestroyed: 40, timeTakenMillis: 10000 } },
            { accountId: 'account-id-3', logContext: { percentDestroyed: 10, timeTakenMillis: 10000 } }
        ];
        findBoostLogsStub.resolves(mockUserResponseList);

        findAccountsStub.onFirstCall().resolves(formAccountResponse(mockAccountUserMap([1, 2, 3], 'PENDING'))); // for winners + consolation
        findAccountsStub.onSecondCall().resolves(formAccountResponse(mockAccountUserMap([1, 2, 3, 4], 'PENDING'))); // all
        findAccountsStub.onThirdCall().resolves(formAccountResponse(mockAccountUserMap([4], 'OFFERED')));

        const mockConsolationAmount = 55 * 100; // $0.55
        redemptionHandlerStub.resolves({ [testBoostId]: 
            { result: 'SUCCESS', boostAmount: 50000, consolationAmount: mockConsolationAmount, amountFromBonus: 50000 + mockConsolationAmount, unit: 'HUNDREDTH_CENT' }
        });

        const resultOfExpiry = await handler.handleExpiredBoost(testBoostId);
        expect(resultOfExpiry).to.exist;

        // just testing the most important things, rest covered above
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);
        expect(findBoostLogsStub).to.have.been.calledOnceWithExactly(testBoostId, 'GAME_RESPONSE');
        
        const expectedRedemptionMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'some-user-id1', status: 'PENDING', newStatus: 'REDEEMED' },
                'account-id-2': { userId: 'some-user-id2', status: 'PENDING', newStatus: 'REDEEMED' },
                'account-id-3': { userId: 'some-user-id3', status: 'PENDING', newStatus: 'CONSOLED' }
            }
        };

        const redemptionEvent = { eventType: 'BOOST_TOURNAMENT_WON', boostId: testBoostId };
        const redemptionCall = { redemptionBoosts: [mockBoost], affectedAccountsDict: expectedRedemptionMap, event: redemptionEvent };
        expect(redemptionHandlerStub).to.have.been.calledOnceWithExactly(redemptionCall);

        const expectedUpdate = (accountIds, newStatus, amount) => (
            { boostId: testBoostId, accountIds, newStatus, logType: 'STATUS_CHANGE', logContext: { amountAwarded: { amount, unit: 'HUNDREDTH_CENT', currency: 'USD' } }}
        );
        
        const expectedRedemptionUpdate = expectedUpdate(['account-id-1', 'account-id-2'], 'REDEEMED', 50000);
        const expectedConsoledUpdate = expectedUpdate(['account-id-3'], 'CONSOLED', mockConsolationAmount);
        const expectedExpiredUpdate = expectedUpdate(['account-id-4'], 'EXPIRED');
        Reflect.deleteProperty(expectedExpiredUpdate, 'logContext'); // as not necessary

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
        expect(updateBoostAccountStub).to.have.been.calledWithExactly([expectedRedemptionUpdate, expectedConsoledUpdate]);
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

        redemptionHandlerStub.resolves({ [testBoostId]: { boostAmount: expectedRewardAmount }});

        const resultOfExpiry = await handler.handleExpiredBoost(testBoostId);
        expect(resultOfExpiry).to.deep.equal({ statusCode: 200, boostsRedeemed: 2 });

        // just testing the most important things, rest covered above
        expect(fetchBoostStub).to.have.been.calledOnceWithExactly(testBoostId);
        expect(findBoostLogsStub).to.have.been.calledOnceWithExactly(testBoostId, 'GAME_RESPONSE');
        
        const expectedRedemptionMap = {
            [testBoostId]: {
                'account-id-1': { userId: 'some-user-id1', status: 'PENDING', newStatus: 'REDEEMED' },
                'account-id-2': { userId: 'some-user-id2', status: 'PENDING', newStatus: 'REDEEMED' }
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

});
