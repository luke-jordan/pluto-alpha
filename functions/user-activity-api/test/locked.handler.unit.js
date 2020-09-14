'use strict';

// const logger = require('debug')('jupiter:locked-saves:test');
const uuid = require('uuid');

const testHelper = require('./test.helper');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const fetchFloatVarsStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();


const handler = proxyquire('../locked-handler', {
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsStub,
        '@noCallThru': true
    }
});

describe('*** UNIT TEST LOCKED SAVE BONUS PREVIEW ***', () => {
    const testSystemId = uuid();

    const testFloatProjectionVars = {
        accrualRateAnnualBps: 250,
        lockedSaveBonus: { 30: 1.01, 60: 1.05, 90: 1.1 }
    };


    it('Calculates projected bonus for locked saves by number of locked days', async () => {  
        fetchFloatVarsStub.resolves(testFloatProjectionVars);

        const testEventBody = {
            clientId: 'some_client',
            floatId: 'primary_cash',
            amountDetails: { amount: 10000, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            daysToPreview: [1, 4, 30, 67]
        };

        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const previewResult = await handler.previewBonus(testEvent);
        const resultBody = testHelper.standardOkayChecks(previewResult);

        const expectedResult = {
            '1': { amount: 152.53390581494563, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            '4': { amount: 624.2380778166955, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            '30': { amount: 5761.125598535054, unit: 'HUNDREDTH_CENT', currency: 'USD' },
            '67': { amount: 17820.34234258725, unit: 'HUNDREDTH_CENT', currency: 'USD' }
        };
        
        expect(resultBody).to.deep.equal(expectedResult);
        expect(fetchFloatVarsStub).to.have.been.calledOnceWithExactly('some_client', 'primary_cash');
    });

    it('Handles invalid events and thrown errors', async () => {
        await expect(handler.previewBonus({ })).to.eventually.deep.equal({ statusCode: 400, body: 'Empty invocation' });
        await expect(handler.previewBonus({ clientId: 'some_client' })).to.eventually.deep.equal({ statusCode: 403 });

        fetchFloatVarsStub.throws(new Error('Dynamo error'));
        const testEvent = testHelper.wrapEvent({ clientId: 'some_client' }, testSystemId, 'ORDINARY_USER');
        const expectedResult = { statusCode: 500, headers: testHelper.expectedHeaders, body: JSON.stringify({ error: 'Dynamo error' }) };
        
        await expect(handler.previewBonus(testEvent)).to.eventually.deep.equal(expectedResult);
    });
});
