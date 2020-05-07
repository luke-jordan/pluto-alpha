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

const simpleInsertStub = sinon.stub();
const multiTableStub = sinon.stub();
const multiOpStub = sinon.stub();
const updateStub = sinon.stub();
const queryStub = sinon.stub();
const uuidStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = simpleInsertStub;
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
        helper.resetStubs(simpleInsertStub, multiTableStub, multiOpStub, updateStub, queryStub, uuidStub);
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

        queryStub.resolves([{ 'user_id': testIniatedUserId }]);
        simpleInsertStub.resolves([{ 'creation_time': moment().format() }]);

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

        expect(queryStub).to.have.been.calledOnceWithExactly('select user_id from friend_data.user_reference_table where user_id in ($1, $2)', [testIniatedUserId, testTargetUserId]);
        expect(simpleInsertStub).to.have.been.calledOnce;
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
            table: friendReqTable,
            key: { requestId: testRequestId },
            value: { requestStatus: 'ACCEPTED', referenceFriendshipId: testRelationshipId },
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
            logType: 'FRIENDSHIP_ACCEPTED',
            logContext: friendshipObject,
            relationshipId: testRelationshipId,
            requestId: testRequestId
        };

        const testLogDef = {
            query: `insert into ${friendLogTable} (log_id, log_type, log_context, request_id, relationship_id) values %L returning log_id, creation_time`,
            columnTemplate: '${logId}, ${logType}, ${logContext}, ${requestId}, ${relationshipId}',
            rows: [testLogObject]
        };

        const selectQuery = `select relationship_id from ${friendshipTable} where initiated_user_id = $1 and accepted_uer_id = $2`;

        uuidStub.onFirstCall().returns(testRelationshipId);
        uuidStub.onSecondCall().returns(testLogId);

        queryStub.resolves([]);

        simpleInsertStub.resolves([{ 'relationship_id': testRelationshipId, 'creation_time': testInsertionTime }]);
        multiOpStub.resolves([
            [{ 'updated_time': testUpdatedTime }],
            [{ 'log_id': testLogId, 'creation_time': testInsertionTime }]
        ]);

        const insertResult = await persistence.insertFriendship(testRequestId, testIniatedUserId, testAcceptedUserId, ['ACTIVITY_LEVEL']);
        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal({ relationshipId: testRelationshipId, logId: testLogId });

        // *not* to be a general pattern, but using here as complex set of args and failures should be easily traceable
        expect(simpleInsertStub).to.have.been.calledOnce;
        expect(simpleInsertStub).to.have.been.calledWith(testFriendQueryDef.query, testFriendQueryDef.columnTemplate, testFriendQueryDef.rows);
        
        expect(multiOpStub).to.have.been.calledOnce;
        const multiOpArgs = multiOpStub.getCall(0).args;
        expect(multiOpArgs[0][0]).to.deep.equal(friendReqUpdateDef);
        expect(multiOpArgs[1][0]).to.deep.equal(testLogDef);
        
        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testIniatedUserId, testAcceptedUserId]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testAcceptedUserId, testIniatedUserId]);
    });

    it('Reactivates a friendship properly', async () => {
        const friendshipUpdateDef = {
            table: friendshipTable,
            key: { relationshipId: testRelationshipId },
            value: { relationshipStatus: 'ACTIVE' },
            returnClause: 'updated_time'
        };

        const friendReqUpdateDef = {
            table: friendReqTable,
            key: { requestId: testRequestId },
            value: { requestStatus: 'ACCEPTED', referenceFriendshipId: testRelationshipId },
            returnClause: 'updated_time'
        };

        const friendshipObject = {
            relationshipId: testRelationshipId,
            initiatedUserId: testIniatedUserId,
            acceptedUserId: testAcceptedUserId,
            relationshipStatus: 'ACTIVE',
            shareItems: ['ACTIVITY_LEVEL']
        };

        const testLogObject = {
            logId: testLogId,
            relationshipId: testRelationshipId,
            requestId: testRequestId,
            logType: 'FRIENDSHIP_ACCEPTED',
            logContext: friendshipObject
        };

        const testLogDef = {
            query: `insert into ${friendLogTable} (log_id, log_type, log_context, request_id, relationship_id) values %L returning log_id, creation_time`,
            columnTemplate: '${logId}, ${logType}, ${logContext}, ${requestId}, ${relationshipId}',
            rows: [testLogObject]
        };

        const selectQuery = `select relationship_id from ${friendshipTable} where initiated_user_id = $1 and accepted_uer_id = $2`;

        uuidStub.onFirstCall().returns(testRelationshipId);
        uuidStub.onSecondCall().returns(testLogId);

        queryStub.onFirstCall().resolves([{ 'relationship_id': testRelationshipId }]);
        queryStub.onSecondCall().resolves([]);
        
        const updateResults = [
            [{ 'updated_time': testUpdatedTime }],
            [{ 'relationship_id': testRelationshipId, 'creation_time': testInsertionTime }]
        ];
        const insertResults = [{ 'log_id': testLogId, 'creation_time': testInsertionTime }];
        multiOpStub.resolves([updateResults, insertResults]);

        const insertResult = await persistence.insertFriendship(testRequestId, testIniatedUserId, testAcceptedUserId, ['ACTIVITY_LEVEL']);
        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal({ relationshipId: testRelationshipId, logId: testLogId });

        expect(multiOpStub).to.have.been.calledOnce;
        const multiOpArgs = multiOpStub.getCall(0).args;
        expect(multiOpArgs[0][0]).to.deep.equal(friendshipUpdateDef);
        expect(multiOpArgs[0][1]).to.deep.equal(friendReqUpdateDef);
        expect(multiOpArgs[1][0]).to.deep.equal(testLogDef);
        expect(queryStub).to.have.been.calledTwice;
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testIniatedUserId, testAcceptedUserId]);
        expect(queryStub).to.have.been.calledWithExactly(selectQuery, [testAcceptedUserId, testIniatedUserId]);
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
            key: { requestId: testRequestId },
            value: { requestStatus: 'IGNORED' },
            returnClause: 'updated_time'
        };

        const testLogObject = {
            logId: testLogId,
            requestId: testRequestId,
            logType: 'FRIENDSHIP_IGNORED',
            logContext: {
                instructedByUserId: testTargetUserId
            }
        };

        const testInsertLogDef = {
            query: `insert into ${friendLogTable} (log_id, log_type, log_context, request_id) values %L returning log_id, creation_time`,
            columnTemplate: '${logId}, ${logType}, ${logContext}, ${requestId}',
            rows: [testLogObject]
        };

        uuidStub.returns(testLogId);
        multiOpStub.resolves([
            [{ 'updated_time': testUpdatedTime }],
            [{ 'log_id': testLogId, 'creation_time': testInsertionTime }]
        ]);
        
        const resultOfIgnore = await persistence.ignoreFriendshipRequest(testRequestId, testTargetUserId);

        expect(resultOfIgnore).to.exist;
        expect(resultOfIgnore).to.deep.equal({ updatedTime: testUpdatedTime, logId: testLogId });
        
        expect(multiOpStub).to.have.been.calledOnceWithExactly([updateFriendReqDef], [testInsertLogDef]);
    });

});
