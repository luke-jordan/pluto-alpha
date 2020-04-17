'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');
const moment = require('moment');

const helper = require('./test-helper');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
chai.use(sinonChai);
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();

const multiTableStub = sinon.stub();
const multiOpStub = sinon.stub();
const updateStub = sinon.stub();
const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.updateRecord = updateStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiOpStub;
    }
}

const persistence = proxyquire('../persistence/write.friends', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub    
});


describe('*** UNIT TEST HANDLE PROFILE PERSISTENCE FUNCTIONS ***', async () => {
    const friendTable = config.get('tables.friendTable');
    const friendRequestTable = config.get('tables.friendRequestTable');

    const testInsertionTime = moment().format();
    const testUpdaedTime = moment();

    const testLogId = uuid();
    const testIniatedUserId = uuid();
    const testTargetUserId = uuid();
    const testAcceptedUserId = uuid();
    const testRequestId = uuid();
    const testRelationshipId = uuid();

    beforeEach(() => {
        helper.resetStubs(multiTableStub, multiOpStub, updateStub, uuidStub);
    });

    it('Inserts friend request, filters out extra params', async () => {
        const testFriendRequest = {
            requestId: testRequestId,
            requestStatus: 'PENDING',
            initiatedUserId: testIniatedUserId,
            targetUserId: testTargetUserId
        };

        const testFriendQueryDef = {
            query: `insert into ${friendRequestTable} (request_id, request_status, initiated_user_id, target_user_id) values %L returning request_id, creation_time`,
            columnTemplate: '${requestId}, ${requestStatus}, ${initiatedUserId}, ${targetUserId}',
            rows: [testFriendRequest]
        };

        const testLogObject = {
            logId: testLogId,
            requestId: testRequestId,
            logType: 'FRIENDSHIP_REQUESTED',
            logContext: testFriendRequest
        };

        const testLogDef = {
            query: 'insert into friend_data.friend_log (log_id, request_id, log_type, log_context) values %L returning log_id, creation_time',
            columnTemplate: '${logId}, ${requestId}, ${logType}, ${logContext}',
            rows: [testLogObject]
        };

        uuidStub.onFirstCall().returns(testRequestId);
        uuidStub.onSecondCall().returns(testLogId);
        multiTableStub.resolves([
            [{ 'request_id': testRequestId, 'creation_time': testInsertionTime }],
            [{ 'log_id': testLogId, 'creation_time': testInsertionTime }]
        ]);

        const testInsertParams = { initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId, extra: 'param' };
        const insertResult = await persistence.insertFriendRequest(testInsertParams);
        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal({ requestId: testRequestId, logId: testLogId });
        expect(multiTableStub).to.have.been.calledOnceWithExactly([testFriendQueryDef, testLogDef]);
    });

    it('Connects a user to a friends request', async () => {
        const testRequestCode = 'ANCIENT COFFEE';
        const updateQuery = `update ${friendRequestTable} set target_user_id = $1, request_code = null where request_code = $2 ` +
            `returning request_id, updated_time`;
        const updateValues = [testTargetUserId, testRequestCode];
        updateStub.withArgs(updateQuery, updateValues).resolves({ rows: [{ 'request_id': testRequestId, 'updated_time': testUpdaedTime.format() }]});

        const connectionResult = await persistence.connectUserToFriendRequest(testTargetUserId, testRequestCode);
        expect(connectionResult).to.exist;
        expect(connectionResult).to.deep.equal([{ requestId: testRequestId, updatedTime: testUpdaedTime.format() }]);
    });

    it('Inserts friendship properly', async () => {
        const friendReqUpdateDef = {
            table: friendTable,
            key: { requestId: testRequestId },
            value: { requestStatus: 'ACCEPTED' },
            returnClause: 'updated_time'
        };

        const friendshipObject = {
            relationshipId: testRelationshipId,
            initiatedUserId: testIniatedUserId,
            acceptedUserId: testAcceptedUserId,
            relationshipStatus: 'ACTIVE'
        };

        const testFriendQueryDef = {
            query: 'insert into friends_data.core_friend_relationship (relationship_id, initiated_user_id, accepted_user_id, relationship_status) values %L returning relationship_id, creation_time',
            columnTemplate: '${relationshipId}, ${initiatedUserId}, ${acceptedUserId}, ${relationshipStatus}',      
            rows: [friendshipObject]
        };

        const testLogObject = {
            logId: testLogId,
            relationshipId: testRelationshipId,
            logType: 'FRIENDSHIP_ACCEPTED',
            logContext: friendshipObject
        };

        const testLogDef = {
            query: 'insert into friend_data.friend_log (log_id, relationship_id, log_type, log_context) values %L returning log_id, creation_time',
            columnTemplate: '${logId}, ${relationshipId}, ${logType}, ${logContext}',
            rows: [testLogObject]
        };

        uuidStub.onFirstCall().returns(testRelationshipId);
        uuidStub.onSecondCall().returns(testLogId);
        multiOpStub.withArgs([friendReqUpdateDef], [testFriendQueryDef, testLogDef]).resolves([
            [{ 'updated_time': testUpdaedTime.format()}],
            [{ 'relationship_id': testRelationshipId, 'creation_time': testInsertionTime }, { 'log_id': testLogId, 'creation_time': testInsertionTime }]
        ]);

        const insertResult = await persistence.insertFriendship(testRequestId, testIniatedUserId, testAcceptedUserId);
        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal({
            updatedTime: testUpdaedTime.format(),
            relationshipId: testRelationshipId,
            logId: testLogId
        });
    });

    it('Deactivates friendship', async () => {
        const testUpdateFriendshipDef = {
            table: friendTable,
            key: { relationshipId: testRelationshipId },
            value: { relationshipStatus: 'DEACTIVATED' },
            returnClause: 'updated_time'
        };

        const testLogObject = {
            logId: testLogId,
            relationshipId: testRelationshipId,
            logType: 'FRIENDSHIP_DEACTIVATED',
            logContext: { relationshipId: testRelationshipId }
        };

        const testInsertLogDef = {
            query: 'insert into friend_data.friend_log (log_id, relationship_id, log_type, log_context) values %L returning log_id, creation_time',
            columnTemplate: '${logId}, ${relationshipId}, ${logType}, ${logContext}',
            rows: [testLogObject]
        };

        uuidStub.returns(testLogId);
        multiOpStub.resolves([
            [{ 'updated_time': testUpdaedTime.format()}],
            [{ 'log': testLogId, 'creation_time': testInsertionTime }]
        ]);
        
        const updateResult = await persistence.deactivateFriendship(testRelationshipId);
        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal({ updatedTime: testUpdaedTime.format() });
        expect(multiOpStub).to.have.been.calledOnceWithExactly([testUpdateFriendshipDef], [testInsertLogDef]);
    });

});
