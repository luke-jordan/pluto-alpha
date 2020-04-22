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
const getAccOpenDateStub = sinon.stub();
const fetchAllAccountsStub = sinon.stub();
const findFloatAccountsStub = sinon.stub();
const findClientAccountsStub = sinon.stub();
const sumSavedLastMonthStub = sinon.stub();
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
        'countSettledSavesForPrevMonth': countSavesLastMonthStub,
        'countActiveSavingFriendsForUser': countFriendsStub,
        'getAccountOpenedDateForHeatCalc': getAccOpenDateStub
    },
    'ioredis': MockRedis
});


describe('*** UNIT TEST SAVINGS HEAT CALCULATION ***', async () => {
    const testSystemId = uuid();
    const testAccountId = uuid();

    const testClientId = 'some_client';
    const testFloatId = 'primary_mmkt_float';

    const testAccountOpenedTime = moment().subtract(3, 'months').format();

    beforeEach(() => {
        helper.resetStubs(
            redisSetStub, countSavesStub, countFriendsStub, sumTotalSavedStub, getAccOpenDateStub, fetchAllAccountsStub,
            findFloatAccountsStub, findClientAccountsStub, sumSavedLastMonthStub, countSavesLastMonthStub, findCurrencyStub
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
                    heatScore: expectedScore
                },
                {
                    accountId: testAccountId,
                    heatScore: expectedScore
                },
                {
                    accountId: testAccountId,
                    heatScore: expectedScore
                }
            ]
        });

        expect(redisSetStub).to.have.been.calledWith(testAccountId, expectedScore, 'EX', CACHE_TTL_IN_SECONDS);
        expect(redisSetStub).to.have.been.calledThrice;
    });

    it('Calculates and caches savings heat for account id', async () => {
        const expectedScore = '12.95';

        getOwnerInfoStub.withArgs(testAccountId).resolves({ ownerUserId: testSystemId });
        countSavesStub.resolves(27);
        countSavesLastMonthStub.withArgs(testAccountId).resolves(5);
        countFriendsStub.withArgs(testSystemId).resolves(14); // NB
        getAccOpenDateStub.withArgs(testAccountId).resolves(testAccountOpenedTime);
        findCurrencyStub.withArgs(testAccountId).resolves('ZAR');
        sumTotalSavedStub.withArgs(testAccountId, 'ZAR').resolves(100000);
        sumSavedLastMonthStub.withArgs(testAccountId, 'ZAR').resolves(51000);

        const resultOfCalc = await handler.calculateSavingsHeat({ accountId: testAccountId });

        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({
            result: 'SUCCESS',
            details: [
                {
                    accountId: testAccountId,
                    heatScore: expectedScore
                }
            ]
        });

        expect(redisSetStub).to.have.been.calledOnceWithExactly(testAccountId, expectedScore, 'EX', CACHE_TTL_IN_SECONDS);
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
                    heatScore: expectedScore
                },
                {
                    accountId: testAccountId,
                    heatScore: expectedScore
                },
                {
                    accountId: testAccountId,
                    heatScore: expectedScore
                }
            ]
        });
    
        expect(redisSetStub).to.have.been.calledWith(testAccountId, expectedScore, 'EX', CACHE_TTL_IN_SECONDS);
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
                    heatScore: expectedScore
                },
                {
                    accountId: testAccountId,
                    heatScore: expectedScore
                },
                {
                    accountId: testAccountId,
                    heatScore: expectedScore
                }
            ]
        });
    
        expect(redisSetStub).to.have.been.calledWith(testAccountId, expectedScore, 'EX', CACHE_TTL_IN_SECONDS);
        expect(redisSetStub).to.have.been.calledThrice;
    });

    it('Handles user with no prior saves', async () => {
        const expectedScore = '0.00';

        getOwnerInfoStub.withArgs(testAccountId).resolves({ ownerUserId: testSystemId });
        countSavesStub.resolves(0);
        countSavesLastMonthStub.withArgs(testAccountId).resolves(0); // NB
        countFriendsStub.withArgs(testSystemId).resolves(5);
        getAccOpenDateStub.withArgs(testAccountId).resolves(testAccountOpenedTime);

        const resultOfCalc = await handler.calculateSavingsHeat({ accountId: testAccountId });
        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({
            result: 'SUCCESS',
            details: [
                {
                    accountId: testAccountId,
                    heatScore: expectedScore
                }
            ]
        });

        expect(redisSetStub).to.have.been.calledOnceWithExactly(testAccountId, expectedScore, 'EX', CACHE_TTL_IN_SECONDS);
        expect(findCurrencyStub).to.have.not.been.called;
        expect(sumTotalSavedStub).to.have.not.been.called;
        expect(sumSavedLastMonthStub).to.have.not.been.called;
    });

    // todo: Test effect of active months, also how to handle user who have only joined this month

    it('Catches thrown errors', async () => {
        getOwnerInfoStub.withArgs(testAccountId).throws(new Error('Error!'));
        const resultOfCalc = await handler.calculateSavingsHeat({ accountId: testAccountId });
        expect(resultOfCalc).to.exist;
        expect(resultOfCalc).to.deep.equal({ result: 'ERROR', message: 'Error!' });
    });
});
