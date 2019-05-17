process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:float:test');
const config = require('config');

const AWS = require('aws-sdk');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
const expect = chai.expect;
chai.use(sinonChai);

const docClient = new AWS.DynamoDB.DocumentClient();

let stub = sinon.stub(docClient, 'get');

const common = require('./common');
const constants = require('../constants');

const dynamo = require('../persistence/dynamodb');

describe('Happy path fetches', () => {

    before(() => {
        const validKey = { ClientId: common.testValidClientId, FloatId: common.testValidFloatId };
        stub.withArgs({TableName: config.get('tables.clientFloatVars'), Key: validKey}).returns({
            promise: () => { return {
                Item: {
                    BonusPoolShare: common.testValueBonusPoolShare,
                    BonusPoolTracker: common.testValueBonusPoolTracker,
                    CompanyShare: common.testValueCompanyShare,
                    CompanyShareTracker: common.testValueClientCompanyTracker
                }
            }}
        });
    });

    after(() => {
        stub.restore();
    });

    it('Fetches the correct bonus share', async () => {
        // note: e13 = 1 * 10^13 = 1 billion rand (1e9) in hundredths of cents
        const resultOfCall = await dynamo.fetchSharesAndTrackersForFloat(common.testValidClientId, common.testValidFloatId);
        expect(stub).to.be.calledOnce;
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.have.property('bonusPoolShare', common.testValueBonusPoolShare);
        expect(resultOfCall).to.have.property('bonusPoolSystemWideId', common.testValueBonusPoolTracker);
    });

    it('Fetches the correct company share', async () => {
        const resultOfCall = await dynamo.fetchSharesAndTrackersForFloat(common.testValidClientId, common.testValidFloatId);
        expect(stub).to.be.calledOnce;
        expect(resultOfCall).to.exist;
        expect(resultOfCall).to.have.property('clientShare', common.testValueCompanyShare);
        expect(resultOfCall).to.have.property('clientShareAccSystemWideId', common.testValueCompanyShare);
    });

});

describe('Error fetches', () => {

    before(() => {
        const invalidClientid = { ClientId: common.testValidClientId + '1', FloatId: common.testValidFloatId };
        const invalidFloatId = { ClientId: common.testValidClientId, FloatId: common.testValidFloatId + '_1' };
        const invalidBothIds = { ClientId: common.testValidClientId + '1', FloatId: common.testValidFloatId + '_1' };

        stub.withArgs({TableName: config.get('tables.clientFloatVars'), Key: invalidClientid }).returns({
            promise: () => { throw new ReferenceError(`No entry found for client ${common.testValidClientId + '1'} and float ${common.testValidFloatId}`); }
        });
        stub.withArgs({TableName: config.get('tables.clientFloatVars'), Key: invalidFloatId }).returns({
            promise: () => { throw new ReferenceError(`No entry found for client ${common.testValidClientId} and float ${common.testValidFloatId} + '_1`)}
        });
        stub.withArgs({TableName: config.get('tables.clientFloatVars'), Key: invalidBothIds }).returns({
            promise: () => { throw new ReferenceError(`No entry found for client ${common.testValidClientId + '1'} and float ${common.testValidFloatId + '_1'}`)}
        });
    });

    after(() => {
        stub.restore();
    });

    it('Throws the appropriate error if given the wrong client Id', async () => {
        expect(dynamo.fetchSharesAndTrackersForFloat.bind(dynamo, common.testValidClientId + '1', common.testValidFloatId))
            .to.throw(ReferenceError, `No entry found for client ${common.testValidClientId + '1'} and float ${common.testValidFloatId}`);
        expect(stub).to.be.calledOnce;
    });

    it('Throws the appropriate error if given the wrong float Id', async () => {
        expect(dynamo.fetchSharesAndTrackersForFloat.bind(dynamo, common.testValidClientId, common.testValidFloatId + '_1'))
            .to.throw(ReferenceError, `No entry found for client ${common.testValidClientId} and float ${common.testValidFloatId + '_1'}`);
        expect(stub).to.be.calledOnce;
    });

    it('Throws the appropriate error if given bad IDs for both fields', async () => {
        expect(dynamo.fetchSharesAndTrackersForFloat.bind(dynamo, common.testValidClientId + '1', common.testValidFloatId + '_1'))
            .to.throw(ReferenceError, `No entry found for client ${common.testValidClientId + '1'} and float ${common.testValidFloatId + '_1'}`);
        expect(stub).to.be.calledOnce;
    });

});