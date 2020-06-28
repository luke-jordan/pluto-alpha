'use strict';

const chai = require('chai');
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const { expect } = chai;

const helper = require('./message.test.helper');

const fetchPrefStub = sinon.stub();
const insertPrefStub = sinon.stub();
const updatePrefStub = sinon.stub();

const proxyquire = require('proxyquire');

const handler = proxyquire('../message-prefs-handler', {
    './persistence/rds.pushsettings.js': {
        'fetchUserPushPreferences': fetchPrefStub,
        'insertUserMsgPreference': insertPrefStub,
        'updateUserMsgPreference': updatePrefStub,
        '@noCallThru': true
    }
});

describe('*** UNIT TEST SETTING USER TO NO MSGS ***', async () => {

    beforeEach(() => helper.resetStubs(fetchPrefStub, insertPrefStub, updatePrefStub));

    it('Set user preference to no push messages, no prior prefs', async () => {

    });

    it('Set user preference to receive push messages, prior pref in place', async () => {

    });

    it('Rejects unauthorized access', async () => {

    });

});
