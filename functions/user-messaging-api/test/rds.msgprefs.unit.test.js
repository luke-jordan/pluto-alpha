'use strict';

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const { expect } = chai;

const helper = require('./message.test.helper');
const moment = require('moment');

const rdsGetStub = sinon.stub();
const rdsInsertStub = sinon.stub();
const rdsUpdateStub = sinon.stub();

class MockRdsConnection {
    constructor () {
        this.selectQuery = rdsGetStub;
        this.insertRecords = rdsInsertStub;
        this.updateRecordObject = rdsUpdateStub;
    }
}

const proxyquire = require('proxyquire').noCallThru();

const rdsPreferences = proxyquire('../persistence/rds.pushsettings.js', {
    'rds-common': MockRdsConnection,
    '@noCallThru': true
});

describe('*** UNIT TEST MSG PREFS WRITE ***', async () => {

    beforeEach(() => helper.resetStubs(rdsGetStub, rdsInsertStub, rdsUpdateStub));

    it('Inserts user messaging preferences', async () => {
        const mockCreationTime = moment();
        const mockPrefs = { haltPushMessages: true };

        const expectedQuery = 'insert into message_data.user_message_preference (system_wide_user_id, halt_push_messages) values %L returning creation_time';
        const expectedColumns = '${systemWideUserId}, ${haltPushMessages}';

        rdsInsertStub.resolves({ rows: [{ 'creation_time': mockCreationTime.format() }]});

        const prefsInsertResult = await rdsPreferences.insertUserMsgPreference('user-id-1', mockPrefs);
        expect(prefsInsertResult).to.deep.equal({ insertionTime: moment(mockCreationTime.format()) });

        const expectedRecord = { systemWideUserId: 'user-id-1', haltPushMessages: true };
        expect(rdsInsertStub).to.have.been.calledOnceWithExactly(expectedQuery, expectedColumns, [expectedRecord]);
    });

    it('Updates user messaging preferences', async () => {
        const mockUpdateTime = moment();
        const expectedDef = {
            table: 'message_data.user_message_preference',
            key: { systemWideUserId: 'user-id-1' },
            value: { haltPushMessages: false },
            returnClause: 'updated_time'
        };

        rdsUpdateStub.resolves([{ 'updated_time': mockUpdateTime.format() }]);
        
        const updatePrefsResult = await rdsPreferences.updateUserMsgPreference('user-id-1', { haltPushMessages: false });
        expect(updatePrefsResult).to.deep.equal({ updatedTime: moment(mockUpdateTime.format()) });

        expect(rdsUpdateStub).to.have.been.calledOnceWithExactly(expectedDef);
    });

});

describe('*** UNIT TEST MSG PREFS RETRIEVE ***', async () => {

    beforeEach(() => helper.resetStubs(rdsGetStub));

    it('Fetches list of users with preference to do no messages', async () => {
        const expectedQuery = 'select system_wide_user_id from message_data.user_message_preference where ' +
            'system_wide_user_id in ($1, $2) and halt_push_messages = true';
        
        rdsGetStub.resolves([{ 'system_wide_user_id': 'user-1' }]);
        const fetchedUsers = await rdsPreferences.findNoPushUsers(['user-1', 'user-2']);

        expect(fetchedUsers).to.deep.equal(['user-1']);
        expect(rdsGetStub).to.have.been.calledOnceWithExactly(expectedQuery, ['user-1', 'user-2']);
    });

    it('Fetches preference for specific user, exists', async () => {
        const expectedQuery = 'select * from message_data.user_message_preference where system_wide_user_id = $1';

        rdsGetStub.resolves([{ 'system_wide_user_id': 'user-3', 'halt_push_messages': true }]);

        const fetchedPrefs = await rdsPreferences.fetchUserMsgPrefs('user-3');
        expect(fetchedPrefs).to.deep.equal({ systemWideUserId: 'user-3', haltPushMessages: true });

        expect(rdsGetStub).to.have.been.calledOnceWithExactly(expectedQuery, ['user-3']);
    });

    it('Returns false on no preference for user', async () => {
        const expectedQuery = 'select * from message_data.user_message_preference where system_wide_user_id = $1';
        rdsGetStub.resolves([]);

        const fetchedPrefs = await rdsPreferences.fetchUserMsgPrefs('user-4');
        expect(fetchedPrefs).to.deep.equal(null);

        expect(rdsGetStub).to.have.been.calledOnceWithExactly(expectedQuery, ['user-4']);
    });
    
});
