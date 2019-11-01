'use strict';

const logger = require('debug')('jupiter:admin:consistency-test');
const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const getFloatBalanceAndFlowsStub = sinon.stub();
const getFloatAllocatedTotalStub = sinon.stub();
const getUserAllocationsStub = sinon.stub();
const insertFloatLogStub = sinon.stub();
const listClientFloatsStub = sinon.stub();

const handler = proxyquire('../admin-float-consistency', {
    './persistence/rds.float': {
        'getFloatBalanceAndFlows': getFloatBalanceAndFlowsStub,
        'getFloatAllocatedTotal': getFloatAllocatedTotalStub,
        'getUserAllocationsAndAccountTxs': getUserAllocationsStub,
        'insertFloatLog': insertFloatLogStub
    },
    './persistence/dynamo.float': {
        'listClientFloats': listClientFloatsStub
    }
});

describe('*** UNIT TEST ADMIN FLOAT CONSISTENCY ***', () => {

    it('Asserts float consistency accross all databases', async () => {
        const testFloatId = uuid();
        const testClientId = uuid();
        const testFloatBalanceMap = new Map([[testFloatId, { currency: { amount: 100, unit: 'HUNDREDTH_CENT' } }]]);

        getFloatBalanceAndFlowsStub.resolves(testFloatBalanceMap);
        getFloatAllocatedTotalStub.resolves({
            currency: { amount: 100, unit: 'HUNDREDTH_CENT' }
        });
        getUserAllocationsStub.resolves({
            floatAccountTotal: {
                currency: { amount: 100, unit: 'HUNDREDTH_CENT' }
            },
            accountTxTotal: {
                currency: { amount: 100, unit: 'HUNDREDTH_CENT' }                
            }
        });
        insertFloatLogStub.resolves();
        listClientFloatsStub.resolves([
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId }
        ]);

        const result = await handler.checkAllFloats();
        logger('Result of anomaly checks', result);
    });

    it('Catches anomalies', async () => {
        const testFloatId = uuid();
        const testClientId = uuid();
        const testFloatBalanceMap = new Map([[testFloatId, { currency: { amount: 100, unit: 'HUNDREDTH_CENT' } }]]);

        getFloatBalanceAndFlowsStub.resolves(testFloatBalanceMap);
        getFloatAllocatedTotalStub.resolves({
            currency: { amount: 100, unit: 'HUNDREDTH_CENT' }
        });
        getUserAllocationsStub.resolves({
            floatAccountTotal: {
                currency: { amount: 100, unit: 'HUNDREDTH_CENT' }
            },
            accountTxTotal: {
                currency: { amount: 101, unit: 'HUNDREDTH_CENT' }                
            }
        });
        insertFloatLogStub.resolves({ result: 'SUCCESS' });
        listClientFloatsStub.resolves([
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId }
        ]);

        const result = await handler.checkAllFloats();
        logger('Result of anomaly checks', result);
    });
});