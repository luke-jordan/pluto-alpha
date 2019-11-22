'use strict';

process.env.NODE_ENV = 'test';

const config = require('config');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
chai.use(sinonChai);
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();
const fetchStub = sinon.stub();

const dynamo = proxyquire('../persistence/dynamodb', {
    'dynamo-common': {
        fetchSingleRow: fetchStub
    },
    '@noCallThru': true
});

const testClientId = 'a_client_somewhere';
const testFloatId = 'usd_cash_primary';

const expectedFloatParameters = {
    'accrualRateBps': 250,
    'bonusPoolShare': 0.1,
    'clientCoShare': 0.1,
    'prudentialDiscount': 0.1,
    'timeZone': 'America/New_York',
    'currency': 'USD'
};

describe('** UNIT TESTING DYNAMO FETCH **', () => {

    before(() => {
        fetchStub.withArgs(config.get('tables.clientFloatVars'), { 
            clientId: testClientId,
            floatId: testFloatId
        }, ['accrualRateAnnualBps', 'bonusPoolShareOfAccrual', 'clientShareOfAccrual', 'prudentialFactor', 'defaultTimezone', 'currency']).
        resolves(expectedFloatParameters);
    });

    beforeEach(() => fetchStub.resetHistory());

    it('Fetches paramaters correctly when passed both IDs', async () => {
        const fetchedParams = await dynamo.fetchFloatVarsForBalanceCalc(testClientId, testFloatId);
        expect(fetchedParams).to.exist;
        expect(fetchedParams).to.deep.equal(expectedFloatParameters);
    });

    it('Throws an error when cannot find variables for client/float pair', async () => {
        const badClientId = `${testClientId}_mangled`;
        const expectedError = `Error! No config variables found for client-float pair: ${badClientId}-${testFloatId}`;
        await expect(dynamo.fetchFloatVarsForBalanceCalc(badClientId, testFloatId)).to.be.rejectedWith(expectedError);
    });

    it('Throws an error when missing one of the two needed IDs', async () => {
        const errorMsg = 'Error! One of client ID or float ID missing';
        await expect(dynamo.fetchFloatVarsForBalanceCalc(testClientId)).to.be.rejectedWith(errorMsg);
    });

    it('Handles warm up call', async () => {
        fetchStub.withArgs(config.get('tables.clientFloatVars'), { clientId: 'non', floatId: 'existent' }).resolves({});
        const warmupResult = await dynamo.warmupCall();
        expect(warmupResult).to.deep.equal({});
        expect(fetchStub).to.have.been.calledOnceWithExactly(config.get('tables.clientFloatVars'), { clientId: 'non', floatId: 'existent' });
    });

});
