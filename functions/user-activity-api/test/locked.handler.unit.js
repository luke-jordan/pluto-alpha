'use strict';

// const logger = require('debug')('jupiter:locked-saves:test');
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
const fetchAccountsStub = sinon.stub();
const updateTxStatusStub = sinon.stub();
const updateTxTagsStub = sinon.stub();
const setLockDurationStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

const handler = proxyquire('../locked-handler', {
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsStub,
        '@noCallThru': true
    },
    './persistence/rds': {
        'fetchTransaction': fetchTxStub,
        'findAccountsForUser': fetchAccountsStub,
        'updateTxSettlementStatus': updateTxStatusStub,
        'updateTxTags': updateTxTagsStub,
        'setTxLockDuration': setLockDurationStub,
        '@noCallThru': true
    }
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

    it('Uses default multilier where locked save bonus not in client-float vars', async () => {
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

    it('Locks a settled save, updates transaction tags and sets lock duration', async () => {
        fetchTxStub.resolves(testTx);
        updateTxStatusStub.resolves(testUpdatedTime);
        updateTxTagsStub.resolves({ updatedTime: testUpdatedTime });
        setLockDurationStub.resolves({ updatedTime: testUpdatedTime });

        const testEventBody = {
            transactionId: testTxId,
            daysToLock: 30,
            lockBonusAmount: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' }
        };

        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const resultOfLock = await handler.lockSettledSave(testEvent);
        const resultBody = testHelper.standardOkayChecks(resultOfLock);

        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });
        
        expect(fetchTxStub).to.have.been.calledOnceWithExactly(testTxId);

        const expectedLogContext = {
            transactionId: testTxId,
            lockBonusAmount: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            daysToLock: 30,
            reasonToLog: 'User saving event locked'
        };

        const expectedStatusUpdateArgs = {
            transactionId: testTxId,
            settlementStatus: 'LOCKED',
            logToInsert: {
                systemWideUserId: testSystemId,
                accountId: testAccountId,
                logContext: expectedLogContext
            }
        };

        expect(updateTxStatusStub).to.have.been.calledOnceWithExactly(expectedStatusUpdateArgs);
        expect(updateTxTagsStub).to.have.been.calledOnceWithExactly(testTxId, 'LOCK_BONUS::10000::HUNDREDTH_CENT::USD');
        expect(setLockDurationStub).to.have.been.calledOnceWithExactly(testTxId, 30);
    });

});
