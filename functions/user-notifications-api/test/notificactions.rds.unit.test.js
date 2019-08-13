'use strict';

const logger = require('debug')('jupiter:user-notifications:rds-test');
const uuid = require('uuid/v4');
const config = require('config');

const sinon = require('sinon');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;
const proxyquire = require('proxyquire');

const insertRecordsStub = sinon.stub();
const updateRecordStub = sinon.stub();
const selectQueryStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.insertRecords = insertRecordsStub;
        this.updateRecord = updateRecordStub;
        this.selectQuery = selectQueryStub;
    }
}

const rdsUtil = proxyquire('../persistence/rds.notifications', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});


const resetStubs = () => {
    insertRecordsStub.reset();
    updateRecordStub.reset();
    selectQueryStub.reset();
};


describe('*** UNIT TESTING MESSAGGE INSTRUCTION RDS UTIL ***', () => {
    const mockInstructionId = uuid();
    const mockBoostId = uuid();

    const createPersistableInstruction = (instructionId) => ({
        instructionId: instructionId,
        presentationType: 'ONCE_OFF',
        active: true,
        audienceType: 'ALL_USERS',
        templates: {
            default: config.get('instruction.templates.default'),
            otherTemplates: null
        },
        selectionInstruction: null,
        recurrenceInstruction: null,
        responseAction: 'VIEW_HISTORY',
        responseContext: { boostId: mockBoostId },
        startTime: '2050-09-01T11:47:41.596Z',
        endTime: '2061-01-09T11:47:41.596Z',
        priority: 0
    });

    // legacy implementation tests whether new implementation achieved same result.
    const insertionQueryArray = [
        'instruction_id',
        'presentation_type',
        'active',
        'audience_type',
        'templates',
        'selection_instruction',
        'recurrence_instruction',
        'response_action',
        'response_context',
        'start_time',
        'end_time',
        'priority' 
    ];

    const mockInsertRecordsArgs = [
        `insert into ${config.get('tables.messageInstructionTable')} (${insertionQueryArray.join(', ')}) values %L returning insertion_id, creation_time`,
        '${instructionId}, ${presentationType}, ${active}, ${audienceType}, ${templates}, ${selectionInstruction}, ${recurrenceInstruction}, ${responseAction}, ${responseContext}, ${startTime}, ${endTime}, ${priority}',
        [createPersistableInstruction(mockInstructionId)]
    ];

    const mockUpdateRecordArgs = (instructionId) => [
        `update ${config.get('tables.messageInstructionTable')} set $1 = $2 where instruction_id = $3 returning insertion_id, update_time`,
        ['active', false, instructionId]
    ];
    
    const mockSelectQueryArgs = (instructionId) => [
        `select * from ${config.get('tables.messageInstructionTable')} where instruction_id = $1`,
        [instructionId]
    ];

    beforeEach(() => {
        resetStubs();
    });

    it('should insert message instruction', async () => {
        const mockPersistableInstruction = createPersistableInstruction(mockInstructionId);
        insertRecordsStub.withArgs(...mockInsertRecordsArgs).returns({ rows: [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ] });
        const expectedResult = [ { insertion_id: 111, creation_time: '2049-06-22T07:38:30.016Z' } ];

        const result = await rdsUtil.insertMessageInstruction(mockPersistableInstruction);
        logger('Result of message instruction insertion:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(insertRecordsStub).to.have.been.calledOnceWithExactly(...mockInsertRecordsArgs);        
    });

    it('should get message instruction', async () => {
        selectQueryStub.withArgs(...mockSelectQueryArgs(mockInstructionId)).returns([createPersistableInstruction(mockInstructionId)]);
        const expectedResult = createPersistableInstruction(mockInstructionId);

        const result = await rdsUtil.getMessageInstruction(mockInstructionId);
        logger('Result of instruction extraction from db:', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(selectQueryStub).to.have.been.calledOnceWithExactly(...mockSelectQueryArgs(mockInstructionId));
    });

    it('should update message instruction', async () => {
        updateRecordStub.withArgs(...mockUpdateRecordArgs(mockInstructionId)).returns({ rows: [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ] });
        const expectedResult = [ { insertion_id: 111, update_time: '2049-06-22T07:38:30.016Z' } ];

        const result = await rdsUtil.updateMessageInstruction(mockInstructionId, 'active', false);
        logger('Result of message instruction update (deactivation):', result);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);
        expect(updateRecordStub).to.have.been.calledOnceWithExactly(...mockUpdateRecordArgs(mockInstructionId));
    });
});
