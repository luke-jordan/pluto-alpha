'use strict';

const moment = require('moment');
const uuid = require('uuid/v4');

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const { expect } = chai;

const helper = require('./message.test.helper');

const fetchPrefStub = sinon.stub();
const insertPrefStub = sinon.stub();
const updatePrefStub = sinon.stub();

const publishEventStub = sinon.stub();

const proxyquire = require('proxyquire');

const handler = proxyquire('../message-prefs-handler', {
    './persistence/rds.pushsettings.js': {
        'fetchUserPushPreferences': fetchPrefStub,
        'insertUserMsgPreference': insertPrefStub,
        'updateUserMsgPreference': updatePrefStub,
        '@noCallThru': true
    },
    'publish-common': {
        'publishUserEvent': publishEventStub,
        '@noCallThrue': true
    }
});

const mockAdminId = uuid();
const mockUserId = uuid();

describe('*** UNIT TEST SETTING USER TO NO MSGS ***', async () => {

    beforeEach(() => helper.resetStubs(fetchPrefStub, insertPrefStub, updatePrefStub, publishEventStub));

    it('Set user preference to no push messages, no prior prefs', async () => {
        const testBody = { systemWideUserId: mockUserId, haltPushMessages: true };
        const testEvent = helper.wrapEvent(testBody, mockAdminId, 'SYSTEM_ADMIN');

        fetchPrefStub.resolves(null);
        insertPrefStub.resolves({ insertionTime: moment() });

        const resultOfSetting = await handler.setUserMessageBlock(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfSetting);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });

        expect(fetchPrefStub).to.have.been.calledOnceWithExactly(mockUserId);
        expect(insertPrefStub).to.have.been.calledOnceWithExactly(mockUserId, { haltPushMessages: true });
        expect(updatePrefStub).to.not.have.been.called;
        
        expect(publishEventStub).to.have.been.calledOnce;
        expect(publishEventStub).to.have.been.calledOnceWithExactly(mockUserId, 'MESSAGE_BLOCK_SET', {
            initiator: mockAdminId,
            context: { newPreferences: { haltPushMessages: true }}
        });
    });

    it('Set user preference to receive push messages, prior pref in place', async () => {
        const testBody = { systemWideUserId: mockUserId, haltPushMessages: false };
        const testEvent = helper.wrapEvent(testBody, mockAdminId, 'SYSTEM_ADMIN');

        fetchPrefStub.resolves({ systemWideUserId: mockUserId, haltPushMessages: true });
        updatePrefStub.resolves({ insertionTime: moment() });

        const resultOfSetting = await handler.setUserMessageBlock(testEvent);
        const resultBody = helper.standardOkayChecks(resultOfSetting);
        expect(resultBody).to.deep.equal({ result: 'SUCCESS' });

        expect(fetchPrefStub).to.have.been.calledOnceWithExactly(mockUserId);
        expect(updatePrefStub).to.have.been.calledOnceWithExactly(mockUserId, { haltPushMessages: false });
        expect(insertPrefStub).to.not.have.been.called;
        
        expect(publishEventStub).to.have.been.calledOnce;

        const expectedLogContext = { 
            newPreferences: { haltPushMessages: false },
            priorPreferences: { haltPushMessages: true }
        };
        expect(publishEventStub).to.have.been.calledOnceWithExactly(mockUserId, 'MESSAGE_BLOCK_UPDATED', {
            initiator: mockAdminId,
            context: expectedLogContext
        });
    });

    it('Rejects unauthorized access', async () => {
        const testBody = { systemWideUserId: mockUserId, haltPushMessages: true };
        const testEvent = helper.wrapEvent(testBody, mockAdminId, 'ORDINARY_USER');

        const resultOfAttempt = await handler.setUserMessageBlock(testEvent);
        expect(resultOfAttempt).to.deep.equal({ statusCode: 403 });

    });

});
