'use strict';

const logger = require('debug')('jupiter:admin:consistency-test');
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
const getFloatLogsWithinPeriodStub = sinon.stub();

const handler = proxyquire('../admin-float-consistency', {
    './persistence/rds.float': {
        'getFloatBalanceAndFlows': getFloatBalanceAndFlowsStub,
        'getFloatAllocatedTotal': getFloatAllocatedTotalStub,
        'getUserAllocationsAndAccountTxs': getUserAllocationsStub,
        'insertFloatLog': insertFloatLogStub,
        'getFloatLogsWithinPeriod': getFloatLogsWithinPeriodStub,
        '@noCallThru': true
    },
    './persistence/dynamo.float': {
        'listClientFloats': listClientFloatsStub
    }
});

const resetStubs = () => {
    getFloatBalanceAndFlowsStub.reset();
    getFloatAllocatedTotalStub.reset();
    getUserAllocationsStub.reset();
    insertFloatLogStub.reset();
    listClientFloatsStub.reset();
    getFloatLogsWithinPeriodStub.reset();
};

describe('*** UNIT TEST ADMIN FLOAT CONSISTENCY ***', () => {

    beforeEach(() => {
       resetStubs();
    });

    it('Asserts float consistency accross all databases', async () => {
        const testFloatId = uuid();
        const testClientId = uuid();
        const testFloatBalanceMap = new Map([[testFloatId, { currency: { amount: 100, unit: 'HUNDREDTH_CENT' } }]]);

        getFloatBalanceAndFlowsStub.withArgs([testFloatId]).resolves(testFloatBalanceMap);
        getFloatAllocatedTotalStub.withArgs(testClientId, testFloatId).resolves({
            currency: { amount: 100, unit: 'HUNDREDTH_CENT' }
        });
        getUserAllocationsStub.withArgs(testClientId, testFloatId).resolves({
            floatAccountTotal: {
                currency: { amount: 100, unit: 'HUNDREDTH_CENT' }
            },
            accountTxTotal: {
                currency: { amount: 100, unit: 'HUNDREDTH_CENT' }                
            }
        });
        insertFloatLogStub.resolves();
        listClientFloatsStub.withArgs().resolves([
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId }
        ]);

        const expectedResult = { result: 'NO_ANOMALIES' };

        const result = await handler.checkAllFloats();
        logger('Result of anomaly checks', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([expectedResult, expectedResult, expectedResult]);
        expect(getFloatBalanceAndFlowsStub).to.have.been.calledWith([testFloatId]);
        expect(getFloatAllocatedTotalStub).to.have.been.calledWith(testClientId, testFloatId);
        expect(getUserAllocationsStub).to.have.been.calledWith(testClientId, testFloatId);
        expect(insertFloatLogStub).to.have.not.been.called;
        expect(listClientFloatsStub).to.have.been.calledOnceWithExactly();
    });

    it('Catches anomalies', async () => {
        const testFloatId = uuid();
        const testClientId = uuid();
        const testCurrency = 'USD';

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

        const anomalyLogEntry = {
            clientId: testClientId,
            floatId: testFloatId,
            logType: 'ALLOCATION_TOTAL_MISMATCH',
            logContext: testAnomaly
        };

        const testFloatBalanceMap = new Map([[testFloatId, { [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' } }]]);

        getFloatBalanceAndFlowsStub.withArgs([testFloatId]).resolves(testFloatBalanceMap);
        getFloatAllocatedTotalStub.withArgs(testClientId, testFloatId).resolves({
            [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }
        });
        getUserAllocationsStub.withArgs(testClientId, testFloatId).resolves({
            floatAccountTotal: {
                [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }
            },
            accountTxTotal: {
                [testCurrency]: { amount: 101, unit: 'HUNDREDTH_CENT' }                
            }
        });
        insertFloatLogStub.withArgs(anomalyLogEntry).resolves({ result: 'SUCCESS' });
        listClientFloatsStub.withArgs().resolves([
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId }
        ]);
        getFloatLogsWithinPeriodStub.resolves(null);

        const result = await handler.checkAllFloats();
        logger('Result of anomaly checks', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([expectedResult, expectedResult, expectedResult]);
        expect(getFloatBalanceAndFlowsStub).to.have.been.calledWith([testFloatId]);
        expect(getFloatAllocatedTotalStub).to.have.been.calledWith(testClientId, testFloatId);
        expect(getUserAllocationsStub).to.have.been.calledWith(testClientId, testFloatId);
        expect(insertFloatLogStub).to.have.been.calledWith(anomalyLogEntry);
        expect(listClientFloatsStub).to.have.been.calledWith();
        expect(getFloatLogsWithinPeriodStub.callCount).to.equal(3);
    });

    it('Catches anomalies when new anomaly logs have NO DUPLICATES', async () => {
        const testFloatId = uuid();
        const testClientId = uuid();
        const testCurrency = 'USD';

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

        const anomalyLogEntry = {
            clientId: testClientId,
            floatId: testFloatId,
            logType: 'ALLOCATION_TOTAL_MISMATCH',
            logContext: testAnomaly
        };

        const testFloatBalanceMap = new Map([[testFloatId, { [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' } }]]);

        getFloatBalanceAndFlowsStub.withArgs([testFloatId]).resolves(testFloatBalanceMap);
        getFloatAllocatedTotalStub.withArgs(testClientId, testFloatId).resolves({
            [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }
        });
        getUserAllocationsStub.withArgs(testClientId, testFloatId).resolves({
            floatAccountTotal: {
                [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }
            },
            accountTxTotal: {
                [testCurrency]: { amount: 101, unit: 'HUNDREDTH_CENT' }
            }
        });
        insertFloatLogStub.withArgs(anomalyLogEntry).resolves({ result: 'SUCCESS' });
        listClientFloatsStub.withArgs().resolves([
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId }
        ]);
        const testLogsFetchedFromDBWithNoDuplicates = [
            { clientId: testClientId, floatId: testFloatId, logType: 'BALANCE_MISMATCH' }
        ];
        getFloatLogsWithinPeriodStub.resolves(testLogsFetchedFromDBWithNoDuplicates);

        const result = await handler.checkAllFloats();
        logger('Result of anomaly checks', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([expectedResult, expectedResult, expectedResult]);
        expect(getFloatBalanceAndFlowsStub).to.have.been.calledWith([testFloatId]);
        expect(getFloatAllocatedTotalStub).to.have.been.calledWith(testClientId, testFloatId);
        expect(getUserAllocationsStub).to.have.been.calledWith(testClientId, testFloatId);
        expect(insertFloatLogStub).to.have.been.calledWith(anomalyLogEntry);
        expect(listClientFloatsStub).to.have.been.calledWith();
        expect(getFloatLogsWithinPeriodStub.callCount).to.equal(3);
    });

    it('Filter anomalies when new anomaly logs HAVE DUPLICATES', async () => {
        const testFloatId = uuid();
        const testClientId = uuid();
        const testCurrency = 'USD';

        const expectedResult = {
            result: 'NO_ANOMALIES'
        };

        const testFloatBalanceMap = new Map([[testFloatId, { [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' } }]]);

        getFloatBalanceAndFlowsStub.withArgs([testFloatId]).resolves(testFloatBalanceMap);
        getFloatAllocatedTotalStub.withArgs(testClientId, testFloatId).resolves({
            [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }
        });
        getUserAllocationsStub.withArgs(testClientId, testFloatId).resolves({
            floatAccountTotal: {
                [testCurrency]: { amount: 100, unit: 'HUNDREDTH_CENT' }
            },
            accountTxTotal: {
                [testCurrency]: { amount: 101, unit: 'HUNDREDTH_CENT' }
            }
        });
        listClientFloatsStub.withArgs().resolves([
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId },
            { clientId: testClientId, floatId: testFloatId }
        ]);
        const testLogsFetchedFromDBWithDuplicates = [
            { clientId: testClientId, floatId: testFloatId, logType: 'ALLOCATION_TOTAL_MISMATCH' }
        ];
        getFloatLogsWithinPeriodStub.resolves(testLogsFetchedFromDBWithDuplicates);

        const result = await handler.checkAllFloats();
        logger('Result of anomaly checks', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([expectedResult, expectedResult, expectedResult]);
        expect(getFloatBalanceAndFlowsStub).to.have.been.calledWith([testFloatId]);
        expect(getFloatAllocatedTotalStub).to.have.been.calledWith(testClientId, testFloatId);
        expect(getUserAllocationsStub).to.have.been.calledWith(testClientId, testFloatId);
        expect(insertFloatLogStub).to.not.have.been.called;
        expect(listClientFloatsStub).to.have.been.calledWith();
        expect(getFloatLogsWithinPeriodStub.callCount).to.equal(3);
    });
});
