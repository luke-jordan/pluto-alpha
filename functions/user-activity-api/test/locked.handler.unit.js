'use strict';

const logger = require('debug')('jupiter:locked-saves:test');
const uuid = require('uuid');
const moment = require('moment');

const testHelper = require('./test.helper');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const lamdbaInvokeStub = sinon.stub();
const fetchFloatVarsStub = sinon.stub();

const proxyquire = require('proxyquire').noCallThru();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

const handler = proxyquire('../locked-handler', {
    './persistence/dynamodb': {
        'fetchFloatVarsForBalanceCalc': fetchFloatVarsStub,
        '@noCallThru': true
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient,
         // eslint-disable-next-line no-empty-function
        'config': { update: () => ({}) }
    }
});

describe('*** UNIT TEST LOCKED SAVE BONUS PREVIEW ***', () => {
    const testSystemId = uuid();

    const testUserProfile = {
        systemWideUserId: testSystemId,
        clientId: 'some_client',
        defaultFloatId: 'primary_cash',
        defaultCurrency: 'USD',
        defaultTimezone: 'America/California'
    };

    const testFloatProjectionVars = {
        accrualRateAnnualBps: 250,
        lockedSaveBonus: { 30: 1.01, 60: 1.05, 90: 1.1 }
    };

    const mockLambdaResponse = (body, statusCode = 200) => ({
        Payload: JSON.stringify({
            statusCode,
            body: JSON.stringify(body)
        })
    });

    it('Calculated projected bonus for locked saves by number of locked days', async () => {  
        const testUserBalance = {
            currentBalance: {
                amount: 1000000,
                unit: 'HUNDREDTH_CENT',
                currency: 'USD',
                datetime: moment().format(),
                epochMilli: moment().valueOf(),
                timezone: 'America/California'
            }
        };

        lamdbaInvokeStub.onFirstCall().returns({ promise: () => mockLambdaResponse(testUserProfile) });
        lamdbaInvokeStub.onSecondCall().returns({ promise: () => mockLambdaResponse(testUserBalance) });

        fetchFloatVarsStub.resolves(testFloatProjectionVars);

        const testEventBody = { clientId: 'some_client', floatId: 'primary_cash', daysToPreview: [30, 60] };
        const testEvent = testHelper.wrapEvent(testEventBody, testSystemId, 'ORDINARY_USER');

        const previewResult = await handler.previewBonus(testEvent);
        logger('Preview result: ', previewResult);

        expect(previewResult).to.exist;
        const resultBody = testHelper.standardOkayChecks(previewResult);

        const expectedResult = [
            { '30': { amount: 576112.5598535055, unit: 'HUNDREDTH_CENT', currency: 'USD' }},
            { '60': { amount: 1499980.0339483484, unit: 'HUNDREDTH_CENT', currency: 'USD' }}
        ];
        
        expect(resultBody).to.deep.equal(expectedResult);
    });
});
