'use strict';

// const logger = require('debug')('jupiter:locked-saves:test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid');

const testHelper = require('./test.helper');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const fetchFloatVarsStub = sinon.stub();

const fetchTxStub = sinon.stub();
const fetchLockedTxStub = sinon.stub();
const fetchAccountsStub = sinon.stub();
const lockTxStub = sinon.stub();
const unlockTxStub = sinon.stub();

const publishStub = sinon.stub();
const momentStub = sinon.stub();

const lambdaInvokeStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

class MockLambdaClient {
    constructor () {
        this.invoke = lambdaInvokeStub;
    }
}

const handler = proxyquire('../locked-handler', {
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsStub,
        '@noCallThru': true
    },
    './persistence/rds': {
        'fetchTransaction': fetchTxStub,
        'findAccountsForUser': fetchAccountsStub,
        'lockTransaction': lockTxStub,
        'fetchLockedTransactions': fetchLockedTxStub,
        'unlockTransactions': unlockTxStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient,
        // eslint-disable-next-line no-empty-function
        'config': { update: () => ({}) }
    },
    'moment': momentStub,
    '@noCallThru': true
});

const testSystemId = uuid();

describe('*** UNIT TEST LOCKED SAVE BONUS PREVIEW ***', () => {

    beforeEach(() => testHelper.resetStubs(fetchFloatVarsStub));

    it('Calculates projected bonus for locked saves by number of locked days', async () => {
        const testFloatProjectionVars = {
            accrualRateAnnualBps: 250,
            lockedSaveBonus: { 30: 1.01, 60: 1.05, 90: 1.1 }
        };

        fetchFloatVarsStub.resolves(testFloatProjectionVars);

        const testEventBody = {
            clientId: 'some_client',
            floatId: 'primary_cash',
            daysToPreview: [1, 4, 30, 67],
            baseAmount: {
                amount: 10000,
                unit: 'HUNDREDTH_CENT',
                currency: 'USD'
            }
        };

        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfPreview = await handler.previewBonus(testEvent);
        const resultBody = testHelper.standardOkayChecks(resultOfPreview);

        const expectedResult = {
            '1': { amount: 152.53390581494563, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            '4': { amount: 624.2380778166955, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            '30': { amount: 5761.125598535054, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            '67': { amount: 17820.34234258725, unit: 'HUNDREDTH_CENT', currency: 'USD' }
        };
        
        expect(resultBody).to.deep.equal(expectedResult);
        expect(fetchFloatVarsStub).to.have.been.calledOnceWithExactly('some_client', 'primary_cash');
    });

    it('Uses default multiplier where locked save bonus not in client-float vars', async () => {
        fetchFloatVarsStub.resolves({ accrualRateAnnualBps: 250 });

        const testEventBody = {
            clientId: 'some_client',
            floatId: 'primary_cash',
            daysToPreview: [1, 4, 30, 67],
            baseAmount: {
                amount: 10000,
                unit: 'HUNDREDTH_CENT',
                currency: 'USD'
            }
        };

        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfPreview = await handler.previewBonus(testEvent);
        const resultBody = testHelper.standardOkayChecks(resultOfPreview);

        const expectedResult = {
            '1': { amount: 152.53390581494563, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            '4': { amount: 624.2380778166955, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            '30': { amount: 5748.291920665036, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            '67': { amount: 17573.255999765744, unit: 'HUNDREDTH_CENT', currency: 'USD' }
        };

        expect(resultBody).to.deep.equal(expectedResult);
        expect(fetchFloatVarsStub).to.have.been.calledOnceWithExactly('some_client', 'primary_cash');
    });

    it('Handles invalid events and thrown errors', async () => {
        await expect(handler.previewBonus({ })).to.eventually.deep.equal({ statusCode: 400, body: 'Empty invocation' });
        await expect(handler.previewBonus({ clientId: 'some_client' })).to.eventually.deep.equal({ statusCode: 403 });

        fetchFloatVarsStub.throws(new Error('Dynamo error'));
        const testEvent = testHelper.wrapEvent({ clientId: 'some_client' }, testSystemId, 'ORDINARY_USER');
        const expectedResult = { statusCode: 500, headers: testHelper.expectedHeaders, body: JSON.stringify({ message: 'Dynamo error' }) };

        await expect(handler.previewBonus(testEvent)).to.eventually.deep.equal(expectedResult);
    });
});

describe('*** UNIT TEST LOCK SETTLED SAVE ***', () => {
    const testTxId = uuid();
    const testAccountId = uuid();

    const testClientId = 'some_client_co';
    const testFloatId = 'some_float';
    const testBonusPoolId = 'principal_bonus_pool';

    const testUpdatedTime = moment();

    const testTx = {
        transactionId: testTxId,
        accountId: testAccountId,
        transactionType: 'USER_SAVING_EVENT',
        settlementStatus: 'SETTLED',
        amount: '100',
        currency: 'USD',
        unit: 'HUNDREDTH_CENT'
    };

    const testUserProfile = {
        systemWideUserId: testSystemId,
        clientId: 'some_client_co',
        defaultFloatId: 'some_float',
        defaultCurrency: 'USD'
    };

    beforeEach(() => {
        testHelper.resetStubs(fetchTxStub, fetchAccountsStub, lockTxStub, publishStub, lambdaInvokeStub, momentStub, fetchFloatVarsStub);
    });

    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({
            statusCode,
            body: JSON.stringify(body)
        })
    });

    it('Locks a settled save, updates transaction tags and sets lock duration', async () => {
        const testBoostExpiryTime = moment().add(31, 'days');
        const testBonusAmount = { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' };

        fetchTxStub.resolves(testTx);
        lockTxStub.resolves({ updatedTime: testUpdatedTime });

        fetchFloatVarsStub.resolves({ bonusPoolSystemWideId: 'principal_bonus_pool' });

        lambdaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lambdaInvokeStub.onSecondCall().returns({ promise: () => ({ statusCode: 200 })});

        momentStub.onFirstCall().returns(testUpdatedTime);
        momentStub.returns({ add: () => testBoostExpiryTime, valueOf: () => testBoostExpiryTime.valueOf() });

        const testEventBody = { transactionId: testTxId, daysToLock: 30, lockBonusAmount: testBonusAmount };
        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfLock = await handler.lockSettledSave(testEvent);
        const resultBody = testHelper.standardOkayChecks(resultOfLock);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });
        
        expect(fetchTxStub).to.have.been.calledOnceWithExactly(testTxId);
        expect(lockTxStub).to.have.been.calledOnceWithExactly(testTx, testBonusAmount, 30);

        const expectedProfileInvocation = testHelper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testSystemId });

        const expectedBoostSource = {
            clientId: testClientId,
            floatId: testFloatId,
            bonusPoolId: testBonusPoolId
        };

        const expectedAudienceSelection = {
            conditions: [
                { op: 'in', prop: 'systemWideUserId', value: [testSystemId] }
            ]
        };

        const expectedBoostPayload = {
            creatingUserId: testSystemId,
            label: 'Locked Save Boost',
            boostTypeCategory: 'LOCKED::SIMPLE_LOCK',
            boostAmountOffered: '100::HUNDREDTH_CENT::USD',
            boostBudget: '100',
            boostSource: expectedBoostSource,
            endTimeMillis: testBoostExpiryTime.valueOf(),
            boostAudienceType: 'INDIVIDUAL',
            boostAudienceSelection: expectedAudienceSelection,
            initialStatus: 'PENDING',
            statusConditions: { REDEEMED: ['event_occurs #{LOCK_EXPIRED}'] }
        };

        const expectedBoostInvocation = testHelper.wrapLambdaInvoc(config.get('lambdas.createBoost'), true, expectedBoostPayload);

        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedProfileInvocation);
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedBoostInvocation);

        expect(fetchFloatVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);

        const expectedLogOptions = {
            initiator: testSystemId,
            timestamp: testUpdatedTime.valueOf(),
            context: {
                transactionId: testTxId,
                accountId: testAccountId,
                transactionType: 'USER_SAVING_EVENT',
                oldTransactionStatus: 'SETTLED',
                newTransactionStatus: 'LOCKED',
                lockBonusAmount: testBonusAmount,
                lockDurationDays: 30
            }
        };

        expect(publishStub).to.have.been.calledOnceWithExactly(testSystemId, 'USER_LOCKED_SAVE', expectedLogOptions);
        expect(fetchAccountsStub).to.have.not.been.called;
    });

    it('Http route, locks user saving event, verifies user-account ownership', async () => {
        const testBoostExpiryTime = moment().add(31, 'days');
        const testBonusAmount = { amount: 15000, unit: 'HUNDREDTH_CENT', currency: 'USD' };

        fetchTxStub.resolves(testTx);
        fetchAccountsStub.resolves([testAccountId]);

        fetchFloatVarsStub.resolves({ bonusPoolSystemWideId: 'principal_bonus_pool' });
        lockTxStub.resolves({ updatedTime: testUpdatedTime });

        lambdaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lambdaInvokeStub.onSecondCall().returns({ promise: () => ({ statusCode: 200 })});

        momentStub.onFirstCall().returns(testUpdatedTime);
        momentStub.returns({ add: () => testBoostExpiryTime, valueOf: () => testBoostExpiryTime.valueOf() });

        const testEventBody = { transactionId: testTxId, daysToLock: 30, lockBonusAmount: testBonusAmount };
        const testEvent = testHelper.wrapQueryParamEvent(testEventBody, testSystemId, 'ORDINARY_USER', 'POST');

        const resultOfLock = await handler.lockSettledSave(testEvent);
        const resultBody = testHelper.standardOkayChecks(resultOfLock);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });
        
        expect(fetchTxStub).to.have.been.calledOnceWithExactly(testTxId);
        expect(lockTxStub).to.have.been.calledOnceWithExactly(testTx, testBonusAmount, 30);

        expect(fetchFloatVarsStub).to.have.been.calledOnceWithExactly(testClientId, testFloatId);
        expect(fetchAccountsStub).to.have.been.calledOnceWithExactly(testSystemId);

        const expectedProfileInvocation = testHelper.wrapLambdaInvoc(config.get('lambdas.fetchProfile'), false, { systemWideUserId: testSystemId });

        const expectedBoostSource = {
            clientId: testClientId,
            floatId: testFloatId,
            bonusPoolId: testBonusPoolId
        };

        const expectedAudienceSelection = {
            conditions: [
                { op: 'in', prop: 'systemWideUserId', value: [testSystemId] }
            ]
        };

        const expectedBoostPayload = {
            creatingUserId: testSystemId,
            label: 'Locked Save Boost',
            boostTypeCategory: 'LOCKED::SIMPLE_LOCK',
            boostAmountOffered: '100::HUNDREDTH_CENT::USD',
            boostBudget: '100',
            boostSource: expectedBoostSource,
            endTimeMillis: testBoostExpiryTime.valueOf(),
            boostAudienceType: 'INDIVIDUAL',
            boostAudienceSelection: expectedAudienceSelection,
            initialStatus: 'PENDING',
            statusConditions: { REDEEMED: ['event_occurs #{LOCK_EXPIRED}'] }
        };

        const expectedBoostInvocation = testHelper.wrapLambdaInvoc(config.get('lambdas.createBoost'), true, expectedBoostPayload);

        expect(lambdaInvokeStub).to.have.been.calledTwice;
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedProfileInvocation);
        expect(lambdaInvokeStub).to.have.been.calledWithExactly(expectedBoostInvocation);

        const expectedLogOptions = {
            initiator: testSystemId,
            timestamp: testUpdatedTime.valueOf(),
            context: {
                transactionId: testTxId,
                accountId: testAccountId,
                transactionType: 'USER_SAVING_EVENT',
                oldTransactionStatus: 'SETTLED',
                newTransactionStatus: 'LOCKED',
                lockBonusAmount: testBonusAmount,
                lockDurationDays: 30 
            }
        };

        expect(publishStub).to.have.been.calledOnceWithExactly(testSystemId, 'USER_LOCKED_SAVE', expectedLogOptions);
    });

    it('Handles thrown errors and validation fails', async () => {
        const testEvent = testHelper.wrapQueryParamEvent({ transactionId: testTxId }, testSystemId, 'ORDINARY_USER', 'POST');

        // On invalid event
        await expect(handler.lockSettledSave({ httpMethod: 'POST' })).to.eventually.deep.equal({ statusCode: 403 });
        testHelper.expectNoCalls(fetchTxStub, fetchAccountsStub);

        fetchTxStub.resolves();

        // On invalid transaction id
        await expect(handler.lockSettledSave(testEvent)).to.eventually.deep.equal({ statusCode: 400 });
        testHelper.resetStubs(fetchTxStub);
        
        fetchTxStub.resolves(testTx);
        fetchAccountsStub.resolves(['account-id']); // differs from tx account id
        
        // Where user does not own transaction account
        await expect(handler.lockSettledSave(testEvent)).to.eventually.deep.equal({ statusCode: 403 });
        testHelper.resetStubs(fetchTxStub, fetchAccountsStub);
        
        const invalidTx = { ...testTx };
        invalidTx.transactionType = 'WITHDRAWAL';
        fetchTxStub.resolves(invalidTx);
        fetchAccountsStub.resolves([testAccountId]);

        // On invalid transaction type
        await expect(handler.lockSettledSave(testEvent)).to.eventually.deep.equal({ statusCode: 400 });
        testHelper.resetStubs(fetchTxStub);

        invalidTx.transactionType = 'USER_SAVING_EVENT';
        invalidTx.settlementStatus = 'PENDING';
        fetchTxStub.resolves(invalidTx);

        // On non-SETTLED transaction
        await expect(handler.lockSettledSave(testEvent)).to.eventually.deep.equal({ statusCode: 400 });
        testHelper.resetStubs(fetchTxStub, fetchAccountsStub);

        fetchTxStub.throws(new Error('Error!'));

        // On thrown error
        const resultOnError = await handler.lockSettledSave(testEvent);
        const resultBody = testHelper.standardOkayChecks(resultOnError, 500);
        expect(resultBody).to.deep.equal({ message: 'Error!'});
    });

});

describe('*** UNIT TEST LOCK EXPIRY SCHEDULED JOB ***', () => {
    const testTxId = uuid();
    const testAccountId = uuid();

    const testLockExpiryTime = moment().subtract(12, 'hours');
    const testCurrentTime = moment();

    const testLockedTx = {
        transactionId: testTxId,
        accountId: testAccountId,
        transactionType: 'USER_SAVING_EVENT',
        settlementStatus: 'SETTLED',
        amount: '100',
        currency: 'USD',
        unit: 'HUNDREDTH_CENT',
        lockUntilTime: testLockExpiryTime.format(),
        tags: ['LOCK_BONUS::1000::HUNDREDTH_CENT::ZAR']
    };

    it('Removes expired locks from transactions', async () => {
        fetchLockedTxStub.resolves([testLockedTx]);
        momentStub.returns(testCurrentTime);

        const resultOfExpire = await handler.checkForExpiredLocks();
        const resultBody = testHelper.standardOkayChecks(resultOfExpire);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });

        expect(fetchLockedTxStub).to.have.been.calledOnceWithExactly(true);
        expect(unlockTxStub).to.have.been.calledOnceWithExactly([testTxId]);

        const expectedLogOptions = {
            initiator: testAccountId,
            timestamp: testCurrentTime.valueOf(),
            context: {
                transactionId: testTxId,
                oldTransactionStatus: 'LOCKED',
                newTransactionStatus: 'SETTLED'
            }
        };
        expect(publishStub).to.have.been.calledOnceWithExactly(testAccountId, 'LOCK_EXPIRED', expectedLogOptions);
    });
});
