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
const updateStub = sinon.stub();
const uuidStub = sinon.stub();


class MockRdsConnection {
    constructor () {
        this.insertRecords = insertStub;
        this.updateRecord = updateStub;
    }
}

const persistence = proxyquire('../persistence/write.friends', {
    'rds-common': MockRdsConnection,
    'uuid/v4': uuidStub    
});


describe('*** UNIT TEST HANDLE PROFILE PERSISTENCE FUNCTIONS ***', async () => {
    const friendTable = config.get('tables.friendTable');
    const friendRequestTable = config.get('tables.friendRequestTable');

    const testIniatedUserId = uuid();
    const testTargetUserId = uuid();
    const testAcceptedUserId = uuid();
    const testRequestId = uuid();
    const testRelationshipId = uuid();

    beforeEach(() => {
        helper.resetStubs(insertStub, updateStub, uuidStub);
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

    it('Inserts friendship properly', async () => {
        const insertQuery = `insert into ${friendTable} (relationship_id, initiated_user_id, accepted_user_id, relationship_status) ` +
            `values %L returning relationship_id`;
        const columnTemplate = '${relationshipId}, ${initiatedUserId}, ${acceptedUserId}, ${relationshipStatus}';
        const friendshipObject = {
            relationshipId: testRelationshipId,
            initiatedUserId: testIniatedUserId,
            acceptedUserId: testAcceptedUserId,
            relationshipStatus: 'ACTIVE'
        };

        uuidStub.returns(testRelationshipId);
        insertStub.withArgs(insertQuery, columnTemplate, [friendshipObject]).resolves({ rows: [{ 'relationship_id': testRelationshipId }] });

        const insertResult = await persistence.insertFriendship(testIniatedUserId, testAcceptedUserId);
        expect(insertResult).to.exist;
        expect(insertResult).to.deep.equal({ relationshipId: testRelationshipId });
        expect(insertStub).to.have.been.calledOnceWithExactly(insertQuery, columnTemplate, [friendshipObject]);
    });

    it('Deactivates friendship', async () => {
        const updateQuery = `update ${friendTable} set relationship_status = $1 where relationship_id = $2 returning relationship_id`;
        const updateValues = ['DEACTIVATED', testRelationshipId];

        updateStub.withArgs(updateQuery, updateValues).resolves({ rows: [{ 'relationship_id': testRelationshipId }] });

        const updateResult = await persistence.deactivateFriendship(testRelationshipId);
        expect(updateResult).to.exist;
        expect(updateResult).to.deep.equal({ relationshipId: testRelationshipId });
        expect(updateStub).to.have.been.calledOnceWithExactly(updateQuery, ['DEACTIVATED', testRelationshipId]);
    });

});
