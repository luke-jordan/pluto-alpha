'use strict';

const logger = require('debug')('pluto:auth:rds-util-tests');
const common = require('./common');
const uuid = require('uuid/v4');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
const expect = chai.expect;

let insertRecordsStub = sinon.stub();
let updateRecordStub = sinon.stub();
let selectQueryStub = sinon.stub();

class MockRdsConnection {
    constructor(any) {
        this.insertRecords = insertRecordsStub;
        this.updateRecord = updateRecordStub;
        this.selectQuery = selectQueryStub
    }
};

const rdsUtil = proxyquire('../utils/rds-util', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

const resetStubs = () => {
    insertRecordsStub.reset();
    updateRecordStub.reset();
    selectQueryStub.reset();
};

const mockUserCredentials = {
    systemWideUserId: uuid(),
    salt: uuid(),
    verifier: uuid(),
    serverEphemeralSecret: uuid()
};


describe('rds-util', () => {

    beforeEach(() => {
        resetStubs();
        insertRecordsStub
            .withArgs(...common.getInsertRecordsArgs(mockUserCredentials))
            .resolves({
                command: 'INSERT',
                rowCount: 1,
                oid: 0,
                rows:
                    [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ]
            });
        updateRecordStub
            .withArgs(...common.getUpdateRecordWithSaltAndVerifierArgs(mockUserCredentials))
            .resolves({
                command: 'UPDATE',
                rowCount: 1,
                oid: null,
                rows:
                    [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ]
            });
        updateRecordStub
            .withArgs(...common.getUpdateRecordWithServerEphemeralSecret(mockUserCredentials))
            .resolves({
                command: 'UPDATE',
                rowCount: 1,
                oid: null,
                rows:
                    [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ]
            })
        selectQueryStub
            .withArgs(...common.getUserCredentialsSelectQueryArgs(mockUserCredentials))
            .resolves([ { insertion_id: 111,
                system_wide_user_id: mockUserCredentials.systemWideUserId,
                salt:
                 '222492b306cfc5d...',
                verifier:
                 '386b67689881fae0...',
                server_ephemeral_secret: null,
                creation_time: '2049-06-22T07:38:30.016Z',
                update_time: '2049-06-22T07:38:30.016Z',
                tags: [],
                flags: [] } ])
    });

    it('should insert new user credentials', async () => {
        const expectedResult = {databaseResponse: [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ]};

        const result = await rdsUtil.insertUserCredentials(mockUserCredentials);
        logger('result of user credentials insertion:', result);
        logger('insertRecordStub called with args:', insertRecordsStub.getCall(0).args);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(...common.getInsertRecordsArgs(mockUserCredentials));
    });

    it('should update user salt and verifier', async () => {
        const expectedResult = {
            message: [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ],
            statusCode: 0
        };

        const result = await rdsUtil.updateUserSaltAndVerifier(mockUserCredentials.systemWideUserId, mockUserCredentials.salt, mockUserCredentials.verifier);
        logger('result from salt and verifier update:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...common.getUpdateRecordWithSaltAndVerifierArgs(mockUserCredentials));
    });

    it('should update server ephemeral secret', async () => {
        const expectedResult = [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ];

        const result = await rdsUtil.updateServerEphemeralSecret(mockUserCredentials.systemWideUserId, mockUserCredentials.serverEphemeralSecret);
        logger('result from server ephemeral secret update:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...common.getUpdateRecordWithServerEphemeralSecret(mockUserCredentials));
    });

    it('should get user credentials', async () => {
        const expectedResult = [ { insertion_id: 111,
            system_wide_user_id: mockUserCredentials.systemWideUserId,
            salt:
             '222492b306cfc5d...',
            verifier:
             '386b67689881fae0...',
            server_ephemeral_secret: null,
            creation_time: '2049-06-22T07:38:30.016Z',
            update_time: '2049-06-22T07:38:30.016Z',
            tags: [],
            flags: [] } ]

        const result = await rdsUtil.getUserCredentials(mockUserCredentials.systemWideUserId);
        logger('result from user credentials extraction from rds:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...common.getUserCredentialsSelectQueryArgs(mockUserCredentials));
    });

    // TODO: Exception tests
});