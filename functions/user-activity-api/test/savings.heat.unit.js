'use strict';

// const logger = require('debug')('jupiter:heat:test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const proxyquire = require('proxyquire');
const sinon = require('sinon');
const chai = require('chai');
chai.use(require('chai-as-promised'));
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const redisSetStub = sinon.stub();
const countSavesStub = sinon.stub();
const countFriendsStub = sinon.stub();
const getOwnerInfoStub = sinon.stub();
const findCurrencyStub = sinon.stub();
const sumTotalSavedStub = sinon.stub();
const fetchTxHistoryStub = sinon.stub();
const getAccOpenDateStub = sinon.stub();
const fetchAllAccountsStub = sinon.stub();
const findFloatAccountsStub = sinon.stub();
const sumSavedLastMonthStub = sinon.stub();
const findClientAccountsStub = sinon.stub();
const countSavesLastMonthStub = sinon.stub();

const CACHE_TTL_IN_SECONDS = config.get('cache.ttls.savingsHeat');

class MockRedis {
    constructor () { 
        this.set = redisSetStub;
    }
}

const handler = proxyquire('../savings-heat-handler', {
    './persistence/rds': {
        'fetchAccounts': fetchAllAccountsStub,
        'findAccountsForFloat': findFloatAccountsStub,
        'findAccountsForClient': findClientAccountsStub,
        'getOwnerInfoForAccount': getOwnerInfoStub,
        'sumTotalAmountSaved': sumTotalSavedStub,
        'sumAmountSavedLastMonth': sumSavedLastMonthStub,
        'countSettledSaves': countSavesStub,
        'findMostCommonCurrency': findCurrencyStub,
        'fetchTransactionsForHistory': fetchTxHistoryStub,
        'countSettledSavesForPrevMonth': countSavesLastMonthStub,
        'countActiveSavingFriendsForUser': countFriendsStub,
        'getAccountOpenedDateForHeatCalc': getAccOpenDateStub
    },
    'ioredis': MockRedis
});


describe('*** UNIT TEST SAVINGS HEAT CALCULATION ***', async () => {
    const testTxId = uuid();
    const testSystemId = uuid();
    const testAccountId = uuid();

    const testClientId = 'some_client';
    const testFloatId = 'primary_mmkt_float';

    const testAccountOpenedTime = moment().subtract(3, 'months').format();
    const testActivityDate = moment().format();

    const testTx = (txType) => ({
        transactionId: testTxId,
        accountId: testAccountId,
        creationTime: testActivityDate,
        transactionType: txType,
        settlementStatus: 'SETTLED',
        amount: '100',
        currency: 'ZAR',
        unit: 'HUNDREDTH_CENT',
        humanReference: 'VADER1'
    });

    beforeEach(() => {
        helper.resetStubs(
            redisSetStub, countSavesStub, countFriendsStub, sumTotalSavedStub, getAccOpenDateStub, fetchAllAccountsStub,
            findFloatAccountsStub, findClientAccountsStub, sumSavedLastMonthStub, countSavesLastMonthStub, findCurrencyStub, fetchTxHistoryStub
        );
    });

    it('Calculates and caches savings for all accounts', async () => {
        const expectedScore = '14.70';

        fetchAllAccountsStub.resolves([testAccountId, testAccountId, testAccountId]);
        getOwnerInfoStub.withArgs(testAccountId).resolves({ ownerUserId: testSystemId });
        countSavesStub.withArgs(testAccountId).resolves(27); // NB
        countSavesLastMonthStub.withArgs(testAccountId).resolves(5);
        countFriendsStub.withArgs(testSystemId).resolves(21);
        getAccOpenDateStub.withArgs(testAccountId).resolves(testAccountOpenedTime);
        findCurrencyStub.withArgs(testAccountId).resolves('ZAR');
        sumTotalSavedStub.withArgs(testAccountId, 'ZAR').resolves(100000);
        sumSavedLastMonthStub.withArgs(testAccountId, 'ZAR').resolves(51000);

        const resultOfCalc = await handler.calculateSavingsHeat({ });

        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({
            result: 'SUCCESS',
            details: [
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                },
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                },
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                }
            ]
        });

        const cachePayload = JSON.stringify({ accountId: testAccountId, savingsHeat: expectedScore });
        expect(redisSetStub).to.have.been.calledWith(testAccountId, cachePayload, 'EX', CACHE_TTL_IN_SECONDS);
        expect(redisSetStub).to.have.been.calledThrice;
    });

    it('Calculates and caches savings heat for provided account ids', async () => {
        const expectedScore = '12.95';

        getOwnerInfoStub.withArgs(testAccountId).resolves({ ownerUserId: testSystemId });
        countSavesStub.resolves(27);
        countSavesLastMonthStub.withArgs(testAccountId).resolves(5);
        countFriendsStub.withArgs(testSystemId).resolves(14); // NB
        getAccOpenDateStub.withArgs(testAccountId).resolves(testAccountOpenedTime);
        findCurrencyStub.withArgs(testAccountId).resolves('ZAR');
        sumTotalSavedStub.withArgs(testAccountId, 'ZAR').resolves(100000);
        sumSavedLastMonthStub.withArgs(testAccountId, 'ZAR').resolves(51000);

        const resultOfCalc = await handler.calculateSavingsHeat({ accountIds: [testAccountId, testAccountId] });

        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({
            result: 'SUCCESS',
            details: [
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                },
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                }
            ]
        });

        const cachePayload = JSON.stringify({ accountId: testAccountId, savingsHeat: expectedScore });
        expect(redisSetStub).to.have.been.calledWith(testAccountId, cachePayload, 'EX', CACHE_TTL_IN_SECONDS);
        expect(redisSetStub).to.have.been.calledTwice;
    });

    it('Calculates and caches savings heat for float accounts', async () => {
        const expectedScore = '4.15';

        findFloatAccountsStub.withArgs(testFloatId).resolves([testAccountId, testAccountId, testAccountId]);
        getOwnerInfoStub.withArgs(testAccountId).resolves({ ownerUserId: testSystemId });
        countSavesStub.withArgs(testAccountId).resolves(27);
        countSavesLastMonthStub.withArgs(testAccountId).resolves(5);
        countFriendsStub.withArgs(testSystemId).resolves(14);
        getAccOpenDateStub.withArgs(testAccountId).resolves(testAccountOpenedTime);
        findCurrencyStub.withArgs(testAccountId).resolves('ZAR');
        sumTotalSavedStub.withArgs(testAccountId, 'ZAR').resolves(100000);
        sumSavedLastMonthStub.withArgs(testAccountId, 'ZAR').resolves(7000); // NB

        const resultOfCalc = await handler.calculateSavingsHeat({ floatId: testFloatId });

        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({
            result: 'SUCCESS',
            details: [
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                },
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                },
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                }
            ]
        });
    
        const cachePayload = JSON.stringify({ accountId: testAccountId, savingsHeat: expectedScore });
        expect(redisSetStub).to.have.been.calledWith(testAccountId, cachePayload, 'EX', CACHE_TTL_IN_SECONDS);
        expect(redisSetStub).to.have.been.calledThrice;
    });

    it('Calculates and caches savings heat for client accounts', async () => {
        const expectedScore = '10.95';

        findClientAccountsStub.withArgs(testClientId).resolves([testAccountId, testAccountId, testAccountId]);
        getOwnerInfoStub.withArgs(testAccountId).resolves({ ownerUserId: testSystemId });
        countSavesStub.withArgs(testAccountId).resolves(27);
        countSavesLastMonthStub.withArgs(testAccountId).resolves(1); // NB
        countFriendsStub.withArgs(testSystemId).resolves(14);
        getAccOpenDateStub.withArgs(testAccountId).resolves(testAccountOpenedTime);
        findCurrencyStub.withArgs(testAccountId).resolves('ZAR');
        sumTotalSavedStub.withArgs(testAccountId, 'ZAR').resolves(100000);
        sumSavedLastMonthStub.withArgs(testAccountId, 'ZAR').resolves(51000);

        const resultOfCalc = await handler.calculateSavingsHeat({ clientId: testClientId });

        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({
            result: 'SUCCESS',
            details: [
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                },
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                },
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                }
            ]
        });

        const cachePayload = JSON.stringify({ accountId: testAccountId, savingsHeat: expectedScore });
        expect(redisSetStub).to.have.been.calledWith(testAccountId, cachePayload, 'EX', CACHE_TTL_IN_SECONDS);
        expect(redisSetStub).to.have.been.calledThrice;
    });

    it('Handles user with no prior saves', async () => {
        const expectedScore = '0.00';

        getOwnerInfoStub.withArgs(testAccountId).resolves({ ownerUserId: testSystemId });
        countSavesStub.resolves(0);
        countSavesLastMonthStub.withArgs(testAccountId).resolves(0); // NB
        countFriendsStub.withArgs(testSystemId).resolves(5);
        getAccOpenDateStub.withArgs(testAccountId).resolves(testAccountOpenedTime);

        const resultOfCalc = await handler.calculateSavingsHeat({ accountIds: [testAccountId] });
        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({
            result: 'SUCCESS',
            details: [
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                }
            ]
        });

        const cachePayload = JSON.stringify({ accountId: testAccountId, savingsHeat: expectedScore });
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testAccountId, cachePayload, 'EX', CACHE_TTL_IN_SECONDS);
        expect(findCurrencyStub).to.have.not.been.called;
        expect(sumTotalSavedStub).to.have.not.been.called;
        expect(sumSavedLastMonthStub).to.have.not.been.called;
    });

    it('Handles users with less than a month on Jupiter', async () => {
        const testAccountOpenedDate = moment().subtract(3, 'days').format(); // NB
        const expectedScore = '0.00';

        getOwnerInfoStub.withArgs(testAccountId).resolves({ ownerUserId: testSystemId });
        countSavesStub.resolves(0);
        countSavesLastMonthStub.withArgs(testAccountId).resolves(0);
        countFriendsStub.withArgs(testSystemId).resolves(5);
        getAccOpenDateStub.withArgs(testAccountId).resolves(testAccountOpenedDate);

        const resultOfCalc = await handler.calculateSavingsHeat({ accountIds: [testAccountId] });

        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({
            result: 'SUCCESS',
            details: [
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore
                }
            ]
        });

        const cachePayload = JSON.stringify({ accountId: testAccountId, savingsHeat: expectedScore });
        expect(redisSetStub).to.have.been.calledOnceWithExactly(testAccountId, cachePayload, 'EX', CACHE_TTL_IN_SECONDS);
        expect(findCurrencyStub).to.have.not.been.called;
        expect(sumTotalSavedStub).to.have.not.been.called;
        expect(sumSavedLastMonthStub).to.have.not.been.called;
    });

    it('Includes last acitvity details if requested', async () => {
        const expectedScore = '19.77';
        const testAccountOpenedDate = moment().subtract(5, 'months').format(); // NB
        // In this case the user has no previous capitalization events.
        const testEvent = { accountIds: [testAccountId], includeLastActivityOfType: ['USER_SAVING_EVENT', 'BOOST_REDEMPTION', 'CAPITALIZATION'] }; // NB

        getOwnerInfoStub.withArgs(testAccountId).resolves({ ownerUserId: testSystemId });
        countSavesStub.resolves(27);
        countSavesLastMonthStub.withArgs(testAccountId).resolves(5);
        countFriendsStub.withArgs(testSystemId).resolves(14);
        getAccOpenDateStub.withArgs(testAccountId).resolves(testAccountOpenedDate);
        findCurrencyStub.withArgs(testAccountId).resolves('ZAR');
        sumTotalSavedStub.withArgs(testAccountId, 'ZAR').resolves(100000);
        sumSavedLastMonthStub.withArgs(testAccountId, 'ZAR').resolves(51000);
        fetchTxHistoryStub.withArgs(testAccountId).resolves([testTx('USER_SAVING_EVENT'), testTx('BOOST_REDEMPTION'), testTx('WITHDRAWAL')]);

        const resultOfCalc = await handler.calculateSavingsHeat(testEvent);

        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({
            result: 'SUCCESS',
            details: [
                {
                    accountId: testAccountId,
                    savingsHeat: expectedScore,
                    USER_SAVING_EVENT: {
                        lastActivityDate: testActivityDate,
                        lastActivityAmount: {
                            amount: '100',
                            currency: 'ZAR',
                            unit: 'HUNDREDTH_CENT'
                        }
                    },
                    BOOST_REDEMPTION: {
                        lastActivityDate: testActivityDate,
                        lastActivityAmount: {
                            amount: '100',
                            currency: 'ZAR',
                            unit: 'HUNDREDTH_CENT'
                        }
                    }
                }
            ]
        });
    });

    it('Catches thrown errors', async () => {
        getOwnerInfoStub.withArgs(testAccountId).throws(new Error('Error!'));
        const resultOfCalc = await handler.calculateSavingsHeat({ accountIds: [testAccountId] });
        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({ result: 'ERROR', message: 'Error!' });
    });
});
