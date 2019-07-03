'use strict';

process.env.NODE_ENV = 'test';

const config = require('config');
const logger = require('debug')('pluto:activity:test');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
chai.use(sinonChai);
const expect = chai.expect;

const proxyquire = require('proxyquire');
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
    'timeZone': 'America/New_York'
};

describe('** UNIT TESTING DYNAMO FETCH **', () => {

    before(() => {
        fetchStub.withArgs(config.get('tables.clientFloatVars'), { 
            clientId: testClientId,
            floatId: testFloatId
        }, ['accrualRateBps', 'bonusPoolShare', 'clientCoShare', 'prudentialDiscount', 'timeZone']).resolves(expectedFloatParameters);
    });

    beforeEach(() => fetchStub.reset());

    it('Fetches paramaters correctly when passed both IDs', async () => {
        const fetchedParams = await dynamo.fetchFloatVarsForBalanceCalc(testClientId, testFloatId);
        expect(fetchedParams).to.exist;
        expect(fetchedParams).to.deep.equal(expectedFloatParameters);
    });

    it('Returns gracefully when cannot find variables for client/float pair', () => {
        logger('**** TO TEST: Graceful exit on bad client float pair');
    });

    it('Throws an error when missing one of the two needed IDs', () => {
        logger('**** TO TEST: Graceful exist on insufficient params')
    });

});
