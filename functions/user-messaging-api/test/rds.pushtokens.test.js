'use strict';

const logger = require('debug')('jupiter:user-messaging:rds-test');
const config = require('config');
const uuid = require('uuid/v4');

const helper = require('./message.test.helper');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();

const insertRecordsStub = sinon.stub();
const updateRecordStub = sinon.stub();
const selectQueryStub = sinon.stub();
const deleteRowStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertRecordsStub;
        this.selectQuery = selectQueryStub;
        this.updateRecordObject = updateRecordStub;
        this.deleteRow = deleteRowStub;
    }
}

const rdsUtil = proxyquire('../persistence/rds.pushsettings', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

describe('*** UNIT TESTING PUSH TOKEN RDS FUNCTIONS ***', () => {
    const mockUserId = uuid();
    const mockPushToken = uuid();
    const mockProvider = uuid();
    const mockCreationTime = '2030-01-01T00:00:01.016Z';

    beforeEach(() => helper.resetStubs(insertRecordsStub, selectQueryStub, updateRecordStub, deleteRowStub));

    it('should persist push token', async () => {
        const mockPersistableToken = {
            userId: mockUserId,
            pushProvider: mockProvider,
            pushToken: mockPushToken
        };

        const mockInsertionArgs = [
            `insert into ${config.get('tables.pushTokenTable')} (${helper.extractQueryClause(Object.keys(mockPersistableToken))}) values %L returning insertion_id, creation_time`,
            helper.extractColumnTemplate(Object.keys(mockPersistableToken)),
            [mockPersistableToken]
        ];

        insertRecordsStub.withArgs(...mockInsertionArgs).resolves({ rows: [{ 'insertion_id': 1, 'creation_time': mockCreationTime }] });
        const expectedResult = [{ 'insertionId': 1, 'creationTime': mockCreationTime }];

        const result = await rdsUtil.insertPushToken(mockPersistableToken);
        logger('Result of push token insertion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(...mockInsertionArgs);
    });

    it('should get push token', async () => {
        const mockSelectArgs = [
            `select user_id, push_token from ${config.get('tables.pushTokenTable')} where active = true and push_provider = $1 and  user_id in ($2) order by creation_time asc`,
            [mockProvider, mockUserId]
        ];

        selectQueryStub.withArgs(...mockSelectArgs).resolves([{ 'user_id': mockUserId, 'push_token': mockPushToken }]);

        const expectedResult = { [mockUserId]: mockPushToken };

        const result = await rdsUtil.getPushTokens([mockUserId], mockProvider);
        logger('Result of push token extraction:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectArgs);
    });

    it('should deactivate push token', async () => {
        const mockUpdateArgs = [{
            table: config.get('tables.pushTokenTable'),
            key: { userId: mockUserId,
            provider: mockProvider },
            value: { active: false },
            returnClause: 'insertion_time'
        }];

        updateRecordStub.resolves([{ insertion_id: 2 }]);

        const result = await rdsUtil.deactivatePushToken(mockProvider, mockUserId);
        logger('Result of push token deactivation:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal([{ insertionId: 2 }]);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...mockUpdateArgs);
    });

    it('should delete push token if no token given', async () => {
        // we restrict multi-row deletes so first get the insertion IDs, then delete them
        const selectIds = `select insertion_id from ${config.get('tables.pushTokenTable')} where push_provider = $1 and user_id = $2`;
        selectQueryStub.withArgs(selectIds, [mockProvider, mockUserId]).resolves([{ 'insertion_id': 111 }, { 'insertion_id': 118 }]);

        const mockDeleteRowArgs = (insertionId) => [config.get('tables.pushTokenTable'), ['insertion_id'], [insertionId]];

        deleteRowStub.resolves({ command: 'DELETE', rowCount: 1, rows: [] });

        const expectedResult = { deleteCount: 2 };

        const result = await rdsUtil.deletePushToken({ provider: mockProvider, userId: mockUserId });
        logger('Result of push token deletion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(selectIds, [mockProvider, mockUserId]);    
        expect(deleteRowStub).to.have.been.calledTwice;
        expect(deleteRowStub).to.have.been.calledWithExactly(...mockDeleteRowArgs(111));
        expect(deleteRowStub).to.have.been.calledWithExactly(...mockDeleteRowArgs(118));
    });

    // use the user ID as well to effectively prevent someone deleting another user's ID
    it('Should delete push token if token itself given', async () => {
        const testToken = 'THISTOKEN';
        const mockDeleteRowArgs = [config.get('tables.pushTokenTable'), ['push_token', 'user_id'], [testToken, mockUserId]];
        
        deleteRowStub.resolves({ command: 'DELETE', rowCount: 1 });

        const result = await rdsUtil.deletePushToken({ token: testToken, userId: mockUserId });
        expect(result).to.deep.equal({ deleteCount: 1 });
        expect(deleteRowStub).to.have.been.calledOnceWithExactly(...mockDeleteRowArgs);
    });
});
