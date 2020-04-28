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
const queryStub = sinon.stub();
const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = queryStub;
        this.updateRecord = updateStub;
        this.largeMultiTableInsert = multiTableStub;
        this.multiTableUpdateAndInsert = multiOpStub;
    }
}

const persistence = proxyquire('../persistence/write.friends', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub    
});

describe('*** UNIT TEST PERSISTENCE WRITE FUNCTIONS ***', async () => {
    const friendshipTable = config.get('tables.friendshipTable');
    const friendReqTable = config.get('tables.friendRequestTable');
    const friendLogTable = config.get('tables.friendLogTable');

    const testInsertionTime = moment().format();
    const testUpdatedTime = moment().format();

    const testLogId = uuid();
    const testIniatedUserId = uuid();
    const testTargetUserId = uuid();
    const testAcceptedUserId = uuid();
    const testRequestId = uuid();
    const testRelationshipId = uuid();

    beforeEach(() => {
        helper.resetStubs(multiTableStub, multiOpStub, updateStub, queryStub, uuidStub);
    });

    it('Inserts friend request properly', async () => {
        const testFriendRequest = {
            requestId: testRequestId,
            requestStatus: 'PENDING',
            initiatedUserId: testIniatedUserId,
            targetUserId: testTargetUserId,
            requestedShareItems: ['ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', 'BALANCE'],
            targetContactDetails: {
                contactType: 'EMAIL',
                contactMethod: 'example@domain.com'
            }
        };

        const testFriendQueryDef = {
            query: `insert into ${friendReqTable} (initiated_user_id, target_user_id, requested_share_items, target_contact_details, ` +
                `request_id, request_status) values %L returning request_id, creation_time`,
            columnTemplate: '${initiatedUserId}, ${targetUserId}, ${requestedShareItems}, ${targetContactDetails}, ${requestId}, ${requestStatus}',
            rows: [testFriendRequest]
        };

        const testLogObject = {
            logId: testLogId,
            requestId: testRequestId,
            logType: 'FRIENDSHIP_REQUESTED',
            logContext: testFriendRequest
        };

        const testLogDef = {
            query: `insert into ${friendLogTable} (log_id, request_id, log_type, log_context) values %L returning log_id, creation_time`,
            columnTemplate: '${logId}, ${requestId}, ${logType}, ${logContext}',
            rows: [testLogObject]
        };

        uuidStub.onFirstCall().returns(testRequestId);
        uuidStub.onSecondCall().returns(testLogId);
        multiTableStub.resolves([
            [{ 'request_id': testRequestId, 'creation_time': testInsertionTime }],
            [{ 'log_id': testLogId, 'creation_time': testInsertionTime }]
        ]);

        const testInsertParams = {
            initiatedUserId: testIniatedUserId,
            targetUserId: testTargetUserId,
            requestedShareItems: ['ACTIVITY_LEVEL', 'ACTIVITY_COUNT', 'SAVE_VALUES', 'BALANCE'],
            targetContactDetails: {
                contactType: 'EMAIL',
                contactMethod: 'example@domain.com'
            }
        };

        const insertResult = await persistence.insertFriendRequest(testInsertParams);
        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal({ requestId: testRequestId, logId: testLogId });
        expect(multiTableStub).to.have.been.calledOnceWithExactly([testFriendQueryDef, testLogDef]);
    });

    it('Connects a user to a friends request', async () => {
        const testRequestCode = 'ANCIENT COFFEE';
        const updateQuery = `update ${friendReqTable} set target_user_id = $1, request_code = null where request_code = $2 ` +
            `returning request_id, updated_time`;
        const updateValues = [testTargetUserId, testRequestCode];
        updateStub.withArgs(updateQuery, updateValues).resolves({ rows: [{ 'request_id': testRequestId, 'updated_time': testUpdatedTime }]});

        const connectionResult = await persistence.connectUserToFriendRequest(testTargetUserId, testRequestCode);
        expect(connectionResult).to.exist;
        expect(connectionResult).to.deep.equal([{ requestId: testRequestId, updatedTime: testUpdatedTime }]);
    });

    it('Inserts friendship properly', async () => {
        const friendReqUpdateDef = {
            table: friendshipTable,
            key: { requestId: testRequestId },
            value: { requestStatus: 'ACCEPTED' },
            returnClause: 'updated_time'
        };

        const friendshipObject = {
            relationshipId: testRelationshipId,
            initiatedUserId: testIniatedUserId,
            acceptedUserId: testAcceptedUserId,
            relationshipStatus: 'ACTIVE',
            shareItems: ['ACTIVITY_LEVEL']
        };

        const testFriendQueryDef = {
            query: `insert into ${friendshipTable} (relationship_id, initiated_user_id, accepted_user_id, ` +
               `relationship_status, share_items) values %L returning relationship_id, creation_time`,
            columnTemplate: '${relationshipId}, ${initiatedUserId}, ${acceptedUserId}, ${relationshipStatus}, ${shareItems}',      
            rows: [friendshipObject]
        };

        const testLogObject = {
            logId: testLogId,
            relationshipId: testRelationshipId,
            logType: 'FRIENDSHIP_ACCEPTED',
            logContext: friendshipObject
        };

        const testLogDef = {
            query: `insert into ${friendLogTable} (log_id, relationship_id, log_type, log_context) values %L returning log_id, creation_time`,
            columnTemplate: '${logId}, ${relationshipId}, ${logType}, ${logContext}',
            rows: [testLogObject]
        };

        uuidStub.onFirstCall().returns(testRelationshipId);
        uuidStub.onSecondCall().returns(testLogId);
        multiOpStub.withArgs([friendReqUpdateDef], [testFriendQueryDef, testLogDef]).resolves([
            [{ 'updated_time': testUpdatedTime }],
            [{ 'relationship_id': testRelationshipId, 'creation_time': testInsertionTime }, { 'log_id': testLogId, 'creation_time': testInsertionTime }]
        ]);

        const insertResult = await persistence.insertFriendship(testRequestId, testIniatedUserId, testAcceptedUserId, ['ACTIVITY_LEVEL']);
        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal({
            updatedTime: testUpdatedTime,
            relationshipId: testRelationshipId,
            logId: testLogId
        });
    });

    it('Deactivates friendship', async () => {
        const testUpdateFriendshipDef = {
            table: friendshipTable,
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
            query: `insert into ${friendLogTable} (log_id, relationship_id, log_type, log_context) values %L returning log_id, creation_time`,
            columnTemplate: '${logId}, ${relationshipId}, ${logType}, ${logContext}',
            rows: [testLogObject]
        };

        uuidStub.returns(testLogId);
        multiOpStub.resolves([
            [{ 'updated_time': testUpdatedTime }],
            [{ 'log_id': testLogId, 'creation_time': testInsertionTime }]
        ]);
        
        const updateResult = await persistence.deactivateFriendship(testRelationshipId);
        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal({ updatedTime: testUpdatedTime, logId: testLogId });
        expect(multiOpStub).to.have.been.calledOnceWithExactly([testUpdateFriendshipDef], [testInsertLogDef]);
    });

    it('Ignores friendship request properly', async () => {
        const updateFriendReqDef = {
            table: friendReqTable,
            key: {
                targetUserId: testTargetUserId,
                initiatedUserId: testIniatedUserId
            },
            value: { requestStatus: 'IGNORED' },
            returnClause: 'updated_time'
        };

        const testLogObject = {
            logId: testLogId,
            requestId: testRequestId,
            logType: 'FRIENDSHIP_IGNORED',
            logContext: {
                targetUserId: testTargetUserId,
                initiatedUserId: testIniatedUserId
            }
        };

        const testInsertLogDef = {
            query: `insert into ${friendLogTable} (log_id, request_id, log_type, log_context) values %L returning log_id, creation_time`,
            columnTemplate: '${logId}, ${requestId}, ${logType}, ${logContext}',
            rows: [testLogObject]
        };

        const selectQuery = `select request_id from ${friendReqTable} where target_user_id = $1 and initiated_user_id = $2`;
        const queryValues = [testTargetUserId, testIniatedUserId];

        uuidStub.returns(testLogId);
        queryStub.withArgs(selectQuery, queryValues).resolves([{ 'request_id': testRequestId }]);
        multiOpStub.withArgs([updateFriendReqDef], [testInsertLogDef]).resolves([
            [{ 'updated_time': testUpdatedTime }],
            [{ 'log_id': testLogId, 'creation_time': testInsertionTime }]
        ]);
        
        const resultOfIgnore = await persistence.ignoreFriendshipRequest(testTargetUserId, testIniatedUserId);
        expect(resultOfIgnore).to.exist;
        expect(resultOfIgnore).to.deep.equal({ updatedTime: testUpdatedTime, logId: testLogId });
        expect(queryStub).to.have.been.calledOnceWithExactly(selectQuery, queryValues);
        expect(multiOpStub).to.have.been.calledOnceWithExactly([updateFriendReqDef], [testInsertLogDef]);
    });

});
