'use strict';

// const logger = require('debug')('jupiter:friends:test');
const config = require('config');
const uuid = require('uuid/v4');

const helper = require('./test-helper');

const sinon = require('sinon');
const chai = require('chai');
const sinonChai = require('sinon-chai');
chai.use(sinonChai);
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);
const expect = chai.expect;

const proxyquire = require('proxyquire').noCallThru();

const insertStub = sinon.stub();
const uuidStub = sinon.stub();


class MockRdsConnection {
    constructor () {
        this.insertRecords = insertStub;
    }
}

const persistence = proxyquire('../persistence/handle-profiles', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub    
});


describe('*** UNIT TEST HANDLE PROFILE PERSISTENCE FUNCTIONS ***', async () => {
    const friendsTable = config.get('tables.friendsTable');
    const friendRequestTable = config.get('tables.friendRequestTable');

    const testIniatedUserId = uuid();
    const testTargetUserId = uuid();
    const testAcceptedUserId = uuid();
    const testRequestId = uuid();
    const testRelationshipId = uuid();

    beforeEach(() => {
        helper.resetStubs(insertStub, uuidStub);
    });

    it('Inserts friend request, filters out extra params', async () => {
        const insertQuery = `insert into ${friendRequestTable} (request_id, initiated_user_id, target_user_id) values %L returning request_id`;
        const columnTemplate = '${requestId}, ${initiatedUserId}, ${targetUserId}';
        const queryObject = { requestId: testRequestId, initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId };

        uuidStub.returns(testRequestId);
        insertStub.withArgs(insertQuery, columnTemplate, [queryObject]).resolves({ rows: [{ 'request_id': testRequestId }] });

        const testInsertParams = { initiatedUserId: testIniatedUserId, targetUserId: testTargetUserId, extra: 'param' };
        const insertResult = await persistence.insertFriendRequest(testInsertParams);

        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal({ requestId: testRequestId });
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, columnTemplate, [queryObject]);
    });

    it('Inserts friendship properrly', async () => {
        const insertQuery = `insert into ${friendsTable} (relationship_id, initiated_user_id, accepted_user_id) values %L returning relationship_id`;
        const columnTemplate = '${relationshipId}, ${initiatedUserId}, ${acceptedUserId}';
        const friendshipObject = { relationshipId: testRelationshipId, initiatedUserId: testIniatedUserId, acceptedUserId: testAcceptedUserId };

        uuidStub.returns(testRelationshipId);
        insertStub.resolves({ rows: [{ 'relationship_id': testRelationshipId }] });

        const insertResult = await persistence.insertFriendship(testIniatedUserId, testAcceptedUserId);
        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal({ relationshipId: testRelationshipId });
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, columnTemplate, [friendshipObject]);
    });

});
