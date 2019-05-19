process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:float:test');
const config = require('config');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);
const proxyquire = require('proxyquire');

const common = require('./common');
const constants = require('../constants');

const fetchStub = sinon.stub();

const dynamo = proxyquire('../persistence/dynamodb', {
    'dynamo-common': {
        fetchSingleRow: fetchStub
    },
    '@noCallThru': true
});

describe('** UNIT TESTING DYNAMODB ***', () => {

    before(() => {
        const validKey = { clientId: common.testValidClientId, floatId: common.testValidFloatId };
        fetchStub.withArgs(config.get('tables.clientFloatVars'), validKey).returns({
            bonusPoolShareOfAccrual: common.testValueBonusPoolShare,
            bonusPoolSystemWideId: common.testValueBonusPoolTracker,
            clientShareOfAccrual: common.testValueClientShare,
            clientShareSystemWideId: common.testValueClientCompanyTracker
        });
    });

    afterEach(() => fetchStub.resetHistory());
    after(() => fetchStub.reset());

    it('Fetches the correct bonus share', async () => {
        // note: e13 = 1 * 10^13 = 1 billion rand (1e9) in hundredths of cents
        const resultOfCall = await dynamo.fetchConfigVarsForFloat(common.testValidClientId, common.testValidFloatId);
        expect(fetchStub).to.be.calledOnce;
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.have.property('bonusPoolShare', common.testValueBonusPoolShare);
        expect(resultOfCall).to.have.property('bonusPoolTracker', common.testValueBonusPoolTracker);
    });

    it('Fetches the correct company share', async () => {
        const resultOfCall = await dynamo.fetchConfigVarsForFloat(common.testValidClientId, common.testValidFloatId);
        expect(fetchStub).to.be.calledOnce;
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.have.property('clientCoShare', common.testValueClientShare);
        expect(resultOfCall).to.have.property('clientCoShareTracker', common.testValueClientCompanyTracker);
    });

});

// restore when we expand out into all of the errors
// describe('Error fetches', () => {

//     before(() => {
//         const invalidClientid = { ClientId: common.testValidClientId + '1', FloatId: common.testValidFloatId };
//         const invalidFloatId = { ClientId: common.testValidClientId, FloatId: common.testValidFloatId + '_1' };
//         const invalidBothIds = { ClientId: common.testValidClientId + '1', FloatId: common.testValidFloatId + '_1' };

//         fetchStub.withArgs({TableName: config.get('tables.clientFloatVars'), Key: invalidClientid }).returns({
//             promise: () => { throw new ReferenceError(`No entry found for client ${common.testValidClientId + '1'} and float ${common.testValidFloatId}`); }
//         });
//         fetchStub.withArgs({TableName: config.get('tables.clientFloatVars'), Key: invalidFloatId }).returns({
//             promise: () => { throw new ReferenceError(`No entry found for client ${common.testValidClientId} and float ${common.testValidFloatId} + '_1`)}
//         });
//         fetchStub.withArgs({TableName: config.get('tables.clientFloatVars'), Key: invalidBothIds }).returns({
//             promise: () => { throw new ReferenceError(`No entry found for client ${common.testValidClientId + '1'} and float ${common.testValidFloatId + '_1'}`)}
//         });
//     });

//     after(() => {
//         fetchStub.reset();
//     });

//     it('Throws the appropriate error if given the wrong client Id', async () => {
//         expect(dynamo.fetchConfigVarsForFloat.bind(dynamo, common.testValidClientId + '1', common.testValidFloatId))
//             .to.throw(ReferenceError, `No entry found for client ${common.testValidClientId + '1'} and float ${common.testValidFloatId}`);
//         expect(stub).to.be.calledOnce;
//     });

//     it('Throws the appropriate error if given the wrong float Id', async () => {
//         expect(dynamo.fetchConfigVarsForFloat.bind(dynamo, common.testValidClientId, common.testValidFloatId + '_1'))
//             .to.throw(ReferenceError, `No entry found for client ${common.testValidClientId} and float ${common.testValidFloatId + '_1'}`);
//         expect(stub).to.be.calledOnce;
//     });

//     it('Throws the appropriate error if given bad IDs for both fields', async () => {
//         expect(dynamo.fetchConfigVarsForFloat.bind(dynamo, common.testValidClientId + '1', common.testValidFloatId + '_1'))
//             .to.throw(ReferenceError, `No entry found for client ${common.testValidClientId + '1'} and float ${common.testValidFloatId + '_1'}`);
//         expect(stub).to.be.calledOnce;
//     });

// });