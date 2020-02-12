'use strict';

const uuid = require('uuid');
const config = require('config');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const moment = require('moment');
const helper = require('./test.helper');
const DecimalLight = require('decimal.js-light');

const listClientFloatsStub = sinon.stub();
const getFloatBalanceAndFlowsStub = sinon.stub();
const getLastFloatAccrualTimeStub = sinon.stub();
const lamdbaInvokeStub = sinon.stub();
const momentStub = sinon.stub();
const sendSystemEmailStub = sinon.stub();
const rdsExpireHangingTransactionsStub = sinon.stub();
const expireBoostsStub = sinon.stub();
const publishMultiUserEventStub = sinon.stub();
const checkAllFloatsStub = sinon.stub();
const fetchUserIdsForAccountsStub = sinon.stub();

const MILLIS_IN_DAY = 86400000;
const DAYS_IN_A_YEAR = 365;

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../scheduled-job', {
    './persistence/dynamo.float': {
        'listClientFloats': listClientFloatsStub
    },
    './persistence/rds.float': {
        'getFloatBalanceAndFlows': getFloatBalanceAndFlowsStub,
        'getLastFloatAccrualTime': getLastFloatAccrualTimeStub
    },
    './persistence/rds.account': {
        'expireHangingTransactions': rdsExpireHangingTransactionsStub,
        'expireBoosts': expireBoostsStub,
        'fetchUserIdsForAccounts': fetchUserIdsForAccountsStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient
    },
    'moment': momentStub,
    'publish-common': {
        sendSystemEmail: sendSystemEmailStub,
        publishMultiUserEvent: publishMultiUserEventStub
    },
    './admin-float-consistency': {
        'checkAllFloats': checkAllFloatsStub
    }
});

describe('** UNIT TEST SCHEDULED JOB HANDLER **', () => {
    const testClientId = uuid();
    const testFloatId = uuid();
    const testAmount = 100;
    const testUnit = 'HUNDREDTH_CENT';
    const testCurrency = 'ZAR';
    const testAccrualRateAnnualBps = 750;
    const testTime = moment();
    const testTimeValueOf = moment().valueOf();
    const sendSystemEmailReponse = {};

    const testFloatBalanceMap = {
        get: () => ({
            [testCurrency]: {
                amount: testAmount,
                unit: testUnit
            }
        })
    };

    beforeEach(() => helper.resetStubs(
        listClientFloatsStub, getFloatBalanceAndFlowsStub, getLastFloatAccrualTimeStub, lamdbaInvokeStub, momentStub, sendSystemEmailStub,
        rdsExpireHangingTransactionsStub, expireBoostsStub, publishMultiUserEventStub, checkAllFloatsStub, fetchUserIdsForAccountsStub
    ));

    it('should run regular job - accrue float successfully', async () => {
       const testEvent = {
           specificOperations: ['ACRRUE_FLOAT']
       };
       const expectedResult = [testEvent.specificOperations.length];

       const testLastFloatAccrualTime = moment();
       const testMillisSinceLastCalc = testTimeValueOf - testLastFloatAccrualTime.valueOf();
       const testBasisPointDivisor = 100 * 100; // i.e., hundredths of a percent
       const testDailyAccrualRateNominalNet = new DecimalLight(testAccrualRateAnnualBps).dividedBy(testBasisPointDivisor).dividedBy(DAYS_IN_A_YEAR);
       const testPortionOfDay = new DecimalLight(testMillisSinceLastCalc).dividedBy(new DecimalLight(MILLIS_IN_DAY));
       const testAccrualRateToApply = testDailyAccrualRateNominalNet.times(testPortionOfDay).toNumber();
       const testTodayAccrualAmount = new DecimalLight(testAmount).times(testAccrualRateToApply);
       const clientFloats = [{ clientId: testClientId, floatId: testFloatId, currency: testCurrency, accrualRateAnnualBps: testAccrualRateAnnualBps }];

       listClientFloatsStub.resolves(clientFloats);
       getFloatBalanceAndFlowsStub.withArgs([testFloatId]).resolves(testFloatBalanceMap);
       getLastFloatAccrualTimeStub.withArgs(testFloatId, testClientId).resolves(testLastFloatAccrualTime);

        const testAccrualPayload = {
            clientId: testClientId,
            floatId: testFloatId,
            accrualAmount: testTodayAccrualAmount.toDecimalPlaces(0).toNumber(),
            currency: testCurrency,
            unit: testUnit,
            referenceTimeMillis: testTimeValueOf,
            backingEntityIdentifier: `SYSTEM_CALC_DAILY_${testTimeValueOf}`,
            backingEntityType: 'ACCRUAL_EVENT',
            calculationBasis: {
                'floatAmountHunCent': testAmount,
                'accrualRateAnnualBps': testAccrualRateAnnualBps,
                'millisSinceLastCalc': testMillisSinceLastCalc,
                'accrualRateApplied': testAccrualRateToApply
            }
        };

        momentStub.returns({
            valueOf: () => testTimeValueOf,
            subtract: () => testTime
        });

        const testAccrualInvocationResults = {
           entityAllocations: {
               BONUS_FEE: '',
               CLIENT_FEE: '',
               BONUS_SHARE: '',
               CLIENT_SHARE: ''
           },
           userAllocationTransactions: {
               allocationRecords: {
                   accountTxIds: []
               }
           }
        };

        const argsForLambdaExecutingAccrualRate = {
            FunctionName: config.get('lambdas.processAccrual'),
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify(testAccrualPayload)
        };
        lamdbaInvokeStub.withArgs(argsForLambdaExecutingAccrualRate).returns({
            promise: () => helper.mockLambdaResponse(testAccrualInvocationResults)
        });
        sendSystemEmailStub.resolves(sendSystemEmailReponse);

       const result = await handler.runRegularJobs(testEvent);
       expect(result).to.exist;
       expect(result).to.have.property('statusCode', 200);
        expect(result.body).to.deep.equal(expectedResult);
        expect(listClientFloatsStub).to.have.been.calledOnce;
        expect(getFloatBalanceAndFlowsStub).to.have.been.calledOnce;
        expect(getLastFloatAccrualTimeStub).to.have.been.calledOnce;
        expect(momentStub).to.have.been.calledOnce;
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(argsForLambdaExecutingAccrualRate);
    });

    it('should run regular job - expire hanging successfully', async () => {
       const testEvent = {
           specificOperations: ['EXPIRE_HANGING']
       };
        const expectedResult = [];

       rdsExpireHangingTransactionsStub.withArgs().resolves(expectedResult);

       const result = await handler.runRegularJobs(testEvent);
       expect(result).to.exist;
       expect(result).to.have.property('statusCode', 200);
       expect(result.body).to.deep.equal([expectedResult.length]);
       expect(rdsExpireHangingTransactionsStub).to.have.been.calledOnce;
    });

    it('should run regular job - expire boosts successfully when NO expired boosts exist', async () => {
       const testEvent = {
           specificOperations: ['EXPIRE_BOOSTS']
       };
        const emptyArray = [];

        expireBoostsStub.withArgs().resolves(emptyArray);

       const result = await handler.runRegularJobs(testEvent);
       expect(result).to.exist;
       expect(result).to.have.property('statusCode', 200);
       expect(result.body).to.deep.equal([{ result: 'NO_BOOSTS' }]);
       expect(expireBoostsStub).to.have.been.calledOnce;
    });

    it('should run regular job - expire boosts successfully when boosts exist', async () => {
       const testEvent = {
           specificOperations: ['EXPIRE_BOOSTS']
       };
       const testAccountId = uuid();
       const testBoostId = uuid();
       const expectedBoosts = [{ boostId: testBoostId, accountId: testAccountId }];
       const testUserIdAccounts = { accountId: testAccountId };

       expireBoostsStub.withArgs().resolves(expectedBoosts);
       fetchUserIdsForAccountsStub.withArgs().resolves(testUserIdAccounts);
       publishMultiUserEventStub.withArgs().resolves({});

       const result = await handler.runRegularJobs(testEvent);
       expect(result).to.exist;
       expect(result).to.have.property('statusCode', 200);
       expect(result.body).to.deep.equal([{ result: 'EXPIRED_BOOSTS', boostsExpired: expectedBoosts.length }]);
       expect(expireBoostsStub).to.have.been.calledOnce;
       expect(fetchUserIdsForAccountsStub).to.have.been.calledOnceWithExactly([testAccountId]);
       expect(publishMultiUserEventStub).to.have.been.calledOnce;
    });

    it('should run regular job - check floats successfully', async () => {
       const testEvent = {
           specificOperations: ['CHECK_FLOATS']
       };
        const testAnomaly = {
            mismatch: -1,
            floatAccountsTotal: 100,
            accountsTxTotal: 101,
            currency: testCurrency,
            unit: 'HUNDREDTH_CENT'
        };
        const expectedResult = {
            result: 'ANOMALIES_FOUND',
            anomalies: { BALANCE_MISMATCH: [null], ALLOCATION_TOTAL_MISMATCH: [testAnomaly] }
        };

        const response = [expectedResult, expectedResult, expectedResult];

        checkAllFloatsStub.withArgs().resolves(response);

       const result = await handler.runRegularJobs(testEvent);
       expect(result).to.exist;
       expect(result).to.have.property('statusCode', 200);
       expect(result.body).to.deep.equal([response]);
        expect(checkAllFloatsStub).to.have.been.calledOnce;
    });

});
