'use strict';

const helper = require('./test.helper');
const uuid = require('uuid/v4');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire');

const selectQueryStub = sinon.stub();
const updateRecordStub = sinon.stub();
const upsertRecordsStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = selectQueryStub;
        // this.freeFormInsert = freeFormStub;
        this.updateRecord = updateRecordStub;
        this.upsertRecords = upsertRecordsStub;
    }
}

const audienceSelection = proxyquire('../persistence.js', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const audienceTable = 'audience_data.audience';
const audienceJoinTable = 'audience_data.audience_account_join';

describe('Unit testing audience RDS aux functions, tables, etc', () => {

    beforeEach(() => helper.resetStubs(selectQueryStub, updateRecordStub, upsertRecordsStub));
    
    it(`should handle 'deactivate audience accounts' successfully`, async () => {
        const testAudienceId = uuid();
        const testAccountId = uuid();
        const expectedQuery = `update ${audienceJoinTable} set active = false where audience_id = $1 and active = true returning account_id`;
        const updateRecordResponse = { rows: [{ 'account_id': testAccountId }] };
        const expectedResult = [testAccountId];
        updateRecordStub.withArgs(expectedQuery, [testAudienceId]).resolves(updateRecordResponse);

        const result = await audienceSelection.deactivateAudienceAccounts(testAudienceId);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledWithExactly(expectedQuery, [testAudienceId]);
    });

    it(`should handle 'fetch audience object' successfully`, async () => {
        const testAudienceId = uuid();
        
        const expectedQuery = `select * from ${audienceTable} where audience_id = $1`;
        const selectRecordsResponse = [{ 'audience_id': testAudienceId, 'is_dynamic': true }];
        const expectedResult = { audienceId: testAudienceId, isDynamic: true };
        
        selectQueryStub.withArgs(expectedQuery, [testAudienceId]).resolves(selectRecordsResponse);

        const result = await audienceSelection.fetchAudience(testAudienceId);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledWithExactly(expectedQuery, [testAudienceId]);
    });

    it(`should handle 'upsert audience accounts' successfully`, async () => {
        const testAudienceId = uuid();
        const testAccountId1 = uuid();
        const testAccountId2 = uuid();
        const testActiveStatus = true;

        const testAudienceAccountIdsList = [testAccountId1, testAccountId2];

        const expectedQuery = `insert into ${audienceJoinTable} (audience_id, account_id) ` +
            `values ($1, $2), ($1, $3) on conflict (audience_id, account_id) do update set active = $4`;

        const upsertRecordsResponse = [{ 'account_id': testAccountId1 }];
        upsertRecordsStub.resolves(upsertRecordsResponse);

        const result = await audienceSelection.upsertAudienceAccounts(testAudienceId, testAudienceAccountIdsList);

        expect(result).to.exist;
        expect(result).to.deep.equal(upsertRecordsResponse);
        expect(upsertRecordsStub).to.have.been.calledWithExactly(expectedQuery, [testAudienceId, testAccountId1, testAccountId2, testActiveStatus]);
    });
});
